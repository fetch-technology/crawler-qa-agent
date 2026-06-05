// Case executor — runs a single AI-catalog case end-to-end:
//   1. Execute translated actions (click bet -/+, spin, etc.)
//   2. Capture the resulting spin response from network
//   3. Parse → NormalizedSpinResult
//   4. Evaluate that case's custom_assertions against the spin
//   5. Return per-case result with status + per-assertion breakdown

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { UiRegistry } from "../registry/types.js";
import type { CaseAction } from "../step7-testcase-gen/case-action-translator.js";
import { dirForGame } from "../registry/paths.js";
import { detectAnyPopup, dismissPopupsLoop, ocrRegion, parseNumericFromOcr } from "../utils/ocr-popup.js";
import { createDedupState, ingestFrame } from "./cascade-dedup.js";
import {
  getRoundEndSpins as getRoundEndSpinsImpl,
  getCurrentBalance as getCurrentBalanceImpl,
  detectBuyFeatureDeduction as detectBuyFeatureDeductionImpl,
  sumWinBreakdown as sumWinBreakdownImpl,
  payoutModelCheck as payoutModelCheckImpl,
} from "./assertion-helpers.js";
import { detectAssertionSignals, signalsFromRefs } from "./assertion-signals.js";
import { detectUiOnlyCase, isOpenUiKey } from "./ui-case-detect.js";
import { calcConfidence, buildSignalEvidence } from "./evidence/confidence.js";
import { adaptSpinForAssertions } from "../step6-build-model/spin-adapter.js";
import { CaseVideoRecorder } from "./case-video-recorder.js";
import { resolveTimingConfig } from "../registry/timing-config.js";
import { resolveBetControls } from "../registry/bet-controls.js";
import { resolvePopupKeywords } from "../registry/popup-keywords.js";
import { evaluateBalanceMultiSignal } from "./evidence/balance-multi-signal.js";
import { ocrRegions } from "../registry/ocr-regions.js";
import { verifyHistory, type HistoryVerifyResult } from "../step9-verify/history-verifier.js";

// Per-process guard for UNKNOWN learner to avoid repeated AI calls across
// consecutive cases that land on the same transient end-state screen.
const unknownLearnSeenAt = new Map<string, number>();
let unknownLearnAttemptCount = 0;

function buildUnknownLearnFingerprint(ocrText: string): string {
  const norm = (ocrText ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return norm.length > 0 ? norm.slice(0, 200) : "__empty__";
}

function shouldRunUnknownLearner(ocrText: string): { run: boolean; reason?: string; key: string } {
  const maxCalls = Number(process.env.QA_UNKNOWN_LEARN_MAX_CALLS ?? 3);
  const cooldownMs = Number(process.env.QA_UNKNOWN_LEARN_COOLDOWN_MS ?? 120_000);
  const key = buildUnknownLearnFingerprint(ocrText);
  const now = Date.now();

  if (Number.isFinite(maxCalls) && maxCalls >= 0 && unknownLearnAttemptCount >= maxCalls) {
    return { run: false, reason: `budget exhausted (${unknownLearnAttemptCount}/${maxCalls})`, key };
  }

  const lastAt = unknownLearnSeenAt.get(key);
  if (
    Number.isFinite(cooldownMs)
    && cooldownMs > 0
    && typeof lastAt === "number"
    && (now - lastAt) < cooldownMs
  ) {
    return { run: false, reason: `duplicate UNKNOWN fingerprint within cooldown (${now - lastAt}ms < ${cooldownMs}ms)`, key };
  }

  return { run: true, key };
}

/**
 * Capture the current page state as PNG and save under
 * fixtures/registry/<slug>/case-failures/<caseId>.png. Returns the relative
 * path (or null on error / when gameSlug not provided).
 *
 * Captured for EVERY case (pass + fail + skip) since 2026-05-25 evidence-pkg
 * update. Files written to fixtures/registry/<slug>/case-evidence/<caseId>.png.
 * Old fixtures/registry/<slug>/case-failures/ path still works for serving
 * legacy artifacts (back-compat handled in server route).
 */
async function captureCaseScreenshot(
  page: Page,
  gameSlug: string | undefined,
  caseId: string,
): Promise<string | null> {
  if (!gameSlug) return null;
  try {
    const dir = path.join(dirForGame(gameSlug), "case-evidence");
    await mkdir(dir, { recursive: true });
    const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const file = path.join(dir, `${safeName}.png`);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    await writeFile(file, buf);
    return path.relative(process.cwd(), file);
  } catch (err) {
    console.warn(`[case-executor] screenshot capture failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export type AssertionResult = {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
  // Phase 8 — multi-signal confidence (optional; legacy assertions omit)
  outcome?: import("./evidence/index.js").Outcome;
  confidence?: number;
  signals?: import("./evidence/index.js").SignalEvidence[];
};

/** Per-region OCR capture saved for QA review. Persists what Tesseract
 *  actually read at end-of-case so QA can spot silent OCR failures or
 *  garbled readings without re-running the case. */
export type OcrSnapshot = {
  /** Which screen widget: "balance" / "bet" / "win". */
  region: "balance" | "bet" | "last_win" | "free_spin_counter";
  /** Region bbox at the time of OCR (helps debug if bbox needs redraw). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Raw OCR text from Tesseract (first 200 chars). */
  text: string;
  /** Number parsed from text via parseNumericFromOcr — null when parse failed. */
  parsed: number | null;
  durationMs: number;
  /** Path (relative to repo root) to the PNG crop of the bbox at OCR time.
   *  Dashboard renders this inline alongside the text so QA can visually
   *  verify what Tesseract was looking at — critical for debugging "parse
   *  failed" cases where the bbox was covered by an animation or
   *  PLACE-YOUR-BETS prompt. */
  bboxScreenshotPath?: string;
};

/** Per-action telemetry: what kind of action, what target, duration, success.
 *  Lets QA see at a glance which click took 5s or which click failed. */
export type ActionLogEntry = {
  /** "click" / "wait" / "spin" / "dismiss" / "set_bet_to_min" / ... */
  kind: string;
  /** uiKey for clicks, ms for waits, etc. */
  target?: string;
  durationMs: number;
  /** Did the action complete without throwing? */
  success: boolean;
  /** If !success, brief reason; if success but had a notable side-effect
   *  (interrupt handled, popup auto-dismissed), brief note. */
  note?: string;
};

/** A single field-level check inside a signal: what was expected, what was
 *  actually observed, and which source produced the observation. Used by
 *  the SignalRollup dashboard view so QA can see each comparison side-by-side
 *  ("API bet=0.5 vs UI bet=0.5 → ✓"). */
export type SignalCheck = {
  /** Short label of what's being verified (e.g. "bet", "balance", "win",
   *  "balance arithmetic", "no engine errors"). */
  field: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
  /** Where the actual value came from (parser/balanceAfter, ocr/balanceArea,
   *  warnings, stateTimeline, etc.). */
  source?: string;
  /** Free-form note when match=false (e.g. "OCR returned null"). */
  note?: string;
};

/** Case-level signal verdict — one per evidence dimension. Replaces the
 *  "5 signals decorating each business assertion" model with "5 case-level
 *  signals, each with concrete field checks". User feedback 2026-05-25:
 *  signals nested per assertion was confusing + redundant; flipping the
 *  matrix makes the primary view "is the UI consistent with the API?" etc.
 *
 *  Business-logic assertions (catalog-generated, AI) still run as before
 *  and remain in CaseResult.assertions for detailed drill-down. The signal
 *  roll-up is the new PRIMARY dashboard view. */
export type SignalRollup = {
  signal: "api" | "ui_ocr" | "network" | "state" | "rule";
  pass: boolean;
  /** Sub-checks contributing to this signal verdict. Empty when no data was
   *  available (e.g. ui_ocr with no ocr-regions configured) — then pass is
   *  true with detail="no-data" (silent no-op, not a failure). */
  checks: SignalCheck[];
  /** Top-line explanation: what the signal asserts + why it passed/failed. */
  detail?: string;
};

/** Per request+response pair captured during the case. Bodies are truncated
 *  to MAX_BODY_BYTES (8KB) to keep evidence files bounded. Persisted alongside
 *  the screenshot so QA can inspect server I/O without re-running. */
export type NetworkLogEntry = {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string;
  /** ISO timestamp when response landed. */
  at: string;
  /** True when parser accepted (and produced a spin); false when parser
   *  rejected (URL pattern OK but body didn't score as a spin); undefined
   *  when not yet evaluated. */
  parsedAsSpin?: boolean;
};

export type CaseResult = {
  caseId: string;
  name: string;
  category: string;
  severity: "critical" | "major" | "minor";
  status: "pass" | "fail" | "skip";
  skipReason?: string;
  actionsExecuted: number;
  assertions: AssertionResult[];
  /** Synthetic precheck / heuristic checks (id starts with `_`). Surface
   *  setup-state mismatches (e.g. "setup tried to set bet=7 but captured
   *  0.2") for QA root-cause hints. DOES NOT count toward pass/fail
   *  verdict — case `status` is computed from `assertions[]` only. Empty
   *  array when no precheck applied. */
  diagnostics?: AssertionResult[];
  /** Last (or only) spin captured. For multi-spin cases, see spinsCount. */
  spin: {
    bet: number;
    win: number;
    balanceBefore: number | null;
    balanceAfter: number;
    state: string;
    roundId: string;
  } | null;
  /** Total parseable spin responses captured during case (autoplay/cascade). */
  spinsCount?: number;
  /** EVERY spin captured this case (post-dedup), in order. Lets the dashboard
   *  render a full per-spin breakdown (bet / win / balance / drop) with NO cap,
   *  instead of only `spin` (last) + `spinsCount`. `win` is the post-dedup
   *  value (balance-derived on merged cascade rounds, parser win otherwise). */
  spins?: Array<{
    bet: number;
    win: number;
    balanceBefore: number | null;
    balanceAfter: number;
    state: string;
    roundId: string;
    isFreeSpin?: boolean;
  }>;
  durationMs: number;
  /** Path to a PNG snapshot taken at end of case. Captured for EVERY case
   *  (pass + fail + skip) so QA can verify visual state without re-running.
   *  Relative to repo root. */
  screenshotPath?: string;
  /** Path to an MP4 screen recording of the case. Present only when
   *  QA_RECORD_VIDEO=1 AND ffmpeg is in PATH. fps configured via
   *  QA_RECORD_VIDEO_FPS (default 5). */
  videoPath?: string;
  /** Per-region OCR snapshots taken at end of case. Always present (even when
   *  empty) so dashboard can render "OCR Evidence" panel consistently. */
  ocrSnapshots?: OcrSnapshot[];
  /** Sequential log of every action that ran (and its outcome). Helps QA
   *  debug "which click took 5s" or "which action failed silently". */
  actionLog?: ActionLogEntry[];
  /** Case-level signal roll-up — 5 evidence-dimension verdicts with field
   *  sub-checks. This is the PRIMARY dashboard view. Business assertions
   *  (in `assertions`) remain for detailed drill-down. */
  signalRollup?: SignalRollup[];
  /** Network capture log persisted to disk as a sibling of the screenshot.
   *  Path returned here so the server can serve it via API. Path is
   *  relative to repo root. */
  networkLogPath?: string;
  /** Compact inline summary of network captures so dashboard doesn't need to
   *  fetch the full JSONL just to render a count + first few rows. */
  networkSummary?: Array<{
    url: string;
    method: string;
    status: number;
    durationMs: number;
    parsedAsSpin?: boolean;
  }>;
  /** Parser diagnostic for the FIRST spin captured (or last if no spin). Shows
   *  exactly which formula was used + the field values, so QA can see at a
   *  glance when bet=0 comes from a wrong formula vs missing data. */
  parserDiagnostic?: {
    parserKind: string;
    /** Mechanic from game-mechanics.json — drives which formula the PP parser
     *  picks ("lines" uses request `l` directly; ways/cluster uses M). */
    mechanic?: string;
    betMultiplier?: number;
    /** Raw inputs read from request body (c, l, bl, etc.). */
    requestFields?: Record<string, string | number | null>;
    /** Formula label the parser decided to use ("c × M" / "c × bl" / "c × l" / "fallback 0"). */
    formulaUsed?: string;
    /** Bet the parser stamped on the spin. */
    parsedBet?: number;
    /** Bet that would be expected if game-mechanics betMultiplier was applied. */
    expectedBet?: number;
    /** True iff parsedBet differs from expectedBet by > 0.01. */
    mismatch?: boolean;
  };
  /** Non-fatal warnings collected during execution (e.g. popup-blocked spin
   *  retried, expected vs captured spin-count mismatch). QA can inspect to
   *  understand partial runs without auto-failing the case. */
  warnings?: string[];
  /** Phase 8.3 — state transition timeline (observe-act loop output). */
  stateTimeline?: Array<{ at: string; from?: string; to: string; via?: string }>;
  /** Phase 8 — 5-state outcome (PASS_HIGH / PASS_LOW / FAIL_HIGH / FAIL_LOW
   *  / INCONCLUSIVE / NEEDS_REVIEW / FLAKY). Derived from per-assertion
   *  confidence + history pattern. Dashboard uses this for color-coded UI. */
  outcome?: import("./evidence/index.js").Outcome;
  /** Phase 8 — aggregate confidence (min of per-assertion confidences). */
  confidence?: number;
  /** History popup reconciliation: opens in-game history, OCR rows, match
   *  against captured spins. Populated only when case category contains
   *  "history" (gate in case-executor). Mismatches array drives signal
   *  rollup (api signal for missing/field, network signal for extra). */
  historyVerification?: import("../step9-verify/history-verifier.js").HistoryVerifyResult & {
    /** Relative path (repo root) to the popup screenshot saved alongside case evidence. */
    screenshotPath?: string;
    /** Relative path to mismatches JSON dump. */
    mismatchesPath?: string;
  };
};

export type CaseExecutorContext = {
  page: Page;
  uiMap: UiRegistry;
  parser: BaseParser;
  /** Optional spin-API hint — preferred to detect the actual spin response. */
  spinApiUrlContains?: string | null;
  /**
   * Optional prior balance used to fill spin.balanceBefore when the spin
   * response itself doesn't expose startingBalance (common for PP). Sourced
   * from doInit or last seen balance. Eliminates `null` startingBalance →
   * makes balance-conservation assertions actually work on first spin.
   */
  priorBalance?: number | null;
  /** LIVE balance getter — returns the session's freshest tracked balance at
   *  call time. Used to capture an accurate `balanceBefore` for the first spin
   *  RIGHT BEFORE it fires (after bet-change reloadBalance calls), instead of
   *  the stale `priorBalance` snapshot taken when ctx was built. */
  liveBalance?: () => number | null;
  /** Game slug — when set, fail/skip screenshots are saved to
   *  fixtures/registry/<slug>/case-failures/<caseId>.png and the path is
   *  returned in CaseResult.screenshotPath. */
  gameSlug?: string;
  /** Self-calibrated payout model (PP wlc_v games). Bound into the assertion
   *  sandbox so `payoutModelCheck(spin)` can verify combo wins vs paytable.
   *  When null/untrusted the check is a no-op (never false-fails). */
  payoutModel?: import("../registry/types.js").PayoutModel | null;
  /** Captured external browser tabs opened during this case (window.open
   *  triggered by clicks). Populated by a context "page" listener attached
   *  in executeCase. Click actions on elements with `externalPage: true`
   *  target the most-recently-opened tab here. Cleared (tabs closed) at
   *  end of case. Defaults to undefined — clicks fall back to ctx.page. */
  externalTabs?: Array<Page>;
};

export type CaseInput = {
  id: string;
  name: string;
  category: string;
  severity: "critical" | "major" | "minor";
  custom_assertions?: Array<{ id: string; description: string; check_code: string }>;
  actions: CaseAction[];
  skipReason?: string;
  /** Phase 8 — per-case minimum evidence requirement for confidence scoring. */
  minimum_evidence?: import("./evidence/index.js").EvidenceRequirement;
  /** Phase 8.4 — observed states allowed to interrupt this case (handler dispatched). */
  allowed_interruptions?: string[];
  /** Phase 8.4 — what to do when an allowed interrupt fires. */
  on_feature_triggered?: "handle_and_continue" | "skip_and_rerun" | "fail";
  /** Gap B — retry when outcome ∈ retryWhen (e.g., INCONCLUSIVE / FAIL_LOW).
   *  Caller-side loop wrapping executeCase enforces this. */
  retry_policy?: {
    maxRetries?: number;
    retryWhen?: string[];   // Outcome strings
  };
};

// Timing tunables resolved from registry per game (with hardcoded defaults
// fallback). Phase 7.1E — see src/pipeline/registry/timing-config.ts.

export async function executeCase(
  ctx: CaseExecutorContext,
  input: CaseInput,
): Promise<CaseResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const base: CaseResult = {
    caseId: input.id,
    name: input.name,
    category: input.category,
    severity: input.severity,
    status: "skip",
    actionsExecuted: 0,
    assertions: [],
    spin: null,
    durationMs: 0,
  };

  // Resolve per-game timing + bet-controls + popup-keywords (or defaults)
  const timing = await resolveTimingConfig(ctx.gameSlug ?? null);
  const betControls = await resolveBetControls(ctx.gameSlug ?? null);
  const popupKeywords = await resolvePopupKeywords(ctx.gameSlug ?? null);
  const ACTION_TIMEOUT_MS = timing.actionTimeoutMs;
  const POST_ACTION_SETTLE_MS = timing.postActionSettleMs;
  const HARD_CAP_MS = timing.hardCapMs;

  if (input.skipReason) {
    return { ...base, skipReason: input.skipReason, durationMs: Date.now() - start };
  }

  // External tab tracking: graph-explorer registers historyButton's children
  // (and other tab-opening triggers) with `externalPage: true`. When the
  // case clicks the parent trigger, the game's window.open fires a new
  // tab; the listener here captures it. Subsequent clicks on children
  // with externalPage=true route to the captured tab instead of the
  // original game page. Cleanup: tabs are closed at end of case so the
  // browser doesn't accumulate handles across multi-case runs.
  const externalTabs: Array<import("playwright").Page> = [];
  // Forward-declare the spin-response listener so onExternalPage can attach
  // it to new tabs the moment they're captured. `onResponse` is defined ~150
  // lines below; this declaration just promises TypeScript it exists.
  let onResponseRef: ((res: import("playwright").Response) => void) | null = null;
  const onExternalPage = (p: import("playwright").Page): void => {
    externalTabs.push(p);
    console.log(`[case-action] external tab opened — case has ${externalTabs.length} active`);
    // Mirror the spin-response listener onto the new tab so any
    // spin/history/feature responses fired from the tab's context get
    // captured too (rare for history pages but defensive — and necessary
    // if a tab fires e.g. doSpin via shared cookies).
    if (onResponseRef) p.on("response", onResponseRef);
  };
  ctx.page.context().on("page", onExternalPage);
  // Expose to executeAction via ctx (mutable shared state). All click
  // handlers see this same array; tabs added by listener flow in
  // automatically. Cleanup at end of case.
  ctx.externalTabs = externalTabs;
  const closeExternalTabs = async (): Promise<void> => {
    ctx.page.context().off("page", onExternalPage);
    for (const p of externalTabs.splice(0)) {
      if (onResponseRef) { try { p.off("response", onResponseRef); } catch { /* tab dead */ } }
      try { await p.close(); } catch { /* already closed */ }
    }
  };

  // Per-case screen recorder (QA_RECORD_VIDEO=1 + ffmpeg in PATH). Started
  // here AFTER the skip check so skipped cases produce no .frames artifacts.
  // Stopped before each return below via stopVideo() — the result includes
  // the MP4 path so the dashboard can link it. Optional override:
  // QA_RECORD_VIDEO_FPS (default 5). Higher fps = larger files + slower
  // ffmpeg compose; 5fps suffices for slot UI debugging.
  let videoRecorder: CaseVideoRecorder | null = null;
  let videoPath: string | undefined = undefined;
  if (process.env.QA_RECORD_VIDEO === "1" && ctx.gameSlug) {
    if (await CaseVideoRecorder.ffmpegAvailable()) {
      const evidenceDir = path.join(dirForGame(ctx.gameSlug), "case-evidence");
      await mkdir(evidenceDir, { recursive: true });
      videoRecorder = new CaseVideoRecorder({
        caseEvidenceDir: evidenceDir,
        caseId: input.id,
        fps: Number(process.env.QA_RECORD_VIDEO_FPS ?? 5),
      });
      // Pass an active-page callback so the recorder follows external tabs
      // when the case switches focus. Always returns the most recent open
      // external tab if any (matches click routing in executeAction); else
      // falls back to the main game page.
      await videoRecorder.start(ctx.page, () => {
        for (let i = externalTabs.length - 1; i >= 0; i--) {
          const p = externalTabs[i];
          if (p && !p.isClosed()) return p;
        }
        return ctx.page;
      });
    } else {
      warnings.push("QA_RECORD_VIDEO=1 but ffmpeg not found in PATH — skipping video");
    }
  }
  const stopVideo = async (): Promise<void> => {
    if (!videoRecorder) return;
    const out = await videoRecorder.stop();
    videoRecorder = null;
    if (out) {
      videoPath = path.relative(process.cwd(), out);
      console.log(`[case-video] ${input.id} → ${videoPath}`);
    }
  };

  // Multi-spin capture: PP autoplay fires N responses sequentially. We collect
  // ALL spin responses (parseable + matching /gameService) during execution
  // window via page.on('response') listener.
  //
  // Listener attach gate (broad on purpose): attach when ANY of the following
  // hint that spins may flow during the case:
  //   1. Action plan contains a `spin` action (manual spin loops)
  //   2. Last action is `click` / `spin` (single-spin terminal click)
  //   3. Any action is `wait_until_state` / `wait_until_network_idle`
  //      (autoplay batches finish via state/network wait, not explicit spin)
  //   4. Any custom assertion references `collector.spins` with non-zero
  //      expectation (test wants captured spins)
  // The previous gate dropped autoplay/wait-style cases on the floor → 0
  // responses captured even when balance tracker logged many spin updates.
  const lastAction = input.actions[input.actions.length - 1];
  const hasSpinAction = input.actions.some((a) => a.kind === "spin");
  const lastIsSpinish = Boolean(lastAction && (lastAction.kind === "spin" || lastAction.kind === "click"));
  const hasWaitPredicate = input.actions.some(
    (a) =>
      a.kind === "wait_until_state"
      || a.kind === "wait_until_network_idle"
      || a.kind === "wait_until_no_spin_response",
  );
  const assertionWantsSpins = (input.custom_assertions ?? []).some((a) =>
    /collector\.spins\.(length|every|some|map|reduce|filter)/.test(a.check_code)
    && !/\.length\s*===\s*0\b/.test(a.check_code),
  );
  const expectsSpin = hasSpinAction || lastIsSpinish || hasWaitPredicate || assertionWantsSpins;

  // UI-only case detection (Phase 10.1) — when the action plan navigates
  // popups/menus and no spin is expected, auto-inject synthetic UI
  // assertions backed by screenshot + state signals. This raises confidence
  // for non-spin cases (info popup tour, paytable inspection, settings
  // toggle) from the 0.65 default to 0.85+ when evidence agrees.
  // CaseAction click variant uses `uiKey` (not `target`) — see
  // step7-testcase-gen/case-action-translator.ts. The earlier draft of this
  // detector read `target` and silently fell back to "" for every click,
  // causing isUiOnlyCase=false for ALL cases. Helper centralizes the access.
  const uiCaseShape = detectUiOnlyCase(input.actions);
  const isUiOnlyCase = uiCaseShape.isUiOnlyCase;
  const endsOnReopen = uiCaseShape.endsOnReopen;
  console.log(`[ui-assert] isUiOnlyCase=${isUiOnlyCase} (noSpinActions=${uiCaseShape.noSpinActions}, hasOpenCloseUiActions=${uiCaseShape.hasOpenCloseUiActions}, endsOnReopen=${endsOnReopen})`);
  if (isUiOnlyCase && endsOnReopen) {
    console.log(`[ui-assert]   ends on reopen → will SKIP _auto_returned_to_main_after_close synthetic`);
  }

  // Screenshot capture points for UI-only synthetic assertions.
  let uiBaselineShot: Buffer | null = null;
  let uiMidShot: Buffer | null = null;
  let uiFinalShot: Buffer | null = null;
  if (isUiOnlyCase) {
    try {
      uiBaselineShot = await ctx.page.screenshot({ type: "png", fullPage: false });
      console.log(`[ui-assert] baseline screenshot captured (${uiBaselineShot.length} bytes)`);
    } catch (err) {
      console.warn(`[ui-assert] baseline screenshot FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dedup state managed by the pure cascade-dedup module — fully covered by
  // tests/invariants/cascade-dedup.spec.ts. Listener here only handles:
  //   1) Response filtering (URL + parser canParseResponse)
  //   2) Request body pairing (for parser.parseSpinPair)
  //   3) Async serialization (promise queue prevents racy state reads)
  //   4) priorBalance hint for first spin's null balanceBefore
  //   5) Round-end signal detection (provider spec drives this — PP emits
  //      `action=doCollect` once per logical round; the wait loop blocks
  //      until at least one round-end signal arrives so cascade animation
  //      can't swallow the next spin click).
  // Merge / append decision delegated to ingestFrame().
  const dedupState = createDedupState();
  const collectedSpins = dedupState.spins;
  let stopCollecting = false;
  const reqByTiming = new Map<string, string | null>(); // url+startedAt → req body
  /** Monotonic timestamp of the most recent spin-response capture. Used by
   *  `wait_until_no_spin_response` to detect autoplay batch completion. Init
   *  to Date.now() so a pre-action wait doesn't fire immediately. */
  let lastSpinResponseAt = Date.now();
  /** Accurate `balanceBefore` for the FIRST captured spin. Seeded from the
   *  stale priorBalance snapshot, then refreshed from the LIVE balance getter
   *  right before each spin-triggering action — so it reflects the real
   *  pre-spin balance (after bet-change reloadBalance calls). Fixes the
   *  balance-conservation assertion failing by ~bet when priorBalance is stale. */
  let balanceBeforeFirstSpin: number | null =
    typeof ctx.priorBalance === "number" ? ctx.priorBalance : null;

  // Round-end signal tracking — read provider spec on-the-fly. Pre-compile
  // regex pairs once per case to keep the listener hot path cheap.
  const providerSpec = (ctx.parser as { spec?: import("../step6-build-model/providers/spec-types.js").ProviderSpec }).spec;
  const roundEndSignalPatterns = (providerSpec?.roundEndSignals ?? []).map((s) => ({
    url: new RegExp(s.urlPattern, "i"),
    body: s.bodyPattern ? new RegExp(s.bodyPattern, "i") : null,
  }));
  // Monotonic counter of round-end signals observed since case start. The
  // wait loop snapshots this BEFORE each spin click and waits for it to
  // increment before firing the next click.
  let roundEndCount = 0;

  // Serialize listener processing through a promise queue. page.on("response")
  // invokes listeners concurrently — multiple responses can arrive while a
  // prior listener is mid-await (res.text + parser). Without serialization
  // the dedup check is racy: two cascade frames can both see the SAME
  // pre-merge state and both push entries → inflated count, missed merges.
  // The queue forces strict sequential processing in arrival order.
  let processQueue: Promise<void> = Promise.resolve();
  // URL pre-filter — cheap reject of obvious non-API traffic (assets, ads,
  // analytics). The PARSER does the authoritative URL+shape check via
  // canParseResponse(body, url), so we keep this pre-filter loose: skip
  // only file extensions that are definitely not spin responses. The previous
  // hardcoded /gameService|doSpin/ was Pragmatic-specific and dropped every
  // response for non-Pragmatic games (Generic, JILI, etc.) → 0 spins captured
  // even though the parser would have accepted them. If a per-game hint is
  // provided via ctx.spinApiUrlContains, use it as a positive filter instead.
  const positiveUrlHint = ctx.spinApiUrlContains;
  const NON_API_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|mp3|mp4|webm|wav)(\?|$)/i;
  // Diagnostic counters so a "0 spins captured" case can be debugged without
  // re-running. Surfaced as a warning when no spins land.
  let urlsSeen = 0;
  let urlsAfterPreFilter = 0;
  let parserRejected = 0;
  let parserThrew = 0;
  let dedupSwallowed = 0;
  // Wall-clock of the last time the listener observed any relevant traffic.
  // Used by the spin-wait loop to extend the per-spin timeout when responses
  // ARE flowing but happen to be dedup-merged or parser-rejected — the game
  // is alive, just busy. Without this, slow cascade games hit the 15s cap
  // even though the genuine new-spin response is right behind the queue.
  let lastRelevantResponseAt = 0;
  const sampleRejectedUrls: string[] = [];
  const sampleThrownErrors: string[] = [];
  // Evidence: persist every interesting (non-asset) request+response pair for
  // post-hoc debugging without re-running. Caps total size to MAX_NETWORK_BYTES
  // — older entries are kept but bodies truncated to MAX_BODY_BYTES once cap
  // hits. Written to disk at end of case alongside the screenshot.
  const networkLog: NetworkLogEntry[] = [];
  const MAX_BODY_BYTES = 8 * 1024; // 8KB per body — enough for full spin response
  let totalNetworkBytes = 0;
  const MAX_NETWORK_BYTES = 256 * 1024; // 256KB per case
  // Captured at the moment the first parser-accepted spin response lands.
  // Used to compute parserDiagnostic at end-of-case.
  let firstSpinRequestBody: string | null = null;
  // Quiet env gates only ALLOW silencing — diagnostics are on by default so
  // a "0 spins captured" failure can be debugged from the existing log
  // stream without needing a re-run with extra flags.
  const quietDiag = process.env.QA_QUIET_NETWORK === "1";
  console.log(`[case-exec] listener attached for case "${input.id}" — parser kind=${(ctx.parser as { kind?: string }).kind ?? "?"}, positiveUrlHint=${positiveUrlHint ?? "(none)"}`);
  const onResponse = (res: import("playwright").Response) => {
    if (stopCollecting) return;
    const url = res.url();
    urlsSeen++;
    if (positiveUrlHint) {
      if (!url.includes(positiveUrlHint)) return;
    } else if (NON_API_EXT.test(url)) {
      return;
    }
    urlsAfterPreFilter++;
    lastRelevantResponseAt = Date.now();
    const reqBody = res.request().postData() ?? null;
    if (!quietDiag) {
      const reqInfo = reqBody === null
        ? "reqBody=null (POST body not captured — parser will compute bet=0)"
        : `reqBody[:80]="${reqBody.slice(0, 80)}"`;
      console.log(`[case-exec/net] candidate #${urlsAfterPreFilter}: ${url}\n  ${reqInfo}`);
    }
    // Check request body for round-end signal BEFORE we await res.text().
    // For PP the doCollect signal is in the REQUEST body (action=doCollect)
    // and the response body is just a balance ping — checking the request
    // body avoids awaiting + parsing the full response just to detect the
    // signal. URL pattern still has to match.
    if (roundEndSignalPatterns.length > 0 && reqBody) {
      for (const sig of roundEndSignalPatterns) {
        if (sig.url.test(url) && (!sig.body || sig.body.test(reqBody))) {
          roundEndCount++;
          if (!quietDiag) console.log(`[case-exec/net] round-end signal #${roundEndCount} detected (url match + body=${sig.body ? "yes" : "no"})`);
          break;
        }
      }
    }
    processQueue = processQueue.then(async () => {
      if (stopCollecting) return;
      try {
        const body = await res.text().catch(() => "");
        if (!body) {
          if (!quietDiag) console.log(`[case-exec/net] empty body: ${url}`);
          return;
        }
        lastRelevantResponseAt = Date.now();

        // Evidence: persist this request+response pair if size budget allows.
        // Done BEFORE the parser-filter so we capture parser-rejected URLs too
        // (helpful for debugging "why didn't parser accept this response?").
        if (totalNetworkBytes < MAX_NETWORK_BYTES) {
          const reqTruncated = reqBody ? reqBody.slice(0, MAX_BODY_BYTES) : null;
          const resTruncated = body.slice(0, MAX_BODY_BYTES);
          const entryBytes = (reqTruncated?.length ?? 0) + resTruncated.length + 256;
          totalNetworkBytes += entryBytes;
          networkLog.push({
            url,
            method: res.request().method(),
            status: res.status(),
            durationMs: 0, // timing not exposed by Playwright Response — fill later if needed
            requestBody: reqTruncated,
            responseBody: resTruncated,
            at: new Date().toISOString(),
          });
        }
        // Also check response body for round-end signal (some providers put
        // the signal on the response side, not the request).
        if (roundEndSignalPatterns.length > 0) {
          for (const sig of roundEndSignalPatterns) {
            if (sig.body && sig.url.test(url) && sig.body.test(body)) {
              // Only count if request body didn't already match (avoid double
              // counting for providers where signal is on both sides).
              const reqAlreadyMatched = reqBody && sig.body.test(reqBody);
              if (!reqAlreadyMatched) {
                roundEndCount++;
                if (!quietDiag) console.log(`[case-exec/net] round-end signal #${roundEndCount} detected (response body match)`);
              }
              break;
            }
          }
        }
        const lastNetEntry = networkLog[networkLog.length - 1];
        if (!ctx.parser.canParseResponse(body, url)) {
          if (lastNetEntry && lastNetEntry.url === url) lastNetEntry.parsedAsSpin = false;
          parserRejected++;
          if (sampleRejectedUrls.length < 5) sampleRejectedUrls.push(url);
          if (!quietDiag) console.log(`[case-exec/net] parser REJECTED: ${url}\n  body[:120]="${body.slice(0, 120)}"`);
          return;
        }
        let spin;
        try {
          spin = ctx.parser.parseSpinPair
            ? ctx.parser.parseSpinPair(reqBody, body, url)
            : ctx.parser.parseResponse(body);
        } catch (err) {
          if (lastNetEntry && lastNetEntry.url === url) lastNetEntry.parsedAsSpin = false;
          parserThrew++;
          const msg = err instanceof Error ? err.message : String(err);
          if (sampleThrownErrors.length < 3) sampleThrownErrors.push(msg);
          console.warn(`[case-exec/net] parser THREW on ${url}: ${msg}`);
          return;
        }
        if (lastNetEntry && lastNetEntry.url === url) lastNetEntry.parsedAsSpin = true;
        // Capture the FIRST parser-accepted spin's request body for diagnostic.
        if (firstSpinRequestBody === null && reqBody) firstSpinRequestBody = reqBody;
        if (!spin) return;
        if (spin.balanceBefore === null) {
          const chained = resolveSpinBalanceBefore({
            priorSpins: collectedSpins,
            liveBeforeFirstSpin: balanceBeforeFirstSpin,
            priorBalance: ctx.priorBalance,
          });
          if (typeof chained === "number") spin.balanceBefore = chained;
        }
        // 2026-05-26: re-evaluate isFreeSpin AFTER priorBalance patch.
        // Parsers (SpecDriven + PragmaticLegacy) see response fields only —
        // PP spin response has NO `bb` field, so parser can't tell whether
        // balance decreased → conservatively marks as NORMAL when fs>0 but
        // balance unknown. NOW we know balanceBefore (from priorBalance
        // patch above). Re-flag FS for: fs>0 AND balance KNOWN AND not
        // decreased. Conversely: leave NORMAL for BUY (fs>0 but balance
        // DROPPED) — parser already got that right.
        const fsRemaining = spin.freeSpinsRemaining ?? 0;
        if (fsRemaining > 0
            && spin.balanceBefore != null
            && Number.isFinite(spin.balanceAfter)) {
          const drop = spin.balanceBefore - spin.balanceAfter;
          const balanceDidNotDecrease = drop <= 0.01;
          if (balanceDidNotDecrease && !spin.isFreeSpin) {
            // Promote to FREE_SPIN — bet should be 0 (no actual deduction)
            spin.isFreeSpin = true;
            spin.bet = 0;
            spin.state = "FREE_SPIN";
            if (!quietDiag) {
              console.log(`[case-exec/net] post-patch FS re-eval: spin ${spin.roundId} fs=${fsRemaining} drop=${drop.toFixed(2)} → FREE_SPIN, bet=0`);
            }
          }
        }
        const beforeLen = collectedSpins.length;
        // Strict dedup: merge only when roundId truly matches. Balance
        // continuity fallback can merge distinct autoplay rounds and drop
        // spin count (observed on Pragmatic autoplay batches).
        ingestFrame(dedupState, spin, { allowBalanceContinuity: false });
        // Always stamp lastSpinResponseAt — whether the frame extended the
        // dedup list (new round) OR merged into an existing one (cascade
        // continuation). Both signal "spin server still active" for the
        // purpose of wait_until_no_spin_response.
        lastSpinResponseAt = Date.now();
        if (collectedSpins.length === beforeLen) {
          dedupSwallowed++;
          if (!quietDiag) console.log(`[case-exec/net] dedup-merged: roundId=${spin.roundId} (no new entry; total still ${collectedSpins.length})`);
        } else {
          console.log(`[case-exec/net] CAPTURED spin #${collectedSpins.length}: roundId=${spin.roundId} bet=${spin.bet} win=${spin.win} balance=${spin.balanceBefore}→${spin.balanceAfter}`);
        }
      } catch (err) {
        console.warn(`[case-exec/net] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  };
  if (expectsSpin) ctx.page.on("response", onResponse);
  // Wire the forward-declared ref so onExternalPage can attach the same
  // handler to any tabs already in-flight or opened later in the case.
  if (expectsSpin) {
    onResponseRef = onResponse;
    for (const p of externalTabs) p.on("response", onResponse);
  }

  let actionsExecuted = 0;
  // Evidence: per-action telemetry. Each action push entry with timing +
  // success outcome so dashboard can render the sequence + spot slow / failed
  // actions. Mutated inside the action loop below.
  const actionLog: ActionLogEntry[] = [];
  // per game (Phase 7.1E). Defaults retained for backward-compat.
  const SPIN_RESPONSE_TIMEOUT_MS = timing.spinResponseTimeoutMs;
  const POPUP_CHECK_DELAY_MS = timing.popupCheckDelayMs;
  const MAX_SPIN_RETRIES = timing.maxSpinRetries;
  // Track every interrupt that the inter-action observer handled. Used to
  // promote a passing case to PASS_WITH_INTERRUPT outcome (so QA can see the
  // run DID encounter randomness — free spin / big win — but recovered).
  let interruptsHandledCount = 0;
  // State timeline — populated by pre-spin observe (inside action loop) and
  // post-action observe (after the loop). Dashboard renders this so QA can
  // trace why a multi-spin case took the path it did.
  const stateTimeline: Array<{ at: string; from?: string; to: string; via?: string }> = [];
  stateTimeline.push({ at: new Date().toISOString(), to: "MAIN" });
  try {
    for (const action of input.actions) {
      // Keep the accurate pre-spin balance fresh from the LIVE tracker until
      // the first spin lands. Each non-spin action (set_bet, waits, autoplay
      // clicks) may trigger reloadBalance; refreshing every iteration means the
      // value captured just before the first spin fires is the TRUE
      // balanceBefore — vs the stale priorBalance snapshot taken at ctx build.
      if (collectedSpins.length === 0 && ctx.liveBalance) {
        const live = ctx.liveBalance();
        if (typeof live === "number") balanceBeforeFirstSpin = live;
      }
      // PRE-SPIN STATE OBSERVATION (Phase 10.x — adaptive state-machine runner).
      // Before each spin click, peek at the game's current state. If the
      // game wandered into an allowed-interruption state (FREE_SPIN_TRIGGERED,
      // BIG_WIN_POPUP, BONUS_POPUP) — typical when the PREVIOUS spin landed
      // a big win — dispatch the matching handler, wait until back on MAIN,
      // then proceed with this spin click. Without this step, the spin click
      // fires during the interrupt animation → game ignores it → engine
      // reports "no response within Xs" and the count assertion fails for
      // reasons that are pure randomness, not a real bug.
      if (
        action.kind === "spin"
        && (input.allowed_interruptions?.length ?? 0) > 0
      ) {
        try {
          const { observeState } = await import("./state-observer.js");
          const { getHandler } = await import("./interrupt-handlers/index.js");
          const obs = await observeState(ctx.page, {
            interstitialKeywords: popupKeywords.interstitial,
            substateKeywords: popupKeywords.substate,
            lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
          });
          if (obs.state !== "MAIN" && (input.allowed_interruptions ?? []).includes(obs.state)) {
            console.log(`[case-action] pre-spin observe: state=${obs.state} (allowed) — dispatching handler before spin`);
            stateTimeline.push({ at: new Date().toISOString(), from: "MAIN", to: obs.state, via: "pre-spin observe" });
            const handler = getHandler(obs.state);
            if (handler) {
              const outcome = await handler({
                page: ctx.page,
                uiMap: ctx.uiMap,
                gameSlug: ctx.gameSlug,
                lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
                timing: {
                  dismissPreWaitMs: timing.dismissPreWaitMs,
                  dismissInterClickMs: timing.dismissInterClickMs,
                  hardCapMs: timing.hardCapMs,
                },
              });
              interruptsHandledCount++;
              stateTimeline.push({ at: new Date().toISOString(), from: obs.state, to: outcome.finalState, via: outcome.handler });
              warnings.push(`pre-spin interrupt handled: ${obs.state} → ${outcome.finalState} via ${outcome.handler}`);
              console.log(`[case-action] interrupt handled: ${obs.state} → ${outcome.finalState} (${outcome.summary ?? ""})`);
            } else {
              warnings.push(`pre-spin observed allowed interrupt ${obs.state} but no handler registered`);
            }
          }
        } catch (err) {
          console.warn(`[case-action] pre-spin observe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (action.kind === "spin") {
        const beforeCount = collectedSpins.length;
        const roundEndCountAtClick = roundEndCount;
        const actionStart = Date.now();
        let actionError: string | undefined;
        try {
          await executeAction(action, ctx, timing, betControls, {
            lastSpinResponseAt: () => lastSpinResponseAt,
            spinResponseCount: () => collectedSpins.length,
          });
        } catch (err) {
          actionError = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          actionLog.push({
            kind: action.kind,
            target: undefined,
            durationMs: Date.now() - actionStart,
            success: !actionError,
            note: actionError,
          });
        }
        // Reactive wait with popup-block detection. Strategy:
        //   1. Poll collectedSpins for new entry (response landed)
        //   2. If provider spec defines roundEndSignals, ALSO wait until at
        //      least one new round-end signal arrives — guarantees cascade
        //      animation finished before next spin click is allowed.
        //   3. If POPUP_CHECK_DELAY_MS passes with no response → run OCR
        //      detect. If popup found → dismiss + re-click spinButton +
        //      restart timer. Up to MAX_SPIN_RETRIES per spin.
        //   4. After retries exhausted or full timeout, bail with warning.
        const sb = ctx.uiMap.spinButton;
        let retries = 0;
        const phaseStart = Date.now();
        const phaseActivityStart = lastRelevantResponseAt;
        let nextPopupCheckAt = phaseStart + POPUP_CHECK_DELAY_MS;
        const POPUP_CHECK_BACKOFF_CAP_MS = Math.max(POPUP_CHECK_DELAY_MS * 4, 10_000);
        let popupCheckInterval = POPUP_CHECK_DELAY_MS;
        // Pre-capture phase: how long to wait for ANY spin response after
        // clicking. Used only until first response arrives; once captured we
        // switch to post-capture readiness logic below.
        const PRE_CAPTURE_TIMEOUT_MS = SPIN_RESPONSE_TIMEOUT_MS;
        // Post-capture silence thresholds (Option D — win-aware readiness).
        // PP no-win spins emit one response then go fully idle → 800ms of
        // silence is plenty to declare "ready". Win/cascade spins still
        // have asset loads + cluster animations after the initial response;
        // wait 3s of silence OR a round-end signal, whichever first.
        const NO_WIN_SILENCE_MS = 800;
        const WIN_SILENCE_MS = 3_000;
        const ABS_HARD_CAP_MS = SPIN_RESPONSE_TIMEOUT_MS * 4;
        const hasRoundEndSignals = roundEndSignalPatterns.length > 0;
        // Pure pre-capture check kept for "no response at all" failure mode.
        const isWaitDone = () => {
          if (collectedSpins.length === beforeCount) return false;
          // Post-capture: choose silence threshold by win value of last spin.
          const lastSpin = collectedSpins[collectedSpins.length - 1];
          const isNoWin = lastSpin && (typeof lastSpin.win !== "number" || lastSpin.win === 0);
          const silenceTarget = isNoWin ? NO_WIN_SILENCE_MS : WIN_SILENCE_MS;
          // Round-end signal (provider config) is a strong "ready" signal —
          // skip the silence wait when it arrives.
          if (hasRoundEndSignals && roundEndCount > roundEndCountAtClick) return true;
          // Silence check: how long has it been since ANY relevant traffic?
          const sinceLastActivity = Date.now() - lastRelevantResponseAt;
          return sinceLastActivity >= silenceTarget;
        };
        while (!isWaitDone()) {
          const now = Date.now();
          const elapsedInPhase = now - phaseStart;
          // Hard cap regardless of activity — prevents an infinitely chatty
          // but never-spinning game from blocking the case forever.
          if (elapsedInPhase >= ABS_HARD_CAP_MS) break;
          // Pre-capture deadline: if NO spin captured within
          // PRE_CAPTURE_TIMEOUT_MS, bail — even if traffic is still arriving,
          // we couldn't pair a doSpin response by now → likely game dropped
          // the click.
          if (collectedSpins.length === beforeCount && elapsedInPhase >= PRE_CAPTURE_TIMEOUT_MS) break;
          if (now >= nextPopupCheckAt && retries < MAX_SPIN_RETRIES) {
            try {
              const popup = await detectAnyPopup(ctx.page, {
                interstitialKeywords: popupKeywords.interstitial,
                substateKeywords: popupKeywords.substate,
              });
              // Only react to INTERSTITIAL matches (press anywhere, big win,
              // congratulations, etc.) which are dismissable by clicking. DO
              // NOT auto-dismiss on substate matches (autoplay, paytable,
              // history, settings) — those keywords are usually permanent
              // BUTTON LABELS on the main screen, so they false-positive on
              // every spin. A real substate popup (autoplay menu open) will
              // also block spins, but center-click dismiss often makes things
              // worse by entering autoplay mode. Just warn and keep waiting.
              if (popup.interstitial) {
                const msg = `spin ${beforeCount + 1}: interstitial popup blocked (matched=[${popup.matchedKeywords.join(",")}]) — retry ${retries + 1}/${MAX_SPIN_RETRIES}`;
                console.warn(`[spin-retry] ${msg}`);
                warnings.push(msg);
                await dismissPopupsLoop(ctx.page, { maxAttempts: 2 });
                await ctx.page.waitForTimeout(1500);
                if (sb) {
                  await ctx.page.mouse.click(sb.x, sb.y);
                  console.log(`[spin-retry ${retries + 1}] re-clicked spinButton @ (${sb.x},${sb.y})`);
                }
                retries++;
                popupCheckInterval = POPUP_CHECK_DELAY_MS; // reset backoff
                nextPopupCheckAt = Date.now() + popupCheckInterval;
                continue;
              }
              if (popup.substate) {
                // Log once for visibility but don't dismiss; back off hard so
                // we don't keep re-OCRing the same button labels.
                console.log(`[spin-retry] substate keywords detected (matched=[${popup.matchedKeywords.join(",")}]) — ignoring (likely button labels)`);
              }
              // ANIMATION-DEBOUNCE retry (2026-05-25, Option B fix).
              // When no popup detected AND no response captured AND we've
              // waited ≥ half the timeout, suspect the click was eaten by an
              // ongoing canvas animation (cascade explode + win counter on
              // PP cluster/ways games). Re-click after a 2s settle so the
              // case progresses instead of dropping the spin.
              //
              // Distinct from popup retry — uses the SAME retries counter so
              // total retry budget is bounded (max MAX_SPIN_RETRIES across
              // both paths). Only fires when:
              //   1. No interstitial popup (would have hit the if above)
              //   2. No substate keywords (suggesting paytable/auto open)
              //   3. We've burned ≥ 50% of PRE_CAPTURE_TIMEOUT_MS waiting
              //   4. Still no captured spin response
              //   5. Spin button coords known (sb)
              else if (
                !popup.interstitial
                && !popup.substate
                && elapsedInPhase >= PRE_CAPTURE_TIMEOUT_MS * 0.5
                && collectedSpins.length === beforeCount
                && sb
              ) {
                const msg = `spin ${beforeCount + 1}: animation-debounce suspected (no popup detected, no response after ${(elapsedInPhase / 1000).toFixed(1)}s) — re-click ${retries + 1}/${MAX_SPIN_RETRIES}`;
                console.warn(`[spin-retry] ${msg}`);
                warnings.push(msg);
                await ctx.page.waitForTimeout(2000); // extra settle for any tail animation
                try {
                  await ctx.page.mouse.click(sb.x, sb.y);
                  console.log(`[spin-retry ${retries + 1}] animation-debounce re-clicked spinButton @ (${sb.x},${sb.y})`);
                } catch {/* swallow click errors — retry budget will catch */}
                retries++;
                popupCheckInterval = POPUP_CHECK_DELAY_MS; // reset backoff
                nextPopupCheckAt = Date.now() + popupCheckInterval;
                continue;
              }
              // No interstitial popup → game is just slow. Back off so we
              // don't keep taking screenshots while waiting on the network.
              popupCheckInterval = Math.min(popupCheckInterval * 2, POPUP_CHECK_BACKOFF_CAP_MS);
              nextPopupCheckAt = Date.now() + popupCheckInterval;
            } catch (err) {
              console.warn(`[spin-retry] OCR check failed: ${err instanceof Error ? err.message : String(err)}`);
              nextPopupCheckAt = Date.now() + popupCheckInterval;
            }
          }
          await ctx.page.waitForTimeout(200);
        }
        if (collectedSpins.length === beforeCount) {
          const totalElapsedSec = ((Date.now() - phaseStart) / 1000).toFixed(1);
          const sawActivity = lastRelevantResponseAt > phaseActivityStart;
          const detail = sawActivity
            ? `responses arrived (merged/rejected) but no new spin response within ${PRE_CAPTURE_TIMEOUT_MS / 1000}s of click`
            : `no spin/gameService response within ${PRE_CAPTURE_TIMEOUT_MS / 1000}s of click`;
          const msg = `spin ${beforeCount + 1}: ${detail} (total elapsed ${totalElapsedSec}s, ${retries} popup-retries)`;
          console.warn(`[case-action] ${msg}`);
          warnings.push(msg);
        }
        // No more "no round-end signal" warning — silence-based readiness
        // makes that condition normal (PP only emits doCollect for win spins).
      } else {
        const actionStart = Date.now();
        let actionError: string | undefined;
        const target = describeActionTarget(action);
        try {
          await executeAction(action, ctx, timing, betControls, {
            lastSpinResponseAt: () => lastSpinResponseAt,
            spinResponseCount: () => collectedSpins.length,
          });
        } catch (err) {
          actionError = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          actionLog.push({
            kind: action.kind,
            target,
            durationMs: Date.now() - actionStart,
            success: !actionError,
            note: actionError,
          });
        }
      }
      actionsExecuted++;
      // Capture mid-shot right after the FIRST open-popup click in UI-only
      // cases. The screenshot taken once the popup is fully visible gives
      // the strongest signal that the click actually opened something.
      if (
        isUiOnlyCase
        && !uiMidShot
        && action.kind === "click"
        && isOpenUiKey(action.uiKey)
      ) {
        try {
          await ctx.page.waitForTimeout(600);
          uiMidShot = await ctx.page.screenshot({ type: "png", fullPage: false });
          console.log(`[ui-assert] mid-shot captured AFTER click "${action.uiKey}" (${uiMidShot.length} bytes)`);
        } catch (err) {
          console.warn(`[ui-assert] mid-shot capture FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    stopCollecting = true;
    ctx.page.off("response", onResponse);
    await processQueue.catch(() => undefined);  // drain any in-flight listeners
    const screenshotPath = await captureCaseScreenshot(ctx.page, ctx.gameSlug, input.id) ?? undefined;
    await stopVideo();
    await closeExternalTabs();
    return {
      ...base,
      status: "fail",
      actionsExecuted,
      skipReason: `action failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      screenshotPath,
      videoPath,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // After all actions: wait for autoplay/cascade spins to settle.
  // Per-spin window: 10s no-new-spin → done (each spin gets 10s to fire after
  // previous). Auto-extends with each spin captured so 100-spin autoplay works.
  // Absolute hard cap 5 min for safety.
  //
  // BUY-FEATURE SAFETY NET (2026-05-25): if the FIRST captured spin shows a
  // large balance deduction (≥ 50× base bet), this is a BUY transaction → FS
  // chain will auto-play 30-90s after. Standard 10s settle is too short.
  // Auto-extend per-spin settle to 45s when this signature detected, giving
  // the FS chain time to land without requiring catalog wait_until_state.
  // Works alongside translator prompt update (which emits wait_until_state
  // explicitly) — this is a defense-in-depth fallback.
  if (expectsSpin) {
    // Buy-feature detection runs BEFORE entering the wait loop — first spin
    // is typically captured during the action loop (BUY click → response).
    // 2026-05-26 fix: previous version checked inside the loop's
    // "if (collectedSpins.length > lastCount)" branch which never fires when
    // the BUY response landed BEFORE post-action wait starts.
    let settleMs = POST_ACTION_SETTLE_MS;
    const isAutoplayStyleCase =
      input.actions.some((a) => a.kind === "wait_until_no_spin_response")
      || /\bautoplay\b/i.test(input.category)
      || /autoplay|autospin/i.test(`${input.id} ${input.name}`);
    if (isAutoplayStyleCase) {
      // Autoplay batches can have occasional long gaps (win flow, UI latency).
      // 10s default settle is too aggressive and can terminate capture early.
      settleMs = Math.max(settleMs, 25_000);
    }
    let buyFeatureDetected = false;
    if (collectedSpins.length >= 1) {
      const first = collectedSpins[0]!;
      const drop = first.balanceBefore != null
        ? (first.balanceBefore - first.balanceAfter)
        : 0;
      const ratio = first.bet > 0 ? drop / first.bet : 0;
      if (ratio >= 50) {
        buyFeatureDetected = true;
        settleMs = 45_000;
        warnings.push(`buy-feature detected (deduction ratio ${ratio.toFixed(1)}×) — extending settle window to ${settleMs}ms for FS chain`);
        console.log(`[case-action] buy-feature signature detected on captured spin #1 (drop=${drop.toFixed(2)}, ratio=${ratio.toFixed(1)}×) — extending settle to ${settleMs}ms`);
      }
    }

    let lastCount = collectedSpins.length;
    let lastChange = Date.now();
    const hardDeadline = start + HARD_CAP_MS;
    while (Date.now() < hardDeadline) {
      await ctx.page.waitForTimeout(500);
      if (collectedSpins.length > lastCount) {
        // Continue checking buy-feature for late-arriving first spin (rare:
        // BUY response arrives only after dismiss completes).
        if (!buyFeatureDetected && collectedSpins.length === 1) {
          const first = collectedSpins[0]!;
          const drop = first.balanceBefore != null
            ? (first.balanceBefore - first.balanceAfter)
            : 0;
          const ratio = first.bet > 0 ? drop / first.bet : 0;
          if (ratio >= 50) {
            buyFeatureDetected = true;
            settleMs = 45_000;
            warnings.push(`buy-feature detected (deduction ratio ${ratio.toFixed(1)}×) — extending settle window to ${settleMs}ms for FS chain`);
            console.log(`[case-action] buy-feature signature detected (drop=${drop.toFixed(2)}, ratio=${ratio.toFixed(1)}×) — extending settle to ${settleMs}ms`);
          }
        }
        lastCount = collectedSpins.length;
        lastChange = Date.now();
        console.log(`[case-action] spin captured ${collectedSpins.length} (resetting ${settleMs}ms settle window)`);
      }
      if (Date.now() - lastChange >= settleMs) {
        // No new spin within settle window — either no spin coming (single-spin case) or
        // autoplay/FS chain completed.
        if (collectedSpins.length > 0) break;
        // No spins yet AND 10s passed → wait full ACTION_TIMEOUT_MS for first spin
        if (Date.now() - start >= ACTION_TIMEOUT_MS) break;
      }
    }
    stopCollecting = true;
    ctx.page.off("response", onResponse);
    await processQueue.catch(() => undefined);  // drain any in-flight listeners
  }
  void reqByTiming;

  // Phase 8.3 — Adaptive interrupt observation. After main settle, observe
  // game state. If it's an allowed interruption (e.g., FREE_SPIN_TRIGGERED),
  // dispatch the matching handler from interrupt-handlers/registry. Then
  // re-settle once to capture any additional spins. Builds onto the
  // stateTimeline already populated by pre-spin observers in the action loop.
  if (expectsSpin && (input.allowed_interruptions?.length ?? 0) > 0) {
    try {
      const { observeState } = await import("./state-observer.js");
      const { getHandler } = await import("./interrupt-handlers/index.js");
      let observed = await observeState(ctx.page, {
        interstitialKeywords: popupKeywords.interstitial,
        substateKeywords: popupKeywords.substate,
        lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
      });
      // Cloud runs can briefly classify end-of-spin animation as UNKNOWN.
      // Re-observe once after a short settle before committing timeline state.
      if (observed.state === "UNKNOWN") {
        await ctx.page.waitForTimeout(700);
        const reObserved = await observeState(ctx.page, {
          interstitialKeywords: popupKeywords.interstitial,
          substateKeywords: popupKeywords.substate,
          lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
        });
        if (reObserved.state !== "UNKNOWN") {
          console.log(`[adaptive-runner] UNKNOWN resolved after settle: ${observed.state} -> ${reObserved.state}`);
          observed = reObserved;
        }
      }
      const weakUnknown = observed.state === "UNKNOWN"
        && observed.confidence < 0.5
        && (observed.signals.ocrMatched?.length ?? 0) === 0;
      if (weakUnknown) {
        console.log("[adaptive-runner] ignoring weak UNKNOWN (no OCR keywords, low confidence) — treat as MAIN");
      }
      if (observed.state !== "MAIN" && !weakUnknown) {
        stateTimeline.push({ at: new Date().toISOString(), from: "MAIN", to: observed.state, via: "observed" });
        const allowed = input.allowed_interruptions ?? [];

        // Phase 8.5 — UNKNOWN state → invoke learner if QA_UNKNOWN_LEARN!=0.
        // Learner output goes through Patch Validator gates before persist.
        // After learning, do NOT auto-handle — mark NEEDS_REVIEW so QA can
        // verify the suggestion before subsequent runs trust it.
        if (observed.state === "UNKNOWN" && process.env.QA_UNKNOWN_LEARN !== "0") {
          try {
            const ocrForLearn = observed.ocrText ?? "";
            const gate = shouldRunUnknownLearner(ocrForLearn);
            if (!gate.run) {
              warnings.push(`unknown-state learner skipped: ${gate.reason}`);
            } else {
              const { learnUnknownState, persistSignature } = await import("../step14-unknown-state-learn/index.js");
              unknownLearnAttemptCount++;
              unknownLearnSeenAt.set(gate.key, Date.now());
              const learned = await learnUnknownState(ctx.page, ocrForLearn);
              if (learned.ok && learned.signature && ctx.gameSlug) {
                const persisted = await persistSignature(ctx.gameSlug, learned.signature, {
                  confidence: learned.confidence,
                  minConfidence: 0.7,
                });
                if (persisted.ok) {
                  warnings.push(`learned unknown state "${learned.signature.state}" (confidence ${(learned.confidence * 100).toFixed(0)}%) — saved to state-signatures.json`);
                  stateTimeline.push({ at: new Date().toISOString(), from: "UNKNOWN", to: learned.signature.state, via: "AI-learner" });
                } else {
                  warnings.push(`learner produced signature but persist refused: ${persisted.reason}`);
                }
              } else if (!learned.ok) {
                warnings.push(`unknown-state learner: ${learned.reason}`);
              }
            }
          } catch (err) {
            warnings.push(`unknown-state learner threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (allowed.includes(observed.state)) {
          const handler = getHandler(observed.state);
          if (handler) {
            const outcome = await handler({
              page: ctx.page,
              uiMap: ctx.uiMap,
              gameSlug: ctx.gameSlug,
              lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
              timing: {
                dismissPreWaitMs: timing.dismissPreWaitMs,
                dismissInterClickMs: timing.dismissInterClickMs,
                hardCapMs: timing.hardCapMs,
              },
            });
            interruptsHandledCount++;
            stateTimeline.push({ at: new Date().toISOString(), from: observed.state, to: outcome.finalState, via: outcome.handler });
            if (outcome.ok) {
              warnings.push(`interrupt handled: ${outcome.handler} (${outcome.summary ?? ""})`);
            } else {
              warnings.push(`interrupt handler failed: ${outcome.handler} (${outcome.summary ?? ""})`);
            }
          } else {
            warnings.push(`observed allowed interrupt ${observed.state} but no handler registered`);
          }
        } else {
          warnings.push(`observed unexpected state ${observed.state} (not in allowed_interruptions)`);
        }
      }
    } catch (err) {
      console.warn(`[adaptive-runner] observation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Expected-count guard: count spin actions in input vs captured spins.
  // Cascade games can produce extra entries (handled by roundId dedup above),
  // so we compare against the post-merge collectedSpins.length. Mismatch
  // causes — in order of likelihood for cascade-style games:
  //   1) Cascade animation debounced clicks (most common on PP ways/cluster
  //      games) — subsequent click fired while cascade still animating →
  //      game ignored it.
  //   2) Interstitial popup blocked a click (rare since spin-retry handles).
  //   3) Network slow / response > timeout (very rare).
  const expectedSpins = input.actions.filter((a) => a.kind === "spin").length;
  if (expectedSpins > 0 && collectedSpins.length < expectedSpins) {
    const missing = expectedSpins - collectedSpins.length;
    // Heuristic: count how many responses were merged into existing rounds.
    // High merge ratio = cascade-heavy game → debounce is far more likely
    // than popup blockage. Flag that distinction so reviewers don't chase
    // ghost popups.
    const mergedHint = dedupSwallowed > 0
      ? ` (${dedupSwallowed} responses were dedup-merged as cascade frames — game is cascade-heavy, click likely debounced during animation)`
      : "";
    warnings.push(`expected ${expectedSpins} spin response(s), got ${collectedSpins.length} — ${missing} click(s) likely debounced by ongoing cascade animation OR popup-blocked${mergedHint}. Consider longer wait between spins or relax the spin-count assertion.`);
  } else if (collectedSpins.length > expectedSpins && expectedSpins > 0) {
    warnings.push(`captured ${collectedSpins.length} spins but action list had ${expectedSpins} — autoplay or extra responses`);
  }

  // Use LAST ROUND-END spin as the representative spin. Using the raw last
  // captured frame can pick a non-terminal/cascade frame where `bet` semantics
  // differ, causing false balance-conservation fails (often off by exactly bet).
  // Full list still goes to collector-based assertions.
  const roundEndSpins = getRoundEndSpinsImpl(collectedSpins as unknown as Record<string, unknown>[]) as unknown as NormalizedSpinResult[];
  const spin = roundEndSpins.length > 0
    ? roundEndSpins[roundEndSpins.length - 1]!
    : (collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1]! : null);
  // A case "expects spins" only when its action list actually contains spin
  // actions OR its assertion text references spin collector data. UI-only
  // cases (info popup browsing, settings tour, paytable inspection) don't
  // expect any spin response — failing them on "no spin captured" is wrong.
  const caseExpectsSpin =
    input.actions.some((a) => a.kind === "spin") ||
    (input.custom_assertions ?? []).some((a) => /\bcollector\.spins\.length\b/.test(a.check_code) && !/=== ?0\b/.test(a.check_code))
    || (input.custom_assertions ?? []).some((a) => /collector\.spins\.\w+\(/.test(a.check_code) && !/\.length === 0\b/.test(a.check_code));
  if (!spin && caseExpectsSpin) {
    // Diagnostic: which stage dropped responses?
    if (urlsSeen > 0) {
      warnings.push(`network diagnostics: ${urlsSeen} responses seen, ${urlsAfterPreFilter} passed URL filter, ${parserRejected} rejected by parser, ${parserThrew} parser threw, ${dedupSwallowed} dedup-merged`);
      if (sampleRejectedUrls.length > 0) {
        warnings.push(`sample parser-rejected URLs: ${sampleRejectedUrls.join(" | ")}`);
      }
      if (sampleThrownErrors.length > 0) {
        warnings.push(`sample parser errors: ${sampleThrownErrors.join(" | ")}`);
      }
      if (urlsAfterPreFilter === 0 && positiveUrlHint) {
        warnings.push(`positive URL hint "${positiveUrlHint}" matched 0 responses — api-mapping may be stale`);
      }
      if (urlsAfterPreFilter > 0 && parserRejected === urlsAfterPreFilter) {
        warnings.push(`parser rejected ALL ${parserRejected} candidates — provider spec may be wrong (urlPatterns / shapeScore)`);
      }
      if (dedupSwallowed > 0 && collectedSpins.length === 0) {
        warnings.push(`${dedupSwallowed} responses parsed but dedup merged them all — roundId may not be unique`);
      }
    } else {
      warnings.push(`network diagnostics: 0 responses seen on page — spin click may not be hitting the right target`);
    }
    const screenshotPath = await captureCaseScreenshot(ctx.page, ctx.gameSlug, input.id) ?? undefined;
    await stopVideo();
    await closeExternalTabs();
    return {
      ...base,
      status: "fail",
      actionsExecuted,
      skipReason: "no spin response captured within timeout",
      durationMs: Date.now() - start,
      screenshotPath,
      videoPath,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Pre-check: did the SETUP actions actually reach the expected state?
  const precheckAssertions = runPrechecks(spin, input.custom_assertions ?? [], input.actions);

  // Gap A — Stable-region OCR for balance widget (+ bet / win, Tier-A A3).
  // Adds the `ui_ocr` signal to multi-signal verification and populates
  // `screen.balance/bet/last_win` so per-category assertion templates
  // (bet_boundary, ui_consistency) can null-guard-then-compare.
  // Skip silently when a region is undefined or OCR fails — confidence stays
  // at whatever other signals provide.
  let ocrBalance: number | undefined;
  let ocrBet: number | undefined;
  let ocrLastWin: number | undefined;
  const ocrSnapshots: OcrSnapshot[] = [];
  if (ctx.gameSlug) {
    try {
      const regions = await ocrRegions.load(ctx.gameSlug);
      // Helper to OCR + parse a region, logging BOTH success and failure so
      // QA can debug silent parse failures (OCR text returned but couldn't
      // be parsed to a number — common when bbox is too tight or Tesseract
      // garbles long digit sequences). Persists the raw text + parsed value
      // + bbox + cropped PNG into ocrSnapshots[] so the dashboard can show
      // visual evidence even when the assertion silently null-guard-passed.
      const evidenceDir = ctx.gameSlug ? path.join(dirForGame(ctx.gameSlug), "case-evidence") : null;
      if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
      const safeCaseName = input.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const tryOcr = async (
        label: "balance" | "bet" | "last_win",
        snapshotLabel: OcrSnapshot["region"],
        region: { x: number; y: number; width: number; height: number },
      ): Promise<number | undefined> => {
        const ocr = await ocrRegion(ctx.page, { x: region.x, y: region.y, w: region.width, h: region.height });
        const parsed = parseNumericFromOcr(ocr.text);
        // Persist the crop PNG so dashboard can show what Tesseract saw.
        let bboxScreenshotPath: string | undefined;
        if (evidenceDir && ocr.imageBuf) {
          try {
            const pngFile = path.join(evidenceDir, `${safeCaseName}.${snapshotLabel}.png`);
            await writeFile(pngFile, ocr.imageBuf);
            bboxScreenshotPath = path.relative(process.cwd(), pngFile);
          } catch (err) {
            console.warn(`[case-action] ${label} crop PNG write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        ocrSnapshots.push({
          region: snapshotLabel,
          bbox: { x: region.x, y: region.y, width: region.width, height: region.height },
          text: ocr.text.slice(0, 200),
          parsed,
          durationMs: ocr.durationMs,
          bboxScreenshotPath,
        });
        if (typeof parsed === "number") {
          console.log(`[case-action] ${label} OCR: ✓ "${ocr.text.slice(0, 80)}" → ${parsed} (${ocr.durationMs}ms)`);
          return parsed;
        }
        // Special-case last_win: when OCR can't parse a number, the widget
        // is showing the IDLE state ("PLACE YOUR BETS", "TURBO", "$0.00", or
        // blank — all mean "no win to display"). Default to 0 because:
        //   - matches game semantics (no win = 0 win)
        //   - lets `screen.last_win === spin.win` match for non-winning spins
        //   - winning spins where OCR fails will still surface mismatch
        //     (0 != 2.5 → ui_ocr signal fails clearly)
        // OcrSnapshot keeps parsed=null so QA can still see raw text + reason.
        console.warn(
          `[case-action] ${label} OCR: ✗ parse failed; text="${ocr.text.slice(0, 80).replace(/\n/g, " ")}" (${ocr.durationMs}ms)${label === "last_win" ? " — defaulting to 0 (idle widget)" : " — bbox may need redraw on dashboard"}`,
        );
        return label === "last_win" ? 0 : undefined;
      };
      if (regions?.balanceArea) ocrBalance = await tryOcr("balance", "balance", regions.balanceArea);
      if (regions?.betArea) ocrBet = await tryOcr("bet", "bet", regions.betArea);
      if (regions?.winArea) ocrLastWin = await tryOcr("last_win", "last_win", regions.winArea);
    } catch (err) {
      console.warn(`[case-action] OCR failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A3: stamp _ocrBalance onto the latest spin's raw so UiBalanceMatchesApiRule
  // (a Rule with synchronous interface and no Page access) can pick it up
  // during downstream evaluation. We mutate the spin's `raw` rather than
  // changing NormalizedSpinResult shape — raw is the existing escape hatch
  // for parser-adjacent metadata. Underscore prefix marks it as
  // pipeline-internal (not from server response).
  if (spin && typeof ocrBalance === "number") {
    (spin.raw as Record<string, unknown>)._ocrBalance = ocrBalance;
  }

  // Synthesize stateTimeline entries for buy-feature → FS chain BEFORE
  // assertions evaluate (2026-05-26: moved here from after assertions —
  // previously catalog assertion `stateTimeline.some(t => /FREE_SPIN/i)`
  // ran against empty timeline and failed even when FS chain happened).
  //
  // State observer fires BEFORE each `spin` action; buy-feature cases have
  // NO explicit spin actions (buy click implicitly triggers spins), so the
  // observer never runs → stateTimeline empty. But FS frames DID happen —
  // we captured `isFreeSpin === true` spins (post-parser-patch re-eval) OR
  // `freeSpinsRemaining > 0` raw from PP `fs` field.
  const hasFsSpinsForSynth = collectedSpins.some((s) =>
    s.isFreeSpin === true || (s.freeSpinsRemaining ?? 0) > 0,
  );
  const hasBuyFeatureWarningForSynth = warnings.some((w) => /buy-feature detected/i.test(w));
  const stateTimelineHadFsForSynth = stateTimeline.some((t) => /FREE_SPIN|BONUS/i.test(t.to));
  if (hasFsSpinsForSynth && !stateTimelineHadFsForSynth) {
    const synthNow = new Date().toISOString();
    if (hasBuyFeatureWarningForSynth) {
      stateTimeline.push({ at: synthNow, from: "MAIN", to: "FREE_SPIN_TRIGGERED", via: "synth-buy-feature-detected" });
    }
    stateTimeline.push({ at: synthNow, from: hasBuyFeatureWarningForSynth ? "FREE_SPIN_TRIGGERED" : "MAIN", to: "FREE_SPIN", via: "synth-from-isFreeSpin-frames" });
    const synthLastSpin = collectedSpins[collectedSpins.length - 1];
    if (synthLastSpin && !synthLastSpin.isFreeSpin) {
      stateTimeline.push({ at: synthNow, from: "FREE_SPIN", to: "MAIN", via: "synth-chain-completed" });
    }
    console.log(`[case-action] synthesized state timeline entries (pre-assertion): FS chain captured → injected synthetic states`);
  }

  // Evaluate assertions with ALL collected spins (autoplay/cascade) in
  // collector. Single-spin cases work too (collector has 1 entry).
  const userAssertions = evaluateAssertions(spin, collectedSpins, input.custom_assertions ?? [], {
    minimumEvidence: input.minimum_evidence,
    ocrBalance,
    ocrBet,
    ocrLastWin,
    // Phase 11.2 — expose runtime artifacts so assertions can check
    // setup behavior, state transitions, and engine warnings.
    stateTimeline,
    warnings,
    interrupts: {
      count: interruptsHandledCount,
      handled: stateTimeline
        .filter((t) => t.via && /handler|interrupt/i.test(t.via))
        .map((t) => `${t.from ?? "?"}→${t.to}`),
    },
    // Top-level `balanceBefore` bound into custom assertions (e.g. cumulative
    // balance conservation). MUST match the first captured spin's balanceBefore
    // — the same value the per-spin chain + detail panel reconcile against —
    // else the cumulative assertion fails by ~bet even when arithmetic is
    // correct. Prefer the first spin's recorded balanceBefore, then the LIVE
    // pre-spin capture, then the (possibly stale) priorBalance snapshot.
    balanceBefore:
      collectedSpins[0]?.balanceBefore ?? balanceBeforeFirstSpin ?? ctx.priorBalance ?? null,
    payoutModel: ctx.payoutModel,
  });

  // Synthetic UI assertions for UI-only cases (Phase 10.1 — heuristic).
  // Drive confidence by pairing pixel-diff (screenshot signal) with the
  // observed state-machine state (state signal). Cheap to compute; runs
  // ONLY when the case never expected a spin AND has a recognizable
  // open/close popup pattern in its action plan.
  const syntheticUiAssertions: AssertionResult[] = [];
  if (isUiOnlyCase && uiBaselineShot) {
    console.log(`[ui-assert] === synthetic UI assertion block START ===`);
    try {
      uiFinalShot = await ctx.page.screenshot({ type: "png", fullPage: false });
      console.log(`[ui-assert] final-shot captured (${uiFinalShot.length} bytes)`);
    } catch (err) {
      console.warn(`[ui-assert] final-shot capture FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const { decodePng, pixelDiff } = await import("../utils/pixel-diff/diff.js");
      const baselinePng = decodePng(uiBaselineShot);
      console.log(`[ui-assert] baseline decoded: ${baselinePng.width}x${baselinePng.height}`);
      // Open-popup threshold: low because popup covers a large area; idle
      // animation noise is well below 1%.
      const POPUP_OPEN_THRESHOLD = 0.01;
      // Return-to-main threshold: slot games run continuous idle animations
      // (background art, particle FX, mascot bounce, reel idle). Two
      // screenshots taken seconds apart on the MAIN screen can easily diff
      // 5-15% from animation frame alone. Use 25% — enough headroom for
      // idle motion but still flags a popup that's still visible (~40%+).
      const RETURN_THRESHOLD = 0.25;

      if (uiMidShot) {
        const midDiff = pixelDiff(baselinePng, decodePng(uiMidShot));
        const opened = midDiff.ratio > POPUP_OPEN_THRESHOLD;
        console.log(`[ui-assert] [_auto_screen_changed_after_open] pixelDiff(baseline,mid) ratio=${(midDiff.ratio*100).toFixed(3)}% (${midDiff.diffPixels}/${midDiff.totalPixels} pixels) → threshold=${(POPUP_OPEN_THRESHOLD*100).toFixed(2)}% → opened=${opened}`);
        const sigMap: import("./evidence/index.js").Signals = {
          screenshot: opened,
          rule: opened,
        };
        const calc = calcConfidence({ signals: sigMap, booleanVerdict: opened });
        syntheticUiAssertions.push({
          id: "_auto_screen_changed_after_open",
          description: `Screen visually changes after opening UI popup (pixel diff ${(midDiff.ratio * 100).toFixed(2)}% > ${POPUP_OPEN_THRESHOLD * 100}%)`,
          pass: opened,
          outcome: calc.outcome,
          confidence: calc.confidence,
          signals: buildSignalEvidence(sigMap, {
            screenshot: { source: "page.screenshot()", observed: `diffRatio=${midDiff.ratio.toFixed(4)}`, expected: `>${POPUP_OPEN_THRESHOLD}` },
            rule: { source: "pixel-diff-rule", observed: opened ? "popup-opened" : "no-change" },
          }),
        });
      }

      if (uiFinalShot && !endsOnReopen) {
        const finalDiff = pixelDiff(baselinePng, decodePng(uiFinalShot));
        const returned = finalDiff.ratio < RETURN_THRESHOLD;
        console.log(`[ui-assert] [_auto_returned_to_main_after_close] pixelDiff(baseline,final) ratio=${(finalDiff.ratio*100).toFixed(3)}% (${finalDiff.diffPixels}/${finalDiff.totalPixels} pixels) → threshold<${(RETURN_THRESHOLD*100).toFixed(2)}% → returned=${returned}`);
        // Observe state — strong confirmation we're back on main.
        let onMain = false;
        let observedState = "?";
        try {
          const { observeState } = await import("./state-observer.js");
          const obs = await observeState(ctx.page, {
            interstitialKeywords: popupKeywords.interstitial,
            substateKeywords: popupKeywords.substate,
            lastSpin: collectedSpins.length > 0 ? collectedSpins[collectedSpins.length - 1] : null,
          });
          onMain = obs.state === "MAIN";
          observedState = obs.state;
          console.log(`[ui-assert] observeState → state=${obs.state} confidence=${obs.confidence.toFixed(2)} onMain=${onMain}`);
        } catch (err) {
          console.warn(`[ui-assert] observeState FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
        // State is authoritative — observeState combines OCR + dark overlay
        // detection and is the source of truth for "are we on MAIN". The
        // pixel-diff signal only CORROBORATES (adds confidence) but cannot
        // veto the verdict on its own. Earlier draft required both, which
        // failed pixel-diff=6% cases even when state=MAIN (idle animation
        // pushes diff above threshold without indicating a real popup).
        const sigMap: import("./evidence/index.js").Signals = {
          screenshot: returned,
          state: onMain,
          rule: onMain,
        };
        const finalPass = onMain;
        const calc = calcConfidence({ signals: sigMap, booleanVerdict: finalPass });
        syntheticUiAssertions.push({
          id: "_auto_returned_to_main_after_close",
          description: `State observer reports MAIN after closing popup (pixel diff ${(finalDiff.ratio * 100).toFixed(2)}% vs baseline, state=${observedState})`,
          pass: finalPass,
          outcome: calc.outcome,
          confidence: calc.confidence,
          signals: buildSignalEvidence(sigMap, {
            screenshot: { source: "page.screenshot()", observed: `diffRatio=${finalDiff.ratio.toFixed(4)}`, expected: `<${RETURN_THRESHOLD}` },
            state: { source: "state-observer", observed: onMain ? "MAIN" : "non-MAIN", expected: "MAIN" },
            rule: { source: "return-to-main-rule", observed: finalPass ? "ok" : "off" },
          }),
        });
      }
    } catch (err) {
      console.warn(`[ui-assert] synthetic UI assertion BLOCK failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`[ui-assert] === synthetic UI assertion block END (${syntheticUiAssertions.length} synthetic assertion(s) added) ===`);
  } else if (isUiOnlyCase && !uiBaselineShot) {
    console.warn(`[ui-assert] SKIPPED — isUiOnlyCase=true but no baseline screenshot (capture failed earlier)`);
  } else if (!isUiOnlyCase) {
    console.log(`[ui-assert] not a UI-only case — no synthetic UI assertions injected`);
  }

  // Phase 11.5 — extended synthetic assertion injection. Auto-emit cheap
  // diagnostic checks based on case shape so QA gets multi-aspect coverage
  // even when the AI-generated catalog only has 1-2 surface assertions.
  // Each synthetic emits its own signal evidence so confidence reflects the
  // additional cross-checks.
  const syntheticExtraAssertions: AssertionResult[] = [];
  const explicitSpinActionCount = input.actions.filter((a) => a.kind === "spin").length;
  const setupBlob = `${input.id} ${input.name} ${(input.custom_assertions ?? []).map((a) => `${a.id} ${a.description}`).join(" ")}`;
  const isBetBoundary = /\b(clamp|undershoot|overshoot|boundary|min_bet|max_bet|edge)\b/i.test(setupBlob);
  const isAutoplay = /\bautoplay\b/i.test(input.category) || /autoplay|autospin/i.test(setupBlob);
  const expectedSpinCount = deriveExpectedSpinCount({
    actions: input.actions,
    category: input.category,
    customAssertions: input.custom_assertions ?? [],
    setupBlob,
  });
  const isMultiSpin = expectedSpinCount >= 2;

  function pushSyntheticAssertion(opts: {
    id: string;
    description: string;
    pass: boolean;
    signalNames: Array<"api" | "network" | "rule" | "state" | "screenshot" | "ui_ocr" | "history">;
    detail?: string;
  }) {
    const signalMap: import("./evidence/index.js").Signals = Object.fromEntries(
      opts.signalNames.map((n) => [n, opts.pass]),
    );
    const calc = calcConfidence({ signals: signalMap, booleanVerdict: opts.pass });
    syntheticExtraAssertions.push({
      id: opts.id,
      description: opts.description,
      pass: opts.pass,
      outcome: calc.outcome,
      confidence: calc.confidence,
      signals: buildSignalEvidence(signalMap, {}),
      detail: opts.pass ? undefined : opts.detail,
    });
  }

  // bet-boundary cases: setup should NOT generate error/fail warnings; the
  // state machine should stay on MAIN throughout (no popup interrupting bet
  // adjustment).
  if (isBetBoundary) {
    const errWarnings = warnings.filter((w) => /\berror\b|\bfail(ed)?\b|exception|threw/i.test(w));
    pushSyntheticAssertion({
      id: "_auto_no_setup_errors",
      description: "Setup phase completed without engine errors or exceptions",
      pass: errWarnings.length === 0,
      signalNames: ["network", "rule"],
      detail: errWarnings.length > 0 ? `errors during setup: ${errWarnings.slice(0, 3).join(" | ")}` : undefined,
    });
    const offMain = stateTimeline.filter((t, i) => i > 0 && t.to !== "MAIN");
    pushSyntheticAssertion({
      id: "_auto_state_stable_during_setup",
      description: "Engine state remained MAIN throughout bet-boundary setup",
      pass: offMain.length === 0 || (input.allowed_interruptions?.length ?? 0) > 0,
      signalNames: ["state", "rule"],
      detail: offMain.length > 0 ? `non-MAIN transitions: ${offMain.map((t) => `${t.from ?? "?"}→${t.to}`).join(", ")}` : undefined,
    });
  }

  // autoplay cases: explicit no-debounced-spin check (cascade animation
  // dropping clicks is the most common autoplay failure mode).
  if (isAutoplay) {
    const debouncedWarn = warnings.filter((w) => /likely debounced|popup may have blocked|no spin.*response within|debounced by/i.test(w));
    pushSyntheticAssertion({
      id: "_auto_no_lost_spins",
      description: "No spin clicks reported as debounced or dropped during autoplay batch",
      pass: debouncedWarn.length === 0,
      signalNames: ["network", "rule"],
      detail: debouncedWarn.length > 0 ? `dropped-spin warnings: ${debouncedWarn.slice(0, 2).join(" | ")}` : undefined,
    });
  }

  // multi-spin cases: all captured round-ids unique (catches a rare
  // dedup-misfire that would otherwise be silent).
  if (isMultiSpin && collectedSpins.length >= 2) {
    const ids = collectedSpins.map((s) => s.roundId);
    const unique = new Set(ids);
    pushSyntheticAssertion({
      id: "_auto_round_ids_unique",
      description: `Every captured spin has a unique roundId (${ids.length} spins)`,
      pass: unique.size === ids.length,
      signalNames: ["api", "rule"],
      detail: unique.size !== ids.length ? `dup roundIds in: ${ids.join(", ")}` : undefined,
    });
  }

  // A3: UI balance cross-check. Fires only when we have both an OCR'd
  // balance for the current screen AND a parsed spin to compare against —
  // otherwise the rule is a silent no-op (see ui-rule.ts no-ocr-data branch).
  if (spin && typeof ocrBalance === "number") {
    const { UiBalanceMatchesApiRule } = await import("../step9-verify/ui-rule.js");
    const rule = new UiBalanceMatchesApiRule();
    const result = rule.check(spin, { previousBalance: null, previousState: null, roundIndex: 0 });
    pushSyntheticAssertion({
      id: "_auto_ui_balance_matches_api",
      description: "UI-displayed balance matches API-settled balance (OCR cross-check)",
      pass: result.pass,
      signalNames: ["ui_ocr", "api", "rule"],
      detail: result.detail,
    });
  }

  // Separate "diagnostics" (auto-injected synthetic checks like _precheck_bet)
  // from real assertions. Diagnostics surface root-cause hints for QA but
  // DON'T count toward pass/fail verdict — a precheck false-positive (vd
  // bet-variation-min where `betAmount < 100` regex-matches as expected
  // bet=100) used to flip the whole case to FAIL even though every real
  // assertion passed. Dashboard renders them in a separate Diagnostics
  // section so verdict + assertion list stay clean.
  const assertions = [...userAssertions, ...syntheticUiAssertions, ...syntheticExtraAssertions];
  const diagnostics = [...precheckAssertions];
  const allPass = assertions.every((a) => a.pass);
  // Capture screenshot for EVERY case so QA can review visual state
  // (pass or fail). 2026-05-25 evidence-pkg: previously fail-only.
  const screenshotPath = (await captureCaseScreenshot(ctx.page, ctx.gameSlug, input.id)) ?? undefined;

  // Evidence: persist network capture to disk as JSONL sibling of screenshot.
  // Also build a compact in-result summary so dashboard renders count + first
  // few rows without fetching the file.
  let networkLogPath: string | undefined;
  let networkSummary: CaseResult["networkSummary"] | undefined;
  if (ctx.gameSlug && networkLog.length > 0) {
    try {
      const dir = path.join(dirForGame(ctx.gameSlug), "case-evidence");
      await mkdir(dir, { recursive: true });
      const safeName = input.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dir, `${safeName}.network.jsonl`);
      const lines = networkLog.map((e) => JSON.stringify(e)).join("\n");
      await writeFile(file, lines + "\n", "utf8");
      networkLogPath = path.relative(process.cwd(), file);
    } catch (err) {
      console.warn(`[case-executor] network log write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    networkSummary = networkLog.slice(0, 20).map((e) => ({
      url: e.url,
      method: e.method,
      status: e.status,
      durationMs: e.durationMs,
      parsedAsSpin: e.parsedAsSpin,
    }));
  }

  // Evidence: parser diagnostic showing which formula the parser used + any
  // mismatch vs expected bet (registry betMultiplier).
  let parserDiagnostic: CaseResult["parserDiagnostic"];
  if (spin && firstSpinRequestBody) {
    const parserKind = (ctx.parser as { kind?: string }).kind ?? "?";
    const betMultiplier = (ctx.parser as { betMultiplier?: number }).betMultiplier;
    const mechanic = (ctx.parser as { mechanic?: string }).mechanic;
    parserDiagnostic = buildParserDiagnostic({
      parserKind,
      mechanic,
      betMultiplier,
      firstSpinRequestBody,
      parsedBet: spin.bet,
    });
  }

  // Synthesize stateTimeline entries for buy-feature → FS chain (2026-05-26).
  // The state-observer fires BEFORE each `spin` action; buy-feature cases have
  // NO explicit spin actions (the buy click implicitly triggers spins), so
  // the observer never runs → stateTimeline stays empty. But FS frames DID
  // happen — we captured `isFreeSpin === true` spins in the network listener.
  // Push synthetic transitions so catalog assertions like
  // `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))` pass when the
  // FS chain actually played out.
  // Synthesis of stateTimeline FS entries moved EARLIER (before
  // evaluateAssertions ~line 1192) so catalog assertions can see them.
  // The variables hasFsSpins / hasBuyFeatureWarning are re-derived below
  // for the Signal Roll-up's effectiveAllowedInterrupts computation.
  const hasFsSpins = collectedSpins.some((s) =>
    s.isFreeSpin === true || (s.freeSpinsRemaining ?? 0) > 0,
  );

  // Signal Roll-up — case-level 5-signal view (replaces per-assertion signal
  // decoration as the primary dashboard view). User-driven design 2026-05-25:
  // "each case checks 5 signals, each signal IS one assertion with concrete
  // field-by-field checks".
  //
  // Auto-extend allowedInterrupts for synthesized FS states (above) so the
  // State signal doesn't flag them as "unexpected non-MAIN". Catalog cases
  // that test buy-feature don't always include FREE_SPIN in their
  // allowed_interruptions list — but if FS actually fired (we captured frames),
  // the engine should give credit, not penalty.
  const effectiveAllowedInterrupts = [
    ...(input.allowed_interruptions ?? []),
    ...(hasFsSpins ? ["FREE_SPIN_TRIGGERED", "FREE_SPIN"] : []),
  ];
  const signalRollup = buildSignalRollup({
    spin,
    spins: collectedSpins,
    expectedSpinCount,
    ocrBalance,
    ocrBet,
    ocrLastWin,
    warnings,
    stateTimeline,
    allowedInterrupts: effectiveAllowedInterrupts,
  });

  // Phase 8 FLAKY auto-detection. Aggregate per-assertion outcomes → case
  // outcome. Append to history log. Then check FLAKY pattern across last K
  // runs — if disagreement, promote to FLAKY outcome.
  const { aggregateCaseOutcome, legacyStatusToOutcome } = await import("./evidence/index.js");
  const confidentAssertions = assertions.map((a) => ({
    id: a.id,
    description: a.description,
    pass: a.pass,
    outcome: a.outcome ?? legacyStatusToOutcome(a.pass ? "pass" : "fail"),
    confidence: a.confidence ?? (a.pass ? 0.5 : 0.5),
    signals: a.signals ?? [],
    detail: a.detail,
  }));
  const caseAggregate = aggregateCaseOutcome(confidentAssertions);
  // 2026-05-25: also compute outcome from Signal Roll-up — case taxonomy now
  // derives from signal weights, not per-assertion min. Picks the HIGHER of
  // the two outcomes (so a case that has weak business assertions but strong
  // signal coverage gets PASS_HIGH instead of PASS_LOW).
  const signalBasedOutcome = (() => {
    const conf = deriveCaseConfidenceFromRollup(signalRollup);
    if (allPass) {
      if (conf >= 0.85) return "PASS_HIGH" as const;
      if (conf >= 0.50) return "PASS_LOW" as const;
      return "INCONCLUSIVE" as const;
    }
    if (conf >= 0.85) return "FAIL_HIGH" as const;
    if (conf >= 0.50) return "FAIL_LOW" as const;
    return "INCONCLUSIVE" as const;
  })();
  // Override per-assertion-min outcome IF signal-based is stronger and matches
  // the pass/fail direction. Preserves NEEDS_REVIEW / INCONCLUSIVE as-is.
  let finalOutcome: import("./evidence/index.js").Outcome = caseAggregate.outcome;
  const aggrIsAmbiguous = caseAggregate.outcome === "NEEDS_REVIEW" || caseAggregate.outcome === "INCONCLUSIVE";
  if (!aggrIsAmbiguous) {
    // Both must agree on pass/fail direction
    const aggrIsPass = caseAggregate.outcome === "PASS_HIGH" || caseAggregate.outcome === "PASS_LOW";
    const signalIsPass = signalBasedOutcome === "PASS_HIGH" || signalBasedOutcome === "PASS_LOW";
    if (aggrIsPass === signalIsPass) {
      finalOutcome = signalBasedOutcome;
    }
  }

  // Promote PASS_HIGH/PASS_LOW → PASS_WITH_INTERRUPT when one or more
  // allowed interrupts were handled during the run. Signals to QA that the
  // case DID encounter randomness (free spin / big win / bonus) and the
  // adaptive runner recovered — not just a clean main-line pass. Helps
  // explain longer durations + interrupt timelines on the dashboard.
  if (
    interruptsHandledCount > 0
    && (finalOutcome === "PASS_HIGH" || finalOutcome === "PASS_LOW")
  ) {
    console.log(`[case-action] promoting outcome ${finalOutcome} → PASS_WITH_INTERRUPT (handled ${interruptsHandledCount} interrupt(s))`);
    finalOutcome = "PASS_WITH_INTERRUPT";
  }

  // Case-level confidence — derived from Signal Roll-up (2026-05-25 redesign).
  // Old formula was MIN of per-assertion confidences which made cases with
  // narrowly-scoped assertions (e.g. `warnings.filter(...)` = 30%) look like
  // PASS_LOW 30% despite all 5 signals passing. New formula = weighted sum
  // of passing signals → reflects Signal Roll-up directly.
  const signalConfidence = deriveCaseConfidenceFromRollup(signalRollup);

  // History popup verification (Loại 2). Fires per-case ONLY for cases whose
  // category matches /history/i. Opens in-game history popup, OCRs rows, and
  // matches against captured spins. Mismatches are surfaced via CaseResult
  // for dashboard + AI Review. Env QA_VERIFY_HISTORY=0 disables.
  let historyVerification: (HistoryVerifyResult & { mismatchesPath?: string }) | undefined;
  const shouldVerifyHistory =
    /history/i.test(input.category)
    && process.env.QA_VERIFY_HISTORY !== "0"
    && ctx.gameSlug
    && collectedSpins.length > 0;
  if (shouldVerifyHistory) {
    try {
      const safeId = input.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const evidenceDir = path.join(dirForGame(ctx.gameSlug!), "case-evidence");
      console.log(`[case-exec/history] category=${input.category} → opening in-game history popup for verification`);
      const verify = await verifyHistory(
        ctx.page,
        ctx.gameSlug!,
        ctx.uiMap,
        collectedSpins,
        { evidence: { dir: evidenceDir, baseName: safeId } },
      );
      console.log(
        `[case-exec/history] ok=${verify.ok} opened=${verify.opened} `
        + `rows=${verify.rowsCount} matched=${verify.matchedCount}/${verify.spinsCount} `
        + `mismatches=${verify.mismatches.length}`
        + (verify.reason ? ` reason=${verify.reason}` : ""),
      );
      // Persist mismatches JSON alongside the screenshot so dashboard +
      // AI Review can ingest evidence without re-running.
      let mismatchesRel: string | undefined;
      if (verify.opened) {
        try {
          const jsonPath = path.join(evidenceDir, `${safeId}.history.json`);
          const payload = {
            caseId: input.id,
            ranAt: new Date().toISOString(),
            ok: verify.ok,
            rowsCount: verify.rowsCount,
            spinsCount: verify.spinsCount,
            matchedCount: verify.matchedCount,
            mismatches: verify.mismatches,
            rows: verify.rows ?? [],
            screenshotPath: verify.screenshotPath,
          };
          await writeFile(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
          mismatchesRel = path.relative(process.cwd(), jsonPath);
        } catch (err) {
          console.warn(`[case-exec/history] mismatches JSON write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      historyVerification = { ...verify, mismatchesPath: mismatchesRel };
    } catch (err) {
      console.warn(`[case-exec/history] verify failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      warnings.push(`history-verify error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (ctx.gameSlug) {
    try {
      const { appendHistory, loadHistory, maybePromoteToFlaky } = await import("./history/index.js");
      const history = await loadHistory(ctx.gameSlug, input.id);
      finalOutcome = maybePromoteToFlaky(caseAggregate.outcome, history);
      await appendHistory(ctx.gameSlug, input.id, {
        ranAt: new Date().toISOString(),
        outcome: caseAggregate.outcome, // raw (pre-FLAKY promotion) for clean history
        confidence: signalConfidence,
        status: allPass ? "pass" : "fail",
        durationMs: Date.now() - start,
        spinsCount: collectedSpins.length,
        reason: !allPass ? assertions.find((a) => !a.pass)?.description : undefined,
      });
    } catch (err) {
      console.warn(`[case-history] append failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Stop video recording before assembling the final result so `videoPath`
  // is set when ffmpeg compose succeeded.
  await stopVideo();
    await closeExternalTabs();

  const result: CaseResult = {
    ...base,
    status: allPass ? "pass" : "fail",
    actionsExecuted,
    assertions,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    spin: spin
      ? {
          bet: spin.bet,
          win: spin.win,
          balanceBefore: spin.balanceBefore,
          balanceAfter: spin.balanceAfter,
          state: spin.state,
          roundId: spin.roundId,
        }
      : null,
    spinsCount: collectedSpins.length,
    spins: collectedSpins.length > 0
      ? collectedSpins.map((s) => ({
          bet: s.bet,
          win: s.win,
          balanceBefore: s.balanceBefore,
          balanceAfter: s.balanceAfter,
          state: s.state,
          roundId: s.roundId,
          isFreeSpin: s.isFreeSpin,
        }))
      : undefined,
    durationMs: Date.now() - start,
    screenshotPath,
    videoPath,
    ocrSnapshots: ocrSnapshots.length > 0 ? ocrSnapshots : undefined,
    actionLog: actionLog.length > 0 ? actionLog : undefined,
    signalRollup,
    networkLogPath,
    networkSummary,
    parserDiagnostic,
    warnings: warnings.length > 0 ? warnings : undefined,
    stateTimeline: stateTimeline.length > 1 ? stateTimeline : undefined,
    outcome: finalOutcome,
    confidence: signalConfidence,
    historyVerification,
  };

  // Server-side persist full CaseResult JSON so QA can review past runs
  // across browser sessions / devices. Dashboard's localStorage cache is
  // BROWSER-only; this is the authoritative backup. Written alongside the
  // screenshot + network.jsonl + bbox crops.
  if (ctx.gameSlug) {
    try {
      const dir = path.join(dirForGame(ctx.gameSlug), "case-evidence");
      await mkdir(dir, { recursive: true });
      const safeName = input.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dir, `${safeName}.result.json`);
      await writeFile(file, JSON.stringify(result, null, 2) + "\n", "utf8");
    } catch (err) {
      console.warn(`[case-executor] result JSON write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/** Pure derivation — how many spin responses should this case capture?
 *  Three shapes:
 *  1. Explicit `spin` actions in plan → count them
 *  2. Autoplay UI flow (PATH 2): no `spin` actions but category=autoplay (or
 *     setup mentions autoplay) → parse `collector.spins.length >= N` /
 *     `getRoundEndSpins(...).length >= N` from custom assertions
 *  3. `wait_until_no_spin_response` present → same as autoplay
 *  Falls back to 0 for UI-only cases. Exported for invariant tests. */
export function deriveExpectedSpinCount(input: {
  actions: ReadonlyArray<{ kind: string }>;
  category: string;
  customAssertions: ReadonlyArray<{ check_code: string }>;
  setupBlob: string;
}): number {
  const explicit = input.actions.filter((a) => a.kind === "spin").length;
  if (explicit > 0) return explicit;
  const hasAutoplayWait = input.actions.some((a) => a.kind === "wait_until_no_spin_response");
  const isAutoplay = /\bautoplay\b/i.test(input.category) || /autoplay|autospin/i.test(input.setupBlob);
  if (!isAutoplay && !hasAutoplayWait) return 0;
  const lenPattern = /(?:collector\.spins|getRoundEndSpins\(collector\.spins\))\.length\s*>=?\s*(\d+)/;
  let maxExpected = 0;
  for (const a of input.customAssertions) {
    const m = a.check_code.match(lenPattern);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > maxExpected) maxExpected = n;
    }
  }
  return maxExpected > 0 ? maxExpected : 1;
}

/** Resolve a spin's `balanceBefore` when the network response omitted it (PP
 *  spin responses have no `bb` field). For chained spins, the prior spin's
 *  `balanceAfter` is authoritative. For the FIRST spin, prefer the LIVE balance
 *  captured just before the spin fired over the stale `priorBalance` snapshot
 *  taken when the executor context was built — a multi-attempt retry loop reuses
 *  the same ctx, so `priorBalance` can be one (or more) bets behind reality,
 *  which made balance-conservation fail by ~bet. Pure; exported for tests. */
export function resolveSpinBalanceBefore(input: {
  priorSpins: ReadonlyArray<{ balanceAfter: number }>;
  liveBeforeFirstSpin: number | null;
  priorBalance: number | null | undefined;
}): number | null {
  if (input.priorSpins.length > 0) {
    const prev = input.priorSpins[input.priorSpins.length - 1]!.balanceAfter;
    return typeof prev === "number" ? prev : null;
  }
  const first = input.liveBeforeFirstSpin ?? input.priorBalance;
  return typeof first === "number" ? first : null;
}

/** Pure wait helper — polls a "last spin response at" getter every 500ms and
 *  returns once the gap reaches `quietMs` (or hard cap at `maxMs`). Extracted
 *  so invariant tests can exercise the timing logic without Playwright. */
export type WaitUntilNoSpinResponseOpts = {
  quietMs: number;
  maxMs: number;
  lastSpinResponseAt: () => number;
  spinResponseCount: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs?: number;
};

export type WaitUntilNoSpinResponseResult = {
  exitReason: "quiet" | "timeout";
  elapsedMs: number;
  spinsCapturedDuringWait: number;
  lastGapMs: number;
};

export async function waitUntilNoSpinResponse(
  opts: WaitUntilNoSpinResponseOpts,
): Promise<WaitUntilNoSpinResponseResult> {
  const poll = opts.pollIntervalMs ?? 500;
  const start = opts.now();
  const startCount = opts.spinResponseCount();
  let lastLoggedCount = startCount;
  while (opts.now() - start < opts.maxMs) {
    const gap = opts.now() - opts.lastSpinResponseAt();
    const captured = opts.spinResponseCount() - startCount;
    // Do not declare "quiet complete" before at least one new spin lands.
    // Otherwise, if action execution before this wait took > quietMs,
    // lastSpinResponseAt can be stale and the wait exits immediately.
    if (captured > 0 && gap >= opts.quietMs) {
      console.log(`[case-action]   quiet for ${gap}ms — captured ${captured} spin response(s) during wait; exiting after ${opts.now() - start}ms`);
      return { exitReason: "quiet", elapsedMs: opts.now() - start, spinsCapturedDuringWait: captured, lastGapMs: gap };
    }
    const curCount = opts.spinResponseCount();
    if (curCount - lastLoggedCount >= 5) {
      console.log(`[case-action]   progress: ${curCount - startCount} spins captured (elapsed ${opts.now() - start}ms, last spin ${gap}ms ago)`);
      lastLoggedCount = curCount;
    }
    await opts.sleep(poll);
  }
  const finalGap = opts.now() - opts.lastSpinResponseAt();
  const captured = opts.spinResponseCount() - startCount;
  console.warn(`[case-action] wait_until_no_spin_response: timeout after ${opts.maxMs}ms (captured ${captured} spins, last gap ${finalGap}ms)`);
  return { exitReason: "timeout", elapsedMs: opts.now() - start, spinsCapturedDuringWait: captured, lastGapMs: finalGap };
}

/** Find a bet-selector CHIP in the registry whose value matches `target`
 *  within tolerance. Chips are namespaced `<parent>__bet-<value>` where
 *  parent opens the bet selector popup (typically `bet_settings`,
 *  `betPlus`, or `betMinus`). Returns chip + parent + optional close
 *  button so set_bet_to_value can drive the full open→click→close flow.
 *
 *  Parent priority (when multiple parents have chips matching target):
 *    1. bet_settings  — dedicated selector, cleanest UX
 *    2. betPlus
 *    3. betMinus
 *    4. any other prefix
 *
 *  Returns null when no chip matches OR the parent key isn't in registry
 *  (corrupt registry — caller should fall back to ladder strategy). */
function findBetChip(
  registry: import("../registry/types.js").UiRegistry,
  target: number,
  tolerance: number,
): {
  parentKey: string;
  parent: import("../registry/types.js").UiElement;
  chipKey: string;
  chip: import("../registry/types.js").UiElement;
  closeKey?: string;
  closeButton?: import("../registry/types.js").UiElement;
} | null {
  // Collect all chips: key shape `<prefix>__bet-<number>` where number
  // is a valid float. Ignore deeper nesting (e.g. tab-inside-popup chips).
  const chipPattern = /^(.+)__bet-(\d+(?:\.\d+)?)$/;
  const candidates: Array<{ parentKey: string; chipKey: string; value: number; parent?: import("../registry/types.js").UiElement; chip: import("../registry/types.js").UiElement }> = [];
  for (const [key, el] of Object.entries(registry)) {
    if (!el) continue;
    const m = key.match(chipPattern);
    if (!m) continue;
    const parentKey = m[1]!;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (Math.abs(value - target) > tolerance) continue;
    candidates.push({
      parentKey,
      chipKey: key,
      value,
      parent: registry[parentKey],
      chip: el,
    });
  }
  if (candidates.length === 0) return null;
  // Prefer parents with `bet_settings` over `betPlus` / `betMinus` /
  // others. Ties broken by chip-value proximity (smaller diff first).
  const PARENT_PRIORITY: Record<string, number> = {
    bet_settings: 1,
    betPlus: 2,
    betMinus: 3,
  };
  candidates.sort((a, b) => {
    const pa = PARENT_PRIORITY[a.parentKey] ?? 99;
    const pb = PARENT_PRIORITY[b.parentKey] ?? 99;
    if (pa !== pb) return pa - pb;
    return Math.abs(a.value - target) - Math.abs(b.value - target);
  });
  const best = candidates.find((c) => c.parent);
  if (!best || !best.parent) return null;
  // Find a closeButton in the same namespace if present. Standard
  // convention discovered by graph-explorer: `<parent>__closeButton`.
  const closeKey = `${best.parentKey}__closeButton`;
  const closeButton = registry[closeKey];
  return {
    parentKey: best.parentKey,
    parent: best.parent,
    chipKey: best.chipKey,
    chip: best.chip,
    closeKey: closeButton ? closeKey : undefined,
    closeButton: closeButton ?? undefined,
  };
}

async function executeAction(
  action: CaseAction,
  ctx: CaseExecutorContext,
  timing?: { dismissPreWaitMs: number; dismissInterClickMs: number },
  betControls?: { minBetClicks: number; maxBetClicks: number; stepDelayMs: number },
  extras?: {
    /** Returns timestamp of last captured spin response (Date.now()). Used by
     *  wait_until_no_spin_response to detect autoplay quiet windows. */
    lastSpinResponseAt: () => number;
    /** Returns current count of distinct spin responses captured so far. */
    spinResponseCount: () => number;
  },
): Promise<void> {
  if (action.kind === "wait_ms") {
    console.log(`[case-action] wait_ms ${action.ms}`);
    await ctx.page.waitForTimeout(action.ms);
    return;
  }
  if (action.kind === "click") {
    const el = ctx.uiMap[action.uiKey];
    if (!el) throw new Error(`uiKey '${action.uiKey}' not in registry`);
    const times = action.times ?? 1;
    // Route to the right page: elements flagged `externalPage: true` were
    // discovered on a separate browser tab opened by their parent trigger.
    // Click them on the captured tab page; everything else goes to the
    // original game page. Helper returns the active page or null when no
    // tab is captured (logs warning + skips click in that case).
    const clickPage = el.externalPage
      ? (ctx.externalTabs && ctx.externalTabs.length > 0 ? ctx.externalTabs[ctx.externalTabs.length - 1] : null)
      : ctx.page;
    if (el.externalPage && !clickPage) {
      console.warn(`[case-action] click ${action.uiKey}: externalPage=true but no tab captured yet — skipping (was the parent trigger clicked?)`);
      return;
    }
    console.log(`[case-action] click ${action.uiKey} (${el.x},${el.y}) ×${times}${el.externalPage ? " [external tab]" : ""}${action.reason ? ` — ${action.reason}` : ""}`);
    for (let i = 0; i < times; i++) {
      await clickPage!.mouse.click(el.x, el.y);
      await clickPage!.waitForTimeout(150);
    }
    // Bet popup-open fallback: clicking betMinus when bet is already at min
    // (or betPlus at max) is a no-op because the button is DISABLED. For
    // single-click intents (times === 1, typically "open bet selection
    // popup"), also click the sibling button so whichever is enabled fires
    // and the popup actually opens. The popup choice afterward overrides
    // any unintended ±1 step from the sibling click, so net effect is safe.
    // Multi-click intents (times > 1, i.e. step the bet N times) skip this.
    if (times === 1 && (action.uiKey === "betMinus" || action.uiKey === "betPlus")) {
      const sibling = action.uiKey === "betMinus" ? "betPlus" : "betMinus";
      const siblingEl = ctx.uiMap[sibling];
      if (siblingEl) {
        console.log(`[case-action]   sibling-click ${sibling} (${siblingEl.x},${siblingEl.y}) — popup-open fallback in case ${action.uiKey} is disabled at bet edge`);
        await ctx.page.mouse.click(siblingEl.x, siblingEl.y);
        await ctx.page.waitForTimeout(150);
      }
    }
    return;
  }
  if (action.kind === "spin") {
    const sb = ctx.uiMap.spinButton;
    if (!sb) throw new Error("spinButton not in registry");
    console.log(`[case-action] spin click @ (${sb.x},${sb.y})`);
    await ctx.page.mouse.click(sb.x, sb.y);
    return;
  }
  if (action.kind === "ensure_ante_off") {
    // Idempotent ante-OFF enforcement. No-op when registry has no
    // anteButton (game without ante feature). Uses pixel-diff vs
    // baseline captured during Discover; clicks once + re-verifies
    // when drifted. Failure throws so the case fails fast — bet
    // semantics are wrong if ante slipped ON.
    if (!ctx.gameSlug || !ctx.uiMap.anteButton) {
      console.log(`[case-action] ensure_ante_off — SKIP (no anteButton in registry)`);
      return;
    }
    console.log(`[case-action] ensure_ante_off — preamble check (case=${ctx.gameSlug})`);
    const { ensureAnteOff } = await import("../step2-detect-ui/ante-normalize.js");
    const r = await ensureAnteOff(ctx.page, ctx.gameSlug, ctx.uiMap);
    if (!r.ok) {
      console.log(`[case-action] ensure_ante_off — ❌ FAIL: ${r.reason ?? "unknown"}`);
      throw new Error(`ensure_ante_off failed: ${r.reason ?? "unknown"} — bet semantics will be wrong; aborting case`);
    }
    console.log(`[case-action] ensure_ante_off — ✅ ${r.wasOff ? "already OFF" : `toggled ${r.toggledCount}× back to OFF`}`);
    return;
  }
  if (action.kind === "set_bet_to_min") {
    const minus = ctx.uiMap.betMinus;
    if (!minus) throw new Error("betMinus not in registry");
    const clicks = betControls?.minBetClicks ?? 20;
    const delay = betControls?.stepDelayMs ?? 80;
    console.log(`[case-action] set_bet_to_min — clicking betMinus ×${clicks} @ (${minus.x},${minus.y})`);
    for (let i = 0; i < clicks; i++) {
      await ctx.page.mouse.click(minus.x, minus.y);
      await ctx.page.waitForTimeout(delay);
    }
    return;
  }
  if (action.kind === "set_bet_to_max") {
    const plus = ctx.uiMap.betPlus;
    if (!plus) throw new Error("betPlus not in registry");
    const clicks = betControls?.maxBetClicks ?? 20;
    const delay = betControls?.stepDelayMs ?? 80;
    console.log(`[case-action] set_bet_to_max — clicking betPlus ×${clicks} @ (${plus.x},${plus.y})`);
    for (let i = 0; i < clicks; i++) {
      await ctx.page.mouse.click(plus.x, plus.y);
      await ctx.page.waitForTimeout(delay);
    }
    return;
  }
  // set_bet_to_value (2026-05-25) — OCR-verified bet navigation.
  // Replaces fragile hardcoded `click betMinus ×N` sequences that assume a
  // known starting bet. Reads the bet widget via OCR after each click and
  // stops as soon as the displayed value matches `target` within tolerance.
  //
  // Requires:
  //   - ocr-regions.json with betArea configured
  //   - betMinus and betPlus in ui-registry
  // Falls back to set_bet_to_min if betArea OCR missing — at least gets
  // to a known floor state.
  if (action.kind === "set_bet_to_value") {
    const target = action.value;
    const maxAttempts = action.maxAttempts ?? 30;
    const tolerance = 0.01;
    const minus = ctx.uiMap.betMinus;
    const plus = ctx.uiMap.betPlus;
    const delay = betControls?.stepDelayMs ?? 80;

    if (!minus || !plus) throw new Error("set_bet_to_value: betMinus + betPlus required in ui-registry");

    // ─── Strategy 1: direct chip click (popup-style games) ────────────
    // Many PP slots open a bet selector popup when clicking betPlus/Minus
    // (or a dedicated bet_settings button). The popup contains chips like
    // `<parent>__bet-2.80` — clicking ONE chip sets bet exactly. Much
    // more reliable than ladder + OCR for popup games:
    //   - no ladder traversal (1 click + close vs 30 clicks)
    //   - exact target value (no "stuck at ladder gap" guessing)
    //   - no OCR dependency
    //
    // Detection: scan registry for `<prefix>__bet-<n>` chip keys matching
    // target value within tolerance. Prefer dedicated `bet_settings`
    // parent over `betPlus`/`betMinus` when multiple match (some games
    // expose chips under all 3). Returns null when no chip found OR
    // chip's parent key isn't in registry — fall through to Strategy 2.
    const chipMatch = findBetChip(ctx.uiMap, target, tolerance);
    if (chipMatch) {
      console.log(`[case-action] set_bet_to_value ${target} — direct chip click via ${chipMatch.parentKey} → ${chipMatch.chipKey}`);
      try {
        // Click parent trigger to open the selector popup.
        await ctx.page.mouse.click(chipMatch.parent.x, chipMatch.parent.y);
        // Edge fallback: when parent is betMinus at min (or betPlus at max),
        // that button is disabled so the popup won't open. Click sibling too;
        // at most one of the pair is disabled, so one click always opens.
        if (chipMatch.parentKey === "betMinus" || chipMatch.parentKey === "betPlus") {
          const siblingKey = chipMatch.parentKey === "betMinus" ? "betPlus" : "betMinus";
          const sibling = ctx.uiMap[siblingKey];
          if (sibling) {
            await ctx.page.waitForTimeout(120);
            await ctx.page.mouse.click(sibling.x, sibling.y);
          }
        }
        await ctx.page.waitForTimeout(800); // popup render
        // Click the exact chip.
        await ctx.page.mouse.click(chipMatch.chip.x, chipMatch.chip.y);
        await ctx.page.waitForTimeout(400);
        // Dismiss popup. Prefer registered closeButton in same namespace
        // (cleaner UX); fall back to Escape (works on PP popups). NOTE
        // for vs20olympgate-style games where closeButton revertS the
        // candidate: chip click on PP usually commits IMMEDIATELY, so
        // close just dismisses the dialog, not the value. If a specific
        // game inverts this (close = cancel), QA must rely on Strategy 2.
        if (chipMatch.closeButton) {
          await ctx.page.mouse.click(chipMatch.closeButton.x, chipMatch.closeButton.y);
        } else {
          await ctx.page.keyboard.press("Escape");
        }
        await ctx.page.waitForTimeout(500);
        console.log(`[case-action] set_bet_to_value ${target} — chip click done (parent=${chipMatch.parentKey}, close=${chipMatch.closeButton ? "via " + chipMatch.closeKey : "via Escape"})`);
        return;
      } catch (err) {
        console.warn(`[case-action] set_bet_to_value ${target}: chip click path threw (${err instanceof Error ? err.message : String(err)}) — falling through to OCR ladder`);
        // Best-effort: try to dismiss any half-open popup before falling
        // through, so OCR-based ladder loop doesn't operate inside an
        // open popup.
        try { await ctx.page.keyboard.press("Escape"); await ctx.page.waitForTimeout(400); } catch { /* ignore */ }
      }
    } else {
      console.log(`[case-action] set_bet_to_value ${target} — no matching chip in registry; using OCR ladder strategy`);
    }

    // ─── Strategy 2: OCR-verified ladder loop ─────────────────────────
    // Direct-adjust games (no popup, betPlus/betMinus just nudges value)
    // OR popup games where target value isn't in the chip set fall here.
    // Reads bet OCR after each +/- click; stops when value matches target.
    // Need OCR betArea to verify; else fallback to set_bet_to_min behavior.
    if (!ctx.gameSlug) {
      console.warn(`[case-action] set_bet_to_value ${target}: no gameSlug — clicking betMinus 20× as fallback`);
      for (let i = 0; i < 20; i++) { await ctx.page.mouse.click(minus.x, minus.y); await ctx.page.waitForTimeout(delay); }
      return;
    }
    const { ocrRegions: ocrRegionsStore } = await import("../registry/ocr-regions.js");
    const regions = await ocrRegionsStore.load(ctx.gameSlug);
    if (!regions?.betArea) {
      console.warn(`[case-action] set_bet_to_value ${target}: no betArea in ocr-regions.json — clicking betMinus 20× as fallback`);
      for (let i = 0; i < 20; i++) { await ctx.page.mouse.click(minus.x, minus.y); await ctx.page.waitForTimeout(delay); }
      return;
    }

    const readBet = async (): Promise<number | null> => {
      try {
        const ocr = await ocrRegion(ctx.page, {
          x: regions.betArea!.x, y: regions.betArea!.y,
          w: regions.betArea!.width, h: regions.betArea!.height,
        });
        return parseNumericFromOcr(ocr.text);
      } catch { return null; }
    };

    console.log(`[case-action] set_bet_to_value ${target} — OCR-verified navigation (max ${maxAttempts} clicks)`);
    let attempts = 0;
    let lastBet: number | null = await readBet();
    if (lastBet === null) {
      console.warn(`[case-action] set_bet_to_value ${target}: initial bet OCR failed — clicking betMinus 20× as fallback`);
      for (let i = 0; i < 20; i++) { await ctx.page.mouse.click(minus.x, minus.y); await ctx.page.waitForTimeout(delay); }
      return;
    }
    while (attempts < maxAttempts) {
      if (Math.abs(lastBet - target) <= tolerance) {
        console.log(`[case-action] set_bet_to_value ${target} — landed in ${attempts} clicks (OCR=${lastBet})`);
        return;
      }
      const button = lastBet > target ? minus : plus;
      const direction = lastBet > target ? "betMinus" : "betPlus";
      await ctx.page.mouse.click(button.x, button.y);
      await ctx.page.waitForTimeout(delay);
      attempts++;
      const newBet = await readBet();
      if (newBet === null) {
        console.warn(`[case-action] set_bet_to_value: OCR read failed at attempt ${attempts}, retrying...`);
        await ctx.page.waitForTimeout(150);
        lastBet = await readBet() ?? lastBet;
        continue;
      }
      // Stuck at a ladder edge — clicking direction didn't change the value
      // for 3 consecutive attempts → bail out (can't reach target).
      if (Math.abs(newBet - lastBet) < tolerance) {
        const stuckRuns = 1; // initial stuck detection
        await ctx.page.mouse.click(button.x, button.y);
        await ctx.page.waitForTimeout(delay);
        const retry = await readBet();
        if (retry !== null && Math.abs(retry - lastBet) < tolerance) {
          console.warn(`[case-action] set_bet_to_value ${target}: stuck at ${lastBet} via ${direction} — bet ladder may not include ${target}, accepting current`);
          return;
        }
        attempts++;
        lastBet = retry ?? lastBet;
        continue;
      }
      lastBet = newBet;
    }
    console.warn(`[case-action] set_bet_to_value ${target}: exhausted ${maxAttempts} attempts, last OCR=${lastBet}`);
    return;
  }
  if (action.kind === "reset") {
    console.log(`[case-action] reset — page.reload`);
    await ctx.page.reload({ waitUntil: "load" });
    await ctx.page.waitForTimeout(2000);
    return;
  }
  // Gap D — Adaptive waits replacing fixed wait_ms. Each polls a predicate
  // every 500ms until satisfied or maxMs reached. Falls back to soft warn
  // (no throw) so flaky timings don't fail cases — caller can decide via
  // post-action assertions whether state is right.
  if (action.kind === "wait_until_state") {
    const max = action.maxMs ?? 30_000;
    const start = Date.now();
    console.log(`[case-action] wait_until_state ${action.state}${action.reason ? ` — ${action.reason}` : ""} (max ${max}ms)`);
    const { observeState } = await import("./state-observer.js");
    while (Date.now() - start < max) {
      const obs = await observeState(ctx.page);
      if (obs.state === action.state) {
        console.log(`[case-action] reached state=${action.state} in ${Date.now() - start}ms`);
        return;
      }
      await ctx.page.waitForTimeout(500);
    }
    console.warn(`[case-action] wait_until_state ${action.state}: timeout after ${max}ms`);
    return;
  }
  if (action.kind === "wait_until_network_idle") {
    const max = action.maxMs ?? 15_000;
    const idleMs = action.idleMs ?? 1500;
    console.log(`[case-action] wait_until_network_idle (idle ${idleMs}ms, max ${max}ms)`);
    try {
      await ctx.page.waitForLoadState("networkidle", { timeout: max });
    } catch {
      console.warn(`[case-action] wait_until_network_idle: timeout after ${max}ms`);
    }
    return;
  }
  if (action.kind === "wait_until_pixel_stable") {
    const max = action.maxMs ?? 30_000;
    const required = action.consecutiveStable ?? 3;
    console.log(`[case-action] wait_until_pixel_stable (${required} consecutive, max ${max}ms)`);
    try {
      const { waitUntilStable } = await import("../utils/pixel-diff/index.js");
      await waitUntilStable(ctx.page, {
        maxIterations: Math.floor(max / 500),
        changeThreshold: 0.005,
        consecutiveStable: required,
      });
    } catch (err) {
      console.warn(`[case-action] wait_until_pixel_stable failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (action.kind === "wait_until_no_spin_response") {
    const quietMs = action.quietMs ?? 5_000;
    const max = action.maxMs ?? 180_000;
    if (!extras) {
      console.warn(`[case-action] wait_until_no_spin_response: extras missing → fallback to wait_ms ${quietMs}`);
      await ctx.page.waitForTimeout(quietMs);
      return;
    }
    console.log(`[case-action] wait_until_no_spin_response (quiet ${quietMs}ms, max ${max}ms${action.reason ? ` — ${action.reason}` : ""})`);
    await waitUntilNoSpinResponse({
      quietMs,
      maxMs: max,
      lastSpinResponseAt: extras.lastSpinResponseAt,
      spinResponseCount: extras.spinResponseCount,
      sleep: (ms) => ctx.page.waitForTimeout(ms),
      now: () => Date.now(),
    });
    return;
  }
  if (action.kind === "dismiss") {
    // Wait for celebration/interstitial popup to fully appear (some games
    // stage animation: buy→spin→stop→celebration takes several seconds),
    // then click center 2x to dismiss "PRESS ANYWHERE TO CONTINUE" overlays.
    // Timings from timing-config.json per game (Phase 7.1E).
    const preWaitMs = timing?.dismissPreWaitMs ?? 10000;
    const interClickMs = timing?.dismissInterClickMs ?? 800;
    console.log(`[case-action] dismiss${action.reason ? ` — ${action.reason}` : ""} (${preWaitMs}ms wait + 2 clicks)`);
    const vp = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
    const cx = Math.round(vp.width / 2);
    const cy = Math.round(vp.height / 2);
    await ctx.page.waitForTimeout(preWaitMs);
    for (let i = 0; i < 2; i++) {
      try {
        await ctx.page.mouse.click(cx, cy);
      } catch {
        break;
      }
      await ctx.page.waitForTimeout(interClickMs);
    }
    return;
  }
}

async function captureSpinResponse(
  ctx: CaseExecutorContext,
  spinPromise: Promise<import("playwright").Response | null>,
): Promise<NormalizedSpinResult | null> {
  const res = await spinPromise;
  if (!res) return null;
  let body: string;
  try {
    body = await res.text();
  } catch {
    return null;
  }
  if (!ctx.parser.canParseResponse(body, res.url())) return null;
  // Pull matching request body for parseSpinPair (PP needs request to compute bet).
  const reqBody = res.request().postData() ?? null;
  try {
    const spin = ctx.parser.parseSpinPair
      ? ctx.parser.parseSpinPair(reqBody, body, res.url())
      : ctx.parser.parseResponse(body);
    // Fill missing startingBalance from prior tracked balance (e.g. doInit).
    // Without this, first spin has balanceBefore=null which breaks balance
    // conservation assertions. PP doSpin response doesn't carry startingBalance.
    if (spin && spin.balanceBefore === null && typeof ctx.priorBalance === "number") {
      spin.balanceBefore = ctx.priorBalance;
    }
    return spin;
  } catch {
    return null;
  }
}

/**
 * Pre-check synthetic assertions — run BEFORE user assertions to catch
 * setup-state mismatches (e.g. "bet should be 1.00 but captured 0.2" because
 * actions couldn't navigate the bet panel). Surfaces root cause clearly so
 * downstream assertion fails aren't mistaken for game bugs.
 *
 * Currently checks: expected bet value extracted from custom_assertions code.
 */
function runPrechecks(
  spin: NormalizedSpinResult | null,
  assertions: Array<{ id: string; description: string; check_code: string }>,
  actions: ReadonlyArray<CaseAction> = [],
): AssertionResult[] {
  const out: AssertionResult[] = [];
  // No spin captured (UI-only case) → no spin-derived prechecks apply.
  if (!spin) return out;

  // 1. Bet pre-check: scan assertions for `spin.betAmount` comparisons against
  //    a literal number. If found AND the case ACTUALLY attempted to change
  //    bet (has set_bet_to_* / click betMinus / click betPlus / click bet
  //    popup entries), verify captured bet matches → fail if not.
  //
  // 2026-05-25: when assertions reference a literal bet but actions DON'T
  //    include any bet-changing action, the AI catalog wrote an inappropriate
  //    bet assertion (e.g. menu-toggle test checking bet=0.5 even though
  //    case doesn't set bet). Skip precheck silently in that case — case
  //    didn't try to change bet, so failing precheck blames engine for
  //    catalog overreach. Surface this in a non-failing "skipped" entry
  //    so QA can see the catalog issue without blocking the case.
  const expectedBet = extractExpectedBetFromAssertions(assertions);
  if (expectedBet !== null) {
    const hasBetAdjustment = actions.some((a) =>
      a.kind === "set_bet_to_min" ||
      a.kind === "set_bet_to_max" ||
      a.kind === "set_bet_to_value" ||
      (a.kind === "click" && /bet(Minus|Plus|Amount-)/i.test(a.uiKey)),
    );
    if (!hasBetAdjustment) {
      out.push({
        id: "_precheck_bet",
        description: `Setup should have reached bet=${expectedBet} — SKIPPED (no bet-adjustment action in case)`,
        pass: true,
        detail: `Skipped: case actions don't include set_bet_to_* or betMinus/betPlus clicks, so bet inherits session state (captured=${spin.bet}). The assertion expecting bet=${expectedBet} is likely AI catalog overreach — re-translate this case if bet shouldn't matter for the test intent.`,
      });
    } else {
      const captured = spin.bet;
      const matches = Math.abs(captured - expectedBet) <= 0.01;
      out.push({
        id: "_precheck_bet",
        description: `Setup should have reached bet=${expectedBet}`,
        pass: matches,
        detail: matches
          ? undefined
          : `Setup did NOT reach expected bet. Expected ${expectedBet}, captured ${captured} (delta ${(captured - expectedBet).toFixed(4)}). Likely cause: bet panel didn't open (already at min/max) OR action coords wrong. Check setup_instructions vs actual game behavior.`,
      });
    }
  }

  return out;
}

/**
 * Extract literal bet value from custom_assertions check_code. Looks for
 * EQUALITY patterns only (where the assertion pins bet to a target):
 *   spin.betAmount === 1.00
 *   Math.abs(spin.betAmount - 1.00) <= 0.01
 *   s.betAmount === 100 (inside collector.spins.every)
 * Returns first numeric literal found, or null.
 *
 * NOTE: Inequality patterns (< > <= >=) are INTENTIONALLY EXCLUDED.
 * Those are upper/lower BOUNDS (e.g. "betAmount < 100" = "bet should be
 * under 100"), not equality targets. Treating them as expected bet caused
 * false-positive precheck fails on min/max ladder tests like
 * `bet-variation-min` (assertion `spin.betAmount < 100` → precheck wrongly
 * expected bet=100 → failed because case correctly hit ladder min 0.2).
 */
function extractExpectedBetFromAssertions(
  assertions: Array<{ check_code: string }>,
): number | null {
  for (const a of assertions) {
    // Match EQUALITY patterns only. `spin.betAmount` or `s.betAmount`.
    const patterns: RegExp[] = [
      // Math.abs(spin.betAmount - X) — common pinning idiom in catalog AI.
      // Anchor with Math.abs so we don't match generic subtractions
      // (e.g. `endingBalance - spin.betAmount + winAmount`).
      /Math\.abs\(\s*(?:spin|s)\.betAmount\s*-\s*(\d+(?:\.\d+)?)/,
      // Strict / loose equality.
      /(?:spin|s)\.betAmount\s*===?\s*(\d+(?:\.\d+)?)/,
    ];
    for (const p of patterns) {
      const m = a.check_code.match(p);
      if (m) {
        const v = parseFloat(m[1]!);
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  }
  return null;
}

function evaluateAssertions(
  spin: NormalizedSpinResult | null,
  allSpins: NormalizedSpinResult[],
  assertions: Array<{ id: string; description: string; check_code: string }>,
  opts: {
    minimumEvidence?: import("./evidence/index.js").EvidenceRequirement;
    networkBalance?: number;
    /** OCR-read balance from balanceArea region (Gap A). When provided,
     *  multi-signal balance assertion gains a `ui_ocr` signal (+0.25 weight). */
    ocrBalance?: number;
    /** OCR-read current bet from betArea region (A3). Bound to `screen.bet`
     *  so bet_boundary assertions (`screen.bet === expected_bet`) actually
     *  have data to compare. */
    ocrBet?: number;
    /** OCR-read last/total win from winArea region (A3). Bound to
     *  `screen.last_win`. */
    ocrLastWin?: number;
    /** Phase 11.2 — engine state timeline observed during the run. Exposed
     *  to assertions so they can verify "stayed on MAIN" / "free spin happened". */
    stateTimeline?: Array<{ at: string; from?: string; to: string; via?: string }>;
    /** Phase 11.2 — non-fatal warnings emitted during run. Lets assertions
     *  check "no setup errors" / "no debounced clicks". */
    warnings?: string[];
    /** Phase 11.2 — count + list of interrupts the engine handled (free-spin,
     *  big-win, bonus). */
    interrupts?: { count: number; handled: string[] };
    /** Phase 11.2 — wallet balance BEFORE the test's first spin (from priorBalance).
     *  Needed by detectBuyFeatureDeduction. */
    balanceBefore?: number | null;
    /** Self-calibrated payout model — bound into `payoutModelCheck(spin)`. */
    payoutModel?: import("../registry/types.js").PayoutModel | null;
  } = {},
): AssertionResult[] {
  const results: AssertionResult[] = [];
  // For UI-only cases (no spin captured) callers must still get a usable
  // collector + adapted spin so assertions like `collector.spins.length === 0`
  // can evaluate. An empty collector is a valid evidence state.
  const adapted = spin ? adaptSpinForLegacy(spin) : null;
  const collector = { spins: allSpins.length > 0 ? allSpins.map(adaptSpinForLegacy) : [] };

  // Phase 11.1 + 11.2 — bind ALL promised helpers + runtime artifacts.
  // Without these, assertions like `detectBuyFeatureDeduction(...)` or
  // `screen.balance` get silently skip-as-passed at runtime (false positive).
  // Helpers imported at module top.

  // OCR `screen` payload — null when no OCR was performed for this case.
  // Catalog tells AI to null-guard each field; we just expose what we have.
  // A3: `bet` and `last_win` now wired when ocrRegions.betArea / winArea
  // are configured per game in registry/ocr-regions.json.
  const screen = {
    balance: typeof opts.ocrBalance === "number" ? opts.ocrBalance : null,
    bet: typeof opts.ocrBet === "number" ? opts.ocrBet : null,
    last_win: typeof opts.ocrLastWin === "number" ? opts.ocrLastWin : null,
    total_win: null as number | null,
  };
  const stateTimeline = opts.stateTimeline ?? [];
  const warnings = opts.warnings ?? [];
  const interrupts = opts.interrupts ?? { count: 0, handled: [] };
  const balanceBefore = opts.balanceBefore ?? null;
  const networkBalance = typeof opts.networkBalance === "number" ? opts.networkBalance : null;
  const spinIndex = collector.spins.length > 0 ? collector.spins.length - 1 : 0;

  // Lazy-load multi-signal helpers (avoid hot path for unrelated assertions)
  let multiSignalCache: import("./evidence/balance-multi-signal.js").BalanceSignalsInput | null = null;

  for (const a of assertions) {
    try {
      // Sandbox covers all promised vars + runtime artifacts.
      // Order matters — must match the fn(...) call below.
      const fn = new Function(
        "spin",
        "previousSpin",
        "collector",
        "getRoundEndSpins",
        "getCurrentBalance",
        "detectBuyFeatureDeduction",
        "screen",
        "stateTimeline",
        "warnings",
        "interrupts",
        "balanceBefore",
        "networkBalance",
        "spinIndex",
        "sumWinBreakdown",
        "payoutModelCheck",
        `"use strict"; return (${a.check_code});`,
      );
      const value = fn(
        adapted,
        null,
        collector,
        getRoundEndSpinsImpl,
        getCurrentBalanceImpl,
        detectBuyFeatureDeductionImpl,
        screen,
        stateTimeline,
        warnings,
        interrupts,
        balanceBefore,
        networkBalance,
        spinIndex,
        sumWinBreakdownImpl,
        (s: Record<string, unknown>) => payoutModelCheckImpl(s, opts.payoutModel),
      );
      const pass = Boolean(value);

      // Phase 8.2 — attach multi-signal confidence to balance-related assertions.
      // Detect by id pattern OR check_code referencing balance fields. Other
      // assertions stay legacy (no confidence info).
      const isBalanceAssertion =
        /balance|reconcil|conserv/i.test(a.id) ||
        /balanceAfter|endingBalance|startingBalance/.test(a.check_code);

      let outcome: import("./evidence/index.js").Outcome | undefined;
      let confidence: number | undefined;
      let signals: import("./evidence/index.js").SignalEvidence[] | undefined;

      if (isBalanceAssertion && spin) {
        try {
          if (!multiSignalCache) {
            multiSignalCache = {
              spin,
              networkBalance: opts.networkBalance,
              ocrBalance: opts.ocrBalance,
              requirement: opts.minimumEvidence,
            };
          }
          const msResult = evaluateBalanceMultiSignal(multiSignalCache);
          outcome = msResult.outcome;
          confidence = msResult.confidence;
          signals = msResult.signals;
        } catch {
          // ignore multi-signal failure; fall through to legacy result
        }
      } else {
        // Phase 11.4 — Signal-aware multi-signal evaluation for ANY assertion.
        // Inspect the check_code text (via assertion-signals.ts) to figure out
        // which evidence sources the assertion actually consults, then attach
        // matching signals. The more independent sources the predicate
        // cross-checks, the higher the confidence (api+ui_ocr+state+network+rule = 1.0).
        const refs = detectAssertionSignals(a.check_code, {
          spinsCaptured: allSpins.length,
          hasOcrBalance: opts.ocrBalance != null,
          hasOcrBet: opts.ocrBet != null,
          hasOcrLastWin: opts.ocrLastWin != null,
        });
        const signalMap: import("./evidence/index.js").Signals = signalsFromRefs(refs, pass);
        const calc = calcConfidence({
          signals: signalMap,
          booleanVerdict: pass,
          requirement: opts.minimumEvidence,
        });
        outcome = calc.outcome;
        confidence = calc.confidence;
        signals = buildSignalEvidence(signalMap, {
          api: refs.api
            ? { source: "parser/captured-spin", observed: allSpins.length }
            : undefined,
          network: refs.network
            ? { source: "page.on(response)", observed: allSpins.length }
            : undefined,
          ui_ocr: refs.ui_ocr
            ? { source: "screen.ocr", observed: opts.ocrBalance ?? "<null>" }
            : undefined,
          state: refs.state
            ? { source: "stateTimeline/interrupts", observed: (opts.stateTimeline?.length ?? 0) + " transitions" }
            : undefined,
          rule: { source: `assertion:${a.id}`, observed: pass ? "predicate=true" : "predicate=false" },
        });
      }

      results.push({
        id: a.id,
        description: a.description,
        pass,
        detail: pass ? undefined : explainFailure(a.check_code, adapted, collector),
        outcome,
        confidence,
        signals,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Helpers not in our sandbox → skip-as-pass with note (out of scope).
      if (/is not defined/.test(msg)) {
        results.push({
          id: a.id,
          description: a.description,
          pass: true,
          detail: `skipped (unsupported helper): ${msg}`,
        });
      } else {
        results.push({ id: a.id, description: a.description, pass: false, detail: `eval error: ${msg}` });
      }
    }
  }
  return results;
}

/**
 * On assertion fail, produce a diagnostic detail string with:
 *   - All `spin.X` fields the check_code reads, dumped as `X=value`
 *   - If the check_code references `collector.spins`, dump cumulative stats:
 *     count, first.startingBalance, last.endingBalance, sumBet, sumWin,
 *     expected (first.start - sumBet + sumWin) vs actual (last.end), diff.
 *   - If the check_code is a `===`/`==` comparison, also eval LHS and RHS
 *     separately so user sees actual vs expected numbers.
 */
function explainFailure(
  code: string,
  spin: Record<string, unknown>,
  collector?: { spins: Record<string, unknown>[] },
): string {
  const parts: string[] = ["FAIL"];

  // Extract referenced spin.* fields
  const refs = new Set<string>();
  for (const m of code.matchAll(/\bspin\.(\w+)/g)) refs.add(m[1]!);
  if (refs.size > 0) {
    const dump = [...refs].map((k) => `${k}=${jsonShort(spin[k])}`).join(", ");
    parts.push(`spin: ${dump}`);
  }

  // Collector-based assertion (cumulative balance / total bet / etc.)
  if (collector && /\bcollector\.spins\b/.test(code)) {
    const spins = collector.spins;
    if (spins.length > 0) {
      const first = spins[0]!;
      const last = spins[spins.length - 1]!;
      const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
      const sumBet = spins.reduce((a, s) => a + num(s.betAmount), 0);
      const sumWin = spins.reduce((a, s) => a + num(s.winAmount), 0);
      const startBal = first.startingBalance;
      const endBal = num(last.endingBalance);
      parts.push(`collector: count=${spins.length}`);
      parts.push(`first.startingBalance=${jsonShort(startBal)}`);
      parts.push(`last.endingBalance=${jsonShort(endBal)}`);
      parts.push(`sumBet=${sumBet}`);
      parts.push(`sumWin=${sumWin}`);
      if (typeof startBal === "number") {
        const expected = startBal - sumBet + sumWin;
        const actualMinusExpected = endBal - expected;
        parts.push(`[all spins] expected (start − sumBet + sumWin) = ${expected}`);
        parts.push(`[all spins] diff (actual − expected) = ${actualMinusExpected}`);
      }
      // ROUND-END subset reconciliation — mirrors what reconciliation checks
      // ACTUALLY compute (`getRoundEndSpins(collector.spins)` + top-level
      // `balanceBefore` = first captured spin's startingBalance, and
      // `last` = last ROUND-END spin, NOT last spin overall). When this subset
      // differs from the all-spins view above, the assertion can FAIL even
      // though the all-spins diff reads 0 — which is exactly the confusing case.
      // Show both so QA sees which set the verdict came from.
      const usesRoundEnds = /getRoundEndSpins\s*\(/.test(code);
      let endRoundIds = new Set<unknown>();
      if (usesRoundEnds) {
        const ends = getRoundEndSpinsImpl(spins) as Record<string, unknown>[];
        endRoundIds = new Set(ends.map((s) => s.roundId));
        parts.push(`[round-end] count=${ends.length} (of ${spins.length} captured)`);
        if (ends.length > 0) {
          const lastEnd = ends[ends.length - 1]!;
          const sumBetE = ends.reduce((a, s) => a + num(s.betAmount), 0);
          const sumWinE = ends.reduce((a, s) => a + num(s.winAmount), 0);
          const endBalE = num(lastEnd.endingBalance);
          parts.push(`[round-end] balanceBefore=${jsonShort(startBal)}`);
          parts.push(`[round-end] last(round-end).endingBalance=${endBalE}`);
          parts.push(`[round-end] sumBet=${sumBetE}`);
          parts.push(`[round-end] sumWin=${sumWinE}`);
          if (typeof startBal === "number") {
            const expectedE = startBal - sumBetE + sumWinE;
            parts.push(`[round-end] expected (balanceBefore − sumBet + sumWin) = ${expectedE}`);
            parts.push(`[round-end] diff (actual − expected) = ${endBalE - expectedE}  ← this is what the check evaluates`);
          }
        }
      }
      // Per-spin breakdown (compact) to spot the misbehaving spin. No cap —
      // QA wants the whole batch (autoplay rounds can exceed any fixed limit).
      // `[end]` marks spins that getRoundEndSpins keeps (the subset reconciled).
      const rows = spins.map((s, i) => {
        const bb = num(s.startingBalance);
        const ba = num(s.endingBalance);
        const bet = num(s.betAmount);
        const win = num(s.winAmount);
        const drop = bb - ba;
        const expectedDrop = bet - win;
        const mismatch = Math.abs(drop - expectedDrop) > 0.01 ? " ⚠" : "";
        const endTag = usesRoundEnds ? (endRoundIds.has(s.roundId) ? " [end]" : " [·]") : "";
        return `#${i + 1} bet=${bet} win=${win} bb=${bb} ba=${ba} drop=${drop.toFixed(2)} expected=${expectedDrop.toFixed(2)}${mismatch}${endTag}`;
      });
      parts.push(`per-spin: ${rows.join(" | ")}`);
    }
  }

  // If outermost expression is `LHS === RHS` or `LHS == RHS`, eval both sides
  const hasBooleanChain = /\|\||&&/.test(code);
  const eqMatch = !hasBooleanChain
    ? code.match(/^\s*\(?\s*(.+?)\s*===?\s*(.+?)\s*\)?\s*$/s)
    : null;
  if (eqMatch) {
    try {
      const lhs = eqMatch[1]!;
      const rhs = eqMatch[2]!;
      const lhsFn = new Function("spin", `"use strict"; return (${lhs});`);
      const rhsFn = new Function("spin", `"use strict"; return (${rhs});`);
      const lhsVal = lhsFn(spin);
      const rhsVal = rhsFn(spin);
      parts.push(`actual (LHS) = ${jsonShort(lhsVal)}, expected (RHS) = ${jsonShort(rhsVal)}`);
      if (typeof lhsVal === "number" && typeof rhsVal === "number") {
        parts.push(`diff = ${lhsVal - rhsVal}`);
      }
    } catch {
      // Skip eval if syntax doesn't allow split
    }
  }

  return parts.join(" | ");
}

function jsonShort(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v.slice(0, 60));
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

// Per-case adapter for legacy assertion field names — delegates to the
// shared spin-adapter (single source of truth for aliases). Kept as a local
// re-export name to preserve call sites; consider direct import in future.
const adaptSpinForLegacy = adaptSpinForAssertions;

/** Action log helper: describe what this action targets in 1 short string
 *  for the dashboard column. Distinct from "kind" — e.g. kind=click + target=
 *  "spinButton" vs target="betPlus__betAmount-0.50". */
function describeActionTarget(action: CaseAction): string | undefined {
  switch (action.kind) {
    case "click": return action.uiKey;
    case "wait_ms": return `${action.ms}ms`;
    case "spin": return undefined;
    case "set_bet_to_value": return `${action.value}`;
    case "ensure_ante_off": return "anteButton";
    case "wait_until_state": return action.state;
    case "wait_until_network_idle": return action.idleMs ? `idle≥${action.idleMs}ms` : undefined;
    case "wait_until_pixel_stable": return action.consecutiveStable ? `stable=${action.consecutiveStable}` : undefined;
    default: return undefined;
  }
}

/**
 * Build a parser diagnostic from the first captured spin request body. Decodes
 * which formula the PragmaticParser-like logic would have used + flags
 * mismatch vs game-mechanics expected bet.
 *
 * Lets QA see "parser used c × l × (bl+1) → bet=0.20" without reading parser
 * source. Mirrors the unified PP formula in pragmatic-parser.ts.
 */
function buildParserDiagnostic(opts: {
  parserKind: string;
  mechanic?: string;
  betMultiplier?: number;
  firstSpinRequestBody?: string | null;
  parsedBet: number;
}): CaseResult["parserDiagnostic"] {
  const requestFields: Record<string, string | number | null> = {};
  if (opts.firstSpinRequestBody) {
    for (const pair of opts.firstSpinRequestBody.split("&")) {
      const [k, v] = pair.split("=");
      if (!k) continue;
      const decoded = decodeURIComponent(v ?? "");
      const n = Number(decoded);
      requestFields[k] = Number.isFinite(n) && /^-?\d+(?:\.\d+)?$/.test(decoded) ? n : (decoded || null);
    }
  }
  const c = typeof requestFields["c"] === "number" ? (requestFields["c"] as number) : 0;
  const bl = typeof requestFields["bl"] === "number" ? (requestFields["bl"] as number) : 0;
  const l = typeof requestFields["l"] === "number" ? (requestFields["l"] as number) : 0;
  // Replicate PP parser decision tree (see pragmatic-parser.ts ppBetFromRequest)
  let formulaUsed = "fallback 0";
  let expectedBet: number | undefined;
  const mechanic = (opts.mechanic ?? "").toLowerCase();
  if (c <= 0) {
    formulaUsed = "no `c` in request — parser cannot compute";
  } else if (mechanic === "lines") {
    if (bl > 0) { formulaUsed = `c × bl = ${c} × ${bl}  [mechanic=lines, bet-level mode]`; expectedBet = c * bl; }
    else if (l > 0) { formulaUsed = `c × l = ${c} × ${l}  [mechanic=lines, lines mode]`; expectedBet = c * l; }
  } else if (typeof opts.betMultiplier === "number" && opts.betMultiplier > 0) {
    formulaUsed = `c × M = ${c} × ${opts.betMultiplier}  [mechanic=${opts.mechanic ?? "unknown"}, M from game-mechanics]`;
    expectedBet = c * opts.betMultiplier;
  } else if (bl > 0) {
    formulaUsed = `c × bl = ${c} × ${bl}  [fallback, no mechanic/M]`;
    expectedBet = c * bl;
  } else if (l > 0) {
    formulaUsed = `c × l = ${c} × ${l}  [fallback, no mechanic/M]`;
    expectedBet = c * l;
  }
  return {
    parserKind: opts.parserKind,
    mechanic: opts.mechanic,
    betMultiplier: opts.betMultiplier,
    requestFields,
    formulaUsed,
    parsedBet: opts.parsedBet,
    expectedBet,
    mismatch: typeof expectedBet === "number"
      ? Math.abs(opts.parsedBet - expectedBet) > 0.01
      : opts.parsedBet === 0 && c > 0, // c was provided but bet still 0 → suspect
  };
}

/**
 * Build the case-level signal roll-up — 5 evidence-dimension verdicts with
 * field-by-field sub-checks. User-driven design (2026-05-25): "each case
 * checks 5 signals, each signal IS one assertion with concrete checks".
 *
 * Replaces the prior model (5 signals decorating each business assertion).
 * Business assertions still run separately and stay in CaseResult.assertions
 * for AI-catalog-level drill-down.
 *
 * Each signal computes pass/fail from its own data sources:
 *   - api      : spin response fields look valid (bet+win+balance all sane)
 *   - ui_ocr   : OCR'd UI widgets match API for each configured region
 *   - network  : no error warnings, captured spin count >= expected
 *   - state    : state timeline stayed on expected path
 *   - rule     : balance arithmetic holds
 *
 * A signal with no data (e.g. ui_ocr when no ocr-regions configured) returns
 * `{pass: true, checks: [], detail: "no-data"}` — silent no-op, not failure.
 */
function buildSignalRollup(opts: {
  spin: NormalizedSpinResult | null;
  spins: NormalizedSpinResult[];
  expectedSpinCount: number;
  ocrBalance?: number;
  ocrBet?: number;
  ocrLastWin?: number;
  warnings: string[];
  stateTimeline: Array<{ from?: string; to: string; via?: string }>;
  allowedInterrupts: string[];
}): SignalRollup[] {
  const out: SignalRollup[] = [];
  const TOL = 0.05;

  // ─── 1. API ────────────────────────────────────────────────────────────
  const apiChecks: SignalCheck[] = [];
  if (opts.spin) {
    const s = opts.spin;
    apiChecks.push({
      field: "spin captured",
      expected: "non-empty roundId",
      actual: s.roundId || "(empty)",
      match: Boolean(s.roundId),
      source: "parser/captured-spin",
    });
    apiChecks.push({
      field: "bet",
      // Bet expectation depends on spin state:
      //   - FREE_SPIN frame: bet=0 (server doesn't deduct during chain)
      //   - NORMAL spin: bet>0 (deduction applied)
      // Pre-fix this assumed bet>0 always → FS-ending cases failed even
      // though bet=0 is semantically correct for FS frames.
      expected: s.isFreeSpin ? "0 (FS — no deduction)" : "> 0 (bet was applied)",
      actual: s.bet,
      match: s.isFreeSpin
        ? typeof s.bet === "number" && s.bet === 0
        : typeof s.bet === "number" && s.bet > 0,
      source: "parser/spin.bet",
    });
    apiChecks.push({
      field: "win",
      expected: ">= 0 (non-negative)",
      actual: s.win,
      match: typeof s.win === "number" && Number.isFinite(s.win) && s.win >= 0,
      source: "parser/spin.win",
    });
    apiChecks.push({
      field: "balanceAfter",
      expected: "finite number",
      actual: s.balanceAfter,
      match: typeof s.balanceAfter === "number" && Number.isFinite(s.balanceAfter),
      source: "parser/spin.balanceAfter",
    });
  } else {
    apiChecks.push({
      field: "spin captured",
      expected: "at least 1 spin",
      actual: 0,
      match: opts.expectedSpinCount === 0,
      source: "parser/captured-spin",
      note: "no spin response captured during case",
    });
  }
  out.push({
    signal: "api",
    pass: apiChecks.every((c) => c.match),
    checks: apiChecks,
    detail: opts.spin ? undefined : "no spin captured — api signal cannot verify response fields",
  });

  // ─── 2. UI_OCR ─────────────────────────────────────────────────────────
  // Compare each OCR'd field against API. Skip the entire signal when no
  // OCR data was captured (silent no-op).
  const uiChecks: SignalCheck[] = [];
  if (opts.spin && typeof opts.ocrBalance === "number") {
    const diff = Math.abs(opts.ocrBalance - opts.spin.balanceAfter);
    uiChecks.push({
      field: "balance",
      expected: opts.spin.balanceAfter,
      actual: opts.ocrBalance,
      match: diff < TOL,
      source: "ocr/balanceArea ↔ parser/balanceAfter",
      note: diff >= TOL ? `diff=${diff.toFixed(3)} > tolerance ${TOL}` : undefined,
    });
  }
  if (opts.spin && typeof opts.ocrBet === "number") {
    // 2026-05-26: skip UI bet check during FS frames. UI bet widget shows
    // the player's SELECTED stake (e.g., 0.50) — doesn't change during FS
    // chain. spin.bet for FS is 0 (no actual deduction). Comparing UI=0.5
    // to API=0 always fails by exactly the stake amount → noise. The
    // meaningful check is for NORMAL spins where UI=API both reflect
    // actual deduction.
    if (opts.spin.isFreeSpin) {
      uiChecks.push({
        field: "bet",
        expected: "n/a (FS — UI shows stake choice, API shows deduction=0)",
        actual: opts.ocrBet,
        match: true,
        source: "ocr/betArea ↔ parser/spin.bet (skipped for FS)",
        note: "Different semantics: UI=stake, API=deduction. Comparison skipped.",
      });
    } else {
      const diff = Math.abs(opts.ocrBet - opts.spin.bet);
      uiChecks.push({
        field: "bet",
        expected: opts.spin.bet,
        actual: opts.ocrBet,
        match: diff < TOL,
        source: "ocr/betArea ↔ parser/spin.bet",
        note: diff >= TOL ? `diff=${diff.toFixed(3)} > tolerance ${TOL}` : undefined,
      });
    }
  }
  if (opts.spin && typeof opts.ocrLastWin === "number") {
    const diff = Math.abs(opts.ocrLastWin - opts.spin.win);
    uiChecks.push({
      field: "win",
      expected: opts.spin.win,
      actual: opts.ocrLastWin,
      match: diff < TOL,
      source: "ocr/winArea ↔ parser/spin.win",
      note: diff >= TOL ? `diff=${diff.toFixed(3)} > tolerance ${TOL}` : undefined,
    });
  }
  out.push({
    signal: "ui_ocr",
    pass: uiChecks.length === 0 ? true : uiChecks.every((c) => c.match),
    checks: uiChecks,
    detail: uiChecks.length === 0
      ? "no-data: no OCR regions configured for this game (configure on dashboard)"
      : uiChecks.every((c) => c.match)
        ? `${uiChecks.length}/${uiChecks.length} UI widgets match API`
        : `${uiChecks.filter((c) => c.match).length}/${uiChecks.length} UI widgets match API`,
  });

  // ─── 3. NETWORK ────────────────────────────────────────────────────────
  const errWarnings = opts.warnings.filter((w) => /\berror\b|\bfail(ed)?\b|exception|threw|debounced|popup may have blocked|no spin.*response within/i.test(w));
  // Buy-feature cases don't have explicit `spin` actions in the catalog (the
  // buy click triggers spins implicitly). 2026-05-26: detect via the warning
  // emitted by the post-action settle code when ratio >= 50. When detected,
  // expect spins ≥ 1 instead of the (wrong) "UI-only" classification.
  const hasBuyFeature = opts.warnings.some((w) => /buy-feature detected/i.test(w));
  // 2026-05-26: autoplay/UI-driven multi-spin cases (PATH 2) have 0 explicit
  // `spin` actions but DO expect spins — caller now passes the derived count.
  // Only label as "UI-only" when truly zero spins expected.
  const networkChecks: SignalCheck[] = [
    {
      field: "captured spins",
      expected: hasBuyFeature
        ? ">= 1 (buy-feature → FS chain)"
        : opts.expectedSpinCount === 0
          ? "0 (UI-only case)"
          : `>= ${opts.expectedSpinCount}`,
      actual: opts.spins.length,
      match: hasBuyFeature
        ? opts.spins.length >= 1
        : opts.expectedSpinCount === 0
          ? opts.spins.length === 0
          : opts.spins.length >= opts.expectedSpinCount,
      source: "page.on(response)",
      note: opts.expectedSpinCount > 0 && opts.spins.length < opts.expectedSpinCount
        ? `short by ${opts.expectedSpinCount - opts.spins.length}`
        : undefined,
    },
    {
      field: "no error warnings",
      expected: "0 errors/failures/debounced clicks",
      actual: errWarnings.length === 0 ? 0 : errWarnings.slice(0, 2).join(" | "),
      match: errWarnings.length === 0,
      source: "case-executor warnings",
      note: errWarnings.length > 0 ? `${errWarnings.length} warning(s)` : undefined,
    },
  ];
  out.push({
    signal: "network",
    pass: networkChecks.every((c) => c.match),
    checks: networkChecks,
  });

  // ─── 4. STATE ──────────────────────────────────────────────────────────
  const offMain = opts.stateTimeline
    .filter((t, i) => i > 0 && t.to !== "MAIN")
    .filter((t) => !opts.allowedInterrupts.includes(t.to));
  const stateChecks: SignalCheck[] = [];
  if (opts.stateTimeline.length === 0) {
    stateChecks.push({
      field: "state timeline",
      expected: "captured",
      actual: 0,
      match: true,
      source: "state-observer",
      note: "no observable transitions during case (single-spin / no popups)",
    });
  } else {
    stateChecks.push({
      field: "stayed on MAIN (or allowed interrupts)",
      expected: "all transitions to MAIN | allowed",
      actual: offMain.length === 0 ? "all clean" : offMain.map((t) => `${t.from ?? "?"}→${t.to}`).slice(0, 3).join(", "),
      match: offMain.length === 0,
      source: "stateTimeline",
      note: offMain.length > 0 ? `${offMain.length} unexpected non-MAIN transitions` : undefined,
    });
  }
  out.push({
    signal: "state",
    pass: stateChecks.every((c) => c.match),
    checks: stateChecks,
  });

  // ─── 5. RULE ───────────────────────────────────────────────────────────
  const ruleChecks: SignalCheck[] = [];
  if (opts.spin && opts.spin.balanceBefore != null) {
    const s = opts.spin;
    const expected = s.isFreeSpin
      ? s.balanceBefore + s.win
      : s.balanceBefore - s.bet + s.win;
    const diff = Math.abs(expected - s.balanceAfter);
    ruleChecks.push({
      field: "balance arithmetic",
      expected: expected,
      actual: s.balanceAfter,
      match: diff < 0.01,
      source: "balanceAfter == balanceBefore - bet + win",
      note: diff >= 0.01 ? `diff=${diff.toFixed(3)} > 0.01 — server math off OR parser bet/win wrong` : undefined,
    });
  } else if (opts.spin) {
    ruleChecks.push({
      field: "balance arithmetic",
      expected: "skipped (no balanceBefore for first spin)",
      actual: "n/a",
      match: true,
      source: "balanceAfter == balanceBefore - bet + win",
      note: "first spin has no priorBalance — invariant skipped (per spec)",
    });
  } else {
    ruleChecks.push({
      field: "balance arithmetic",
      expected: "n/a (no spin captured)",
      actual: "n/a",
      match: true,
      source: "balanceAfter == balanceBefore - bet + win",
      note: "no spin captured",
    });
  }
  out.push({
    signal: "rule",
    pass: ruleChecks.every((c) => c.match),
    checks: ruleChecks,
  });

  return out;
}

/**
 * Case-level confidence derived from Signal Roll-up (2026-05-25 redesign).
 *
 * BEFORE: case confidence = MIN of per-assertion confidences. Problem: an
 * assertion that uses only 2 signals (e.g., `warnings.filter(...).length === 0`
 * gets network+rule = 0.30) drags the case down to 30% even when:
 *   - All assertions pass ✓
 *   - All 5 signals pass ✓
 *   - The case is a clean PASS_HIGH conceptually
 *
 * AFTER: case confidence = weighted sum of passing signals (out of total
 * possible weight). Each signal contributes its weight when pass=true.
 *
 * Example outputs:
 *   5/5 signals pass            → weight 1.00 → confidence 100% (PASS_HIGH)
 *   4/5 (only state fails)      → weight 0.90 → confidence 90% (PASS_HIGH)
 *   4/5 (only api fails)        → weight 0.65 → confidence 65% (PASS_LOW)
 *   3/5 (api + ui_ocr fail)     → weight 0.40 → confidence 40% (INCONCLUSIVE)
 *
 * Signal weights mirror DEFAULT_SIGNAL_WEIGHTS in evidence/types.ts:
 *   api 0.35 · ui_ocr 0.25 · rule 0.20 · network 0.10 · state 0.10 = 1.00
 */
function deriveCaseConfidenceFromRollup(rollup: SignalRollup[]): number {
  if (rollup.length === 0) return 0;
  const WEIGHTS: Record<SignalRollup["signal"], number> = {
    api: 0.35,
    ui_ocr: 0.25,
    rule: 0.20,
    network: 0.10,
    state: 0.10,
  };
  let passWeight = 0;
  let totalWeight = 0;
  for (const s of rollup) {
    const w = WEIGHTS[s.signal] ?? 0;
    totalWeight += w;
    if (s.pass) passWeight += w;
  }
  return totalWeight > 0 ? Math.min(1, passWeight / totalWeight) : 0;
}
