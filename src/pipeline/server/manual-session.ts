// Manual verify session — long-lived Playwright browser kept open between
// dashboard interactions. QA opens game → backend launches headed Chrome →
// QA verifies each UI element via dashboard commands → registry saved.
//
// One session at a time (singleton). Concurrent sessions would race over the
// shared registry file; restrict to single-QA for MVP.

import path from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { openBrowser, closeBrowser, type BrowserSession } from "../orchestrator/browser.js";
import { requestContext } from "../../server/request-context.js";
import { crawl, deriveGameRecordIdentity } from "../step1-crawl/crawler.js";
import { discoverUi } from "../step2-detect-ui/resolver.js";
import { resolveExpectedUiElements } from "../registry/expected-ui-elements.js";
import { aiRecoverLocator } from "../step2-detect-ui/ai-recover-locator.js";
import { aiDiscoverState } from "../step2-detect-ui/graph-explorer.js";
import { verifyElement, ELEMENT_VISUAL_CHECK } from "../step2-detect-ui/ai-vision-verify.js";
import { loadAiCatalog } from "../step7-testcase-gen/ai-catalog.js";
import {
  loadCache as loadActionsCache,
  saveCache as saveActionsCache,
  translateCase,
  buildAutoplayBatch,
  normalizeNestedUiActions,
} from "../step7-testcase-gen/case-action-translator.js";
import { executeAction, executeCase, type CaseResult } from "../step8-run-scenarios/case-executor.js";
import "../step6-build-model/index.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import { tryLoadProviderSpec } from "../step6-build-model/providers/spec-loader.js";
import { learnParserOverlayWithAi, detectFsCreditTiming } from "../step8-run-scenarios/spec-learner.js";
import { aiProposeWinItemization } from "../../ai/itemization-classifier.js";
import type { ReplaySample } from "../step8-run-scenarios/spec-replay-gate.js";
import { parserCache } from "../registry/parser-cache.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { initMeta, meta } from "../registry/meta.js";
import { providerCache } from "../registry/provider-cache.js";
import { gameSpecOverride, applyOverride, type GameSpecOverride } from "../registry/game-spec-override.js";
import { gameMechanics, deriveGameMechanics } from "../registry/game-mechanics.js";
import { payoutModel } from "../registry/payout-model.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { parseWlcV } from "../step6-build-model/win-breakdown.js";
import { derivePayoutModel, type CalibrationCombo } from "../../ai/payout-model-derive.js";
import { probeElement, inferProbeKind, type ProbeResult } from "../step2-detect-ui/element-probe.js";
import { verifyClickAgent } from "../../ai/verify-click-agent.js";
import { expectedBehaviorFor } from "../registry/expected-behavior.js";
import { exploreUiGraph, explainSafety } from "../step2-detect-ui/graph-explorer.js";
import { isSafeToClickForDiscovery } from "../step2-detect-ui/safe-click.js";
import { filterMainOverlap, buildMainElementsHint } from "../step2-detect-ui/popup-filter.js";
import { waitUntilStable } from "../utils/pixel-diff/index.js";
import { cropVerifyAgent, type AgentLocateResult } from "../../ai/crop-verify-agent.js";
import { describeCanonicalElement, enrichDescriptionWithSpinAnchor } from "../registry/canonical-element-hints.js";
import { detectCanonicalCluster, discoverCanonicalPerElement } from "../step2-detect-ui/discover-canonical-per-element.js";
import { saveDiscoverySnapshot } from "../registry/discovery-snapshots.js";
import { pragmaticProvider } from "../../adapters/providers/pragmatic.js";
import { dirForGame } from "../registry/paths.js";
import { diffVsBaseline, regionAround } from "../utils/pixel-diff/index.js";
import { dismissPopupsLoop, detectAnyPopup, detectDarkOverlay, isFreeSpinChainActive, SUBSTATE_POPUP_KEYWORDS } from "../utils/ocr-popup.js";
import { normalizeAnteOff, verifyAnteOff, ensureAnteOff } from "../step2-detect-ui/ante-normalize.js";
import { resolvePopupKeywords } from "../registry/popup-keywords.js";
import { resolveSubStateHints, SUB_STATE_HINTS_DEFAULTS, interpolateSliderStops, type SubStateHint } from "../registry/sub-state-hints.js";
import { readFile, writeFile } from "node:fs/promises";
import type { UiRegistry, UiElement } from "../registry/types.js";

// historyButton intentionally EXCLUDED — in PP-style games it lives inside the
// MENU popup (discover as menuButton__historyButton via per-row Discover), not
// on the main screen. Listing it here gated Auto-Onboard on a level-1 element
// that doesn't exist on main. Mirrors EXPECTED_UI_ELEMENTS_DEFAULTS /
// CANONICAL_PRIORITY_ORDER / the dashboard LEVEL1_EXPECTED_KEYS.
const LEVEL1_EXPECTED_KEYS = [
  "spinButton",
  "betPlus",
  "betMinus",
  "menuButton",
  "paytableButton",
  "autoButton",
  "buyBonusButton",
] as const;

function baseSlugFromRecordSlug(slug: string): string {
  return slug
    .replace(/_[A-Z]{3}(?:_[a-z]{2}(?:-[a-z]{2})?)?$/i, "")
    .replace(/_[a-z]{2}(?:-[a-z]{2})?$/i, "");
}

function hasUsableRegistryCoord(el: UiElement | undefined): boolean {
  return !!el
    && Number.isFinite(el.x)
    && Number.isFinite(el.y)
    && el.status === "verified";
}

async function findCloneSourceSlug(args: {
  targetSlug: string;
  baseGameSlug: string;
  language: string | null;
}): Promise<string | null> {
  const root = path.dirname(dirForGame(args.targetSlug));
  let dirs: string[] = [];
  try { dirs = await readdir(root); } catch { return null; }
  const candidates: Array<{ slug: string; score: number; ts: string }> = [];
  for (const slug of dirs) {
    if (slug === args.targetSlug || slug.startsWith("_")) continue;
    const reg = await uiRegistry.load(slug).catch(() => null);
    if (!reg || Object.keys(reg).length === 0) continue;
    const m = await meta.load(slug).catch(() => null);
    const sourceBase = m?.baseGameSlug ?? baseSlugFromRecordSlug(slug);
    if (sourceBase !== args.baseGameSlug && slug !== args.baseGameSlug) continue;
    let score = 10;
    if (slug === args.baseGameSlug) score += 20; // legacy exact base is a strong seed.
    if (m?.language && args.language && m.language === args.language) score += 10;
    if (m?.currency) score += 2;
    candidates.push({ slug, score, ts: m?.lastValidatedAt ?? m?.createdAt ?? "" });
  }
  candidates.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
  return candidates[0]?.slug ?? null;
}

/**
 * Top-level entries in a game-registry dir that are SAFE to clone into a new
 * record of the SAME base game but a DIFFERENT currency. These hold structural
 * / UI / provider knowledge that does NOT depend on the currency: button
 * coordinates, OCR regions, provider parser, feature flags, paytable
 * multipliers, discovery screenshots.
 *
 * Anything NOT listed here is a session/currency-dependent artifact and is
 * deliberately left out — most importantly `test-cases.json` (catalog whose
 * assertion descriptions bake the SOURCE currency's default bet + symbol, e.g.
 * "betAmount equals default R$120.00") and `test-cases.actions.json`
 * (translated actions baking `set_bet_to_value: 120`). Cloning those across
 * currencies leaked BRL values into COP records (and made generate-catalog skip
 * with "existing cases reused", so the wrong catalog stuck). Omitted files fail
 * SAFE: the target regenerates them from ITS OWN captured game-spec.
 *
 * Explicit literal (not derived from REGISTRY_FILES) so a newly added registry
 * file is NOT seeded until someone consciously vets it as currency-independent.
 */
const CURRENCY_INDEPENDENT_SEED_ENTRIES = new Set<string>([
  // UI / interaction structure (button coords, regions, timings)
  "ui-registry.json",
  "ocr-regions.json",
  "bet-controls.json",
  "popup-keywords.json",
  "popup-regions.json",
  "sub-state-hints.json",
  "expected-ui-elements.json",
  "state-signatures.json",
  "ui-graph.json",
  "timing-config.json",
  "qa-main-skip.json",
  "field-mapping.json",
  "game-mechanics.json",
  // Provider / parsing knowledge
  "provider-cache.json",
  "api-mapping.json",
  "parser.json",
  "parser-overlay.json",
  "learned-provider-spec.json",
  "feature-registry.json",
  // Payout knowledge (symbols / multipliers — currency-independent ratios)
  "paytable.json",
  "payout-model.json",
  // Discovery docs + screenshots
  "auxiliary-sources",
  "baselines",
  "sub-screens",
  "graph",
]);

/**
 * cp() filter: allow the source dir root plus any entry whose TOP-LEVEL name is
 * currency-independent (see set above). Rejecting a directory skips its whole
 * subtree, so listing a dir name once covers everything under it.
 */
function seedCloneFilter(sourceDir: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = path.relative(sourceDir, src);
    if (rel === "" || rel === ".") return true; // the source dir itself
    const top = rel.split(path.sep)[0]!;
    return CURRENCY_INDEPENDENT_SEED_ENTRIES.has(top);
  };
}

async function cloneRegistrySeedIfNeeded(args: {
  targetSlug: string;
  baseGameSlug: string;
  currency: string | null;
  language: string | null;
  gameUrl: string;
}): Promise<string | null> {
  const existing = await uiRegistry.load(args.targetSlug).catch(() => null);
  const sourceSlug = await findCloneSourceSlug({
    targetSlug: args.targetSlug,
    baseGameSlug: args.baseGameSlug,
    language: args.language,
  });
  if (!sourceSlug) return null;

  const seedFilter = seedCloneFilter(dirForGame(sourceSlug));
  const targetHasRegistry = !!existing && Object.keys(existing).length > 0;
  if (targetHasRegistry) {
    await cp(dirForGame(sourceSlug), dirForGame(args.targetSlug), {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: seedFilter,
    });
    const sourceRegistry = await uiRegistry.load(sourceSlug).catch(() => null);
    if (sourceRegistry) {
      const merged: UiRegistry = { ...(existing ?? {}) };
      let added = 0;
      for (const [key, el] of Object.entries(sourceRegistry)) {
        if (!merged[key] && el) {
          merged[key] = el;
          added++;
        }
      }
      if (added > 0) {
        await uiRegistry.save(args.targetSlug, merged);
        console.log(`[manual/start] backfilled ${added} missing registry element(s) from ${sourceSlug} → ${args.targetSlug}`);
      }
    }
  } else {
    await cp(dirForGame(sourceSlug), dirForGame(args.targetSlug), {
      recursive: true,
      force: true,
      filter: seedFilter,
    });
  }
  const sourceMeta = await meta.load(sourceSlug).catch(() => null);
  await initMeta(args.targetSlug, args.gameUrl, {
    baseGameSlug: args.baseGameSlug,
    currency: args.currency,
    language: args.language,
    recordSlug: args.targetSlug,
    clonedFromSlug: sourceSlug,
    gameVersionHash: sourceMeta?.gameVersionHash,
  });
  console.log(`[manual/start] ${targetHasRegistry ? "merged" : "cloned"} reusable registry seed ${sourceSlug} → ${args.targetSlug} (${args.currency ?? "no-currency"}/${args.language ?? "no-language"})`);
  return sourceSlug;
}

export type SessionStatus = {
  active: boolean;
  gameSlug: string | null;
  gameUrl: string | null;
  startedAt: string | null;
  registry: UiRegistry | null;
  verifyState: Record<string, "pending" | "confirmed" | "rejected">;
  skippedMainKeys: string[];
  subStateSuggestions: SubStateSuggestion[];
  /** P4 — main-state element keys discovery targets (defaults + per-game).
   *  Dashboard diffs this against registry keys to show a "missing" checklist. */
  expectedElements: string[];
  /** P3 — game-specific buttons auto-added to the registry beyond the expected
   *  list. Dashboard highlights these as AI-discovered extras to verify. */
  discoveryAutoAdded: Array<{ key: string; x: number; y: number; confidence: number; note?: string }>;
  /** True while an auto-onboard run is executing in the background. Dashboard
   *  uses this to restore the "Onboarding…" disabled-button state after a
   *  page reload — without it the button re-enables and QA assumes the run
   *  stopped, even though the server-side job is still running. */
  autoOnboardInProgress: boolean;
  /** Per-phase progress for the active or last Auto-Onboard run. Dashboard
   *  renders this as a checklist (✓/✗/⏳/skip) so QA can see which steps
   *  succeeded + how long each took. Empty array when no Auto-Onboard has
   *  ever run on this session. Snapshot from the moment status() is called
   *  — phases mutate live during the run. */
  autoOnboardPhases: Array<{
    /** Slug-style name: "deep-discover", "verify", "ocr", "deep-extract",
     *  "calibrate", "generate-catalog", "translate-cases", "run-cases". */
    name: string;
    /** Lifecycle:
     *   - "pending": queued, hasn't started
     *   - "running": currently executing
     *   - "ok":      finished successfully
     *   - "fail":    threw OR returned ok=false
     *   - "skip":    deliberately skipped (e.g. catalog already exists) */
    status: "pending" | "running" | "ok" | "fail" | "skip";
    /** ISO timestamps for client-side duration tracking. */
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    /** Short summary surfaced in dashboard tooltip. */
    note?: string;
  }>;
  /** Name of the phase currently running (or null if Auto-Onboard not active
   *  / phase between steps). Convenience for the dashboard's progress banner. */
  autoOnboardCurrentPhase: string | null;
  /** True when _onboard-state.json exists with completedAt=null — a prior
   *  Auto-Onboard run was interrupted (server kill / crash / pause). Dashboard
   *  uses this to swap the button label "Auto-Onboard" → "Resume
   *  Auto-Onboard (N/M done)" so QA can pick up where they left off. */
  autoOnboardResumeAvailable: boolean;
  /** True when QA clicked Pause and the server is currently finishing the
   *  active phase before honoring the request. Dashboard shows "Pausing
   *  after current phase…" so QA knows clicking again is a no-op.
   *  Auto-clears when the autoOnboard loop exits (paused or completed). */
  autoOnboardPauseRequested: boolean;
  /** Currently-running preview case (set when the previewCase mutex is held).
   *  Dashboard polls these to bypass long HTTP requests that proxies (frp
   *  HTTP vhost, nginx) kill at 60-120s. Flow: POST /preview-case kicks off
   *  the run, client polls /status, when {inProgress=false, lastCaseId=X}
   *  it fetches /case-result for X. Works regardless of whether the original
   *  POST returned successfully or was 504'd. */
  previewCaseInProgress: boolean;
  previewCaseId: string | null;
  /** Last case the server actually ran (set when previewCase finishes,
   *  success or fail). Lets the client tell "case X finished" vs "case X
   *  never started because mutex was held". */
  previewCaseLastFinishedId: string | null;
  previewCaseLastFinishedAt: string | null;
  /** Session-start endpoint state — for client polling fallback when the
   *  long-running POST (browser launch + crawl + AI UI discovery, often >60s)
   *  gets cut by a proxy 504. The dashboard polls /status: start is done when
   *  `startInProgress` is false and `startLastFinishedAt` advanced past the
   *  client's request time; `startError` is non-null on failure. */
  startInProgress: boolean;
  startStartedAt: string | null;
  startLastFinishedAt: string | null;
  startError: string | null;
  /** Admission/queue state — when the active-session cap
   *  (QA_MAX_ACTIVE_SESSIONS) is reached, a new start waits in a FIFO queue.
   *  `queuedPosition` is 1-based (1 = next to run), null when not queued;
   *  `queuedTotal` is the current queue length. The dashboard shows
   *  "Queued #position of total" while polling /status. */
  queuedPosition: number | null;
  queuedTotal: number;
  /** ISO of the last mutating interaction — feeds the idle-reaper that
   *  auto-stops an abandoned session to free a slot for a queued game. */
  lastActivityAt: string | null;
  /** Generate-catalog endpoint state — for client polling fallback when
   *  the long-running POST gets cut by proxy 504. */
  generateCatalogInProgress: boolean;
  generateCatalogStartedAt: string | null;
  generateCatalogLastFinishedAt: string | null;
  /** Batch re-translate endpoint state — retranslate-all does N sequential AI
   *  calls (one per case), routinely minutes long → far past the proxy timeout.
   *  It now runs in the BACKGROUND; the client polls these to detect completion
   *  and read the summary (mirrors the generate-catalog pattern). */
  retranslateAllInProgress: boolean;
  retranslateAllStartedAt: string | null;
  retranslateAllLastFinishedAt: string | null;
  /** Summary of the last finished background retranslate-all run (null until
   *  one completes). Client reads this once retranslateAllInProgress clears. */
  retranslateAllLastResult: { ok: boolean; total?: number; succeeded?: number; stillSkipped?: number; reason?: string } | null;
  /** Shared Run-All progress (server-side), visible across devices polling
   *  /status for the same game session. */
  runAllInProgress: boolean;
  runAllProgress: {
    mode?: "all" | "unrun" | "failed";
    total: number;
    completed: number;
    passed: number;
    failed: number;
    skipped: number;
    currentCaseId: string | null;
    startedAt: string | null;
    lastFinishedAt: string | null;
    rows: Array<{
      caseId: string;
      category?: string;
      status: "pending" | "running" | "pass" | "fail" | "skip" | "inconclusive";
      detail?: string;
      durationMs?: number;
    }>;
  };
  /** Effective game spec — captured from do_init API merged with any QA
   *  overrides from `game-spec-override.json`. Null until first network
   *  response observed OR override file loaded on resume. Editable via
   *  PUT /api/qa/manual/game-spec; updates flow into AI catalog gen so
   *  test assertions reference QA-corrected values (e.g. betMin=0.20
   *  instead of mis-calibrated 0.50). */
  gameSpec: {
    coinValues: number[];
    lines: number;
    defaultCoin: number;
    betLevels: number[];
    betMin: number;
    betMax: number;
    defaultBet: number;
    betLadder: number[];
  } | null;
  /** QA's manual overrides applied to the captured spec. Subset of fields
   *  QA chose to pin. Shown on dashboard so QA sees which values are
   *  manual vs auto-captured. */
  gameSpecOverride: import("../registry/game-spec-override.js").GameSpecOverride | null;
  /** Last detected game-engine error (e.g. PP "Internal server error.
   *  The game will be restarted." modal). Cleared when QA acknowledges
   *  via the dashboard banner. Null when no error active. Surfaces in
   *  a session-level banner so QA knows to refresh the game URL +
   *  resume — automation can't recover on its own. */
  gameError: {
    site: string;
    matchedKeywords: string[];
    detectedText: string;
    detectedAt: string;
  } | null;
  /** Lease owner — the QA user currently driving this game's live browser
   *  session. Set on start/resume, cleared on stop. While set, control
   *  endpoints reject other users (hard block) so two QA can't fight over the
   *  same page. Null when no one holds the session. */
  owner: { userId: string; username: string; since: string } | null;
};

export type SubStateSuggestion = {
  /** Main-state uiKey to click to open this sub-screen. */
  triggerKey: string;
  /** Namespace label to use when storing discovered sub-state elements. */
  stateLabel: string;
  /** Human-readable name shown on dashboard. */
  description: string;
  /** Already discovered (state-label-prefixed entries exist) → don't re-suggest. */
  alreadyDiscovered: boolean;
};

/**
 * Optional friendly labels/descriptions for known main-state buttons. Used
 * only to make suggestions more readable; ALL main-state buttons are
 * suggested for sub-state discovery — clicking spinButton/betPlus/betMinus
 * may also reveal new state (spin-in-progress controls, bet-multiplier
 * popup, etc.). Keys not in this map fall back to autogenerated label.
 */
// Sub-state hints moved to src/pipeline/registry/sub-state-hints.ts (Phase
// 7.1G). Imported as SUB_STATE_HINTS_DEFAULTS — `computeSuggestions` below
// uses defaults; runtime sub-state discovery (manualSession) resolves per
// game via resolveSubStateHints().
const SUB_STATE_HINTS: Record<string, SubStateHint> = SUB_STATE_HINTS_DEFAULTS;

/**
 * Reverse of the SUB_STATE_HINTS stateLabel mapping. Used to migrate
 * legacy registry keys (saved when discover used the stateLabel as namespace
 * prefix, e.g. "autoplay_popup__turboSpinToggle") into the canonical
 * path-style format ("autoButton__turboSpinToggle"). Run once at session
 * start so AI translator + tree display + executor all see consistent keys.
 */
const LEGACY_NAMESPACE_TO_TRIGGER: Record<string, string> = {
  autoplay_popup: "autoButton",
  bet_minus_state: "betMinus",
  bet_plus_state: "betPlus",
  buy_feature_popup: "buyBonusButton",
  menu: "menuButton",
  paytable: "paytableButton",
  history_popup: "historyButton",
  settings: "settingsButton",
  spin_in_progress: "spinButton",
  turbo_state: "turboButton",
};

/**
 * Rename keys with legacy namespace prefixes to canonical trigger-name form.
 * Mutates registry in-place. Returns list of renames performed (for logging).
 * Collisions (canonical key already exists) are skipped — keeps existing.
 */
function migrateLegacyNamespaces(
  registry: UiRegistry,
): Array<{ old: string; new: string; skipped?: boolean }> {
  const renames: Array<{ old: string; new: string; skipped?: boolean }> = [];
  const oldKeys = Object.keys(registry);
  for (const oldKey of oldKeys) {
    const firstDelim = oldKey.indexOf("__");
    if (firstDelim === -1) continue;
    const topNs = oldKey.slice(0, firstDelim);
    const trigger = LEGACY_NAMESPACE_TO_TRIGGER[topNs];
    if (!trigger) continue;
    const newKey = trigger + oldKey.slice(firstDelim);
    if (registry[newKey]) {
      renames.push({ old: oldKey, new: newKey, skipped: true });
      continue;
    }
    (registry as Record<string, UiElement | undefined>)[newKey] = registry[oldKey];
    delete (registry as Record<string, UiElement | undefined>)[oldKey];
    renames.push({ old: oldKey, new: newKey });
  }
  return renames;
}

/**
 * Stricter prompt used for popup/sub-state discovery. Tells AI to ONLY return
 * elements inside the just-opened overlay, ignoring main-game controls in the
 * background. Coord-overlap dedup in discoverSubState is the safety net for
 * cases where AI still includes background buttons.
 */
const POPUP_FOCUS_PROMPT = `A popup, modal, or sub-screen has just opened on top of the main slot-game UI. The popup is typically:
- Centered (or large overlay) on screen
- Has a darker / dimmed background OUTSIDE its bounds
- Contains buttons specific to its function (Buy options, Settings tabs, Paytable info, History rows, etc.)

Identify ONLY the clickable elements INSIDE this popup/overlay. DO NOT include:
- Main-game buttons visible BEHIND or AROUND the popup (e.g. the spin/bet controls in the background)
- Decorative panels or text labels — only actually-clickable buttons/icons/toggles

SLIDERS / PRESET SELECTORS (IMPORTANT):
If the popup contains a slider, a track of numeric preset chips, or a row of selectable values (e.g. an autoplay popup showing "10  20  25  50  75  100"), emit ONE element PER discrete value, using the EXACT visible number in the key:
- Slider name should describe what the slider controls (autospins, betLevel, coinValue, etc.)
- Key pattern: <sliderName>-<value> using kebab-case (e.g. "autospins-10", "autospins-20", "autospins-25", "autospins-50", "autospins-75", "autospins-100")
- Coordinates point at the CENTER of each tick / label / chip — clicking that exact spot must select that value
- Read the label numbers carefully from the screenshot; do NOT invent values that aren't visible
- If the slider only shows a track without numeric labels (continuous slider), instead emit a single handle element with key "<sliderName>-handle"

Other popup buttons (start, stop, close, tabs) should still be emitted as normal semantic keys alongside the slider presets.

If you genuinely cannot identify a popup overlay (e.g. clicking the button just triggered an inline action with no new screen), return an empty elements array.

Return JSON in this shape:
{
  "stateLabel": "<short_kebab_case_label_for_this_popup>",
  "elements": [
    { "key": "kebab-case-key", "x": int, "y": int, "confidence": 0..1, "role": "close|tab|action|toggle|nav|slider-preset|other" }
  ]
}

Rules:
- Use semantic keys describing the popup's role: closeButton, freeSpinsTab, buyMaxButton, prevPageButton, soundToggle, etc.
- For slider presets use role "slider-preset" and the <sliderName>-<value> key pattern described above.
- Coordinates are CSS pixels from top-left of the FULL viewport screenshot.
- confidence 0..1.

JSON only, no prose.`;

function humanizeKey(key: string): string {
  // camelCase → "camel Case"
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** A `<base>-<suffix>` key's suffix is VOLATILE (a per-session id) when it is
 *  NOT a clean number — a row's session/spin ID changes every run, so a key
 *  like `expandRow-01KV9GTV…` breaks replay. Numeric suffixes (`bet-0.40`,
 *  `autoCountSlide-10`) are meaningful + stable → never volatile. */
function isVolatileKeySuffix(suffix: string): boolean {
  if (/^\d+(?:\.\d+)?$/.test(suffix)) return false; // clean number → stable value/index
  return suffix.length >= 4; // an id-like token (letters / mixed alnum)
}

/**
 * Replay-stability normalizer for discovered repeated-row keys. Groups elements
 * by the base before the LAST '-'; for any base where a member carries a
 * VOLATILE (id-like) suffix, renumbers EVERY member of that base to a positional
 * index by vertical row order (top→bottom, then left→right): `<base>-1..N`.
 * Bases whose suffixes are all numeric/value-based (bet chips, autoplay counts)
 * are left untouched. Mutates `els` in place. Pure + exported for tests.
 */
export function normalizeVolatileRowKeys<T extends { key: string; x: number; y: number }>(els: T[]): T[] {
  const split = (k: string): { base: string; suffix: string } | null => {
    const i = k.lastIndexOf("-");
    if (i <= 0 || i >= k.length - 1) return null;
    return { base: k.slice(0, i), suffix: k.slice(i + 1) };
  };
  const byBase = new Map<string, T[]>();
  for (const e of els) {
    const sp = split(e.key);
    if (!sp) continue;
    const g = byBase.get(sp.base);
    if (g) g.push(e); else byBase.set(sp.base, [e]);
  }
  for (const [base, group] of byBase) {
    const hasVolatile = group.some((e) => { const sp = split(e.key); return sp != null && isVolatileKeySuffix(sp.suffix); });
    if (!hasVolatile) continue;
    const sorted = [...group].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    sorted.forEach((e, i) => { e.key = `${base}-${i + 1}`; });
    console.log(`[manual/discover] normalized ${group.length} volatile "${base}-<id>" key(s) → ${base}-1..${group.length} (positional, replay-stable)`);
  }
  return els;
}

function computeSuggestions(registry: UiRegistry | null): SubStateSuggestion[] {
  if (!registry) return [];
  const keys = Object.keys(registry);
  const out: SubStateSuggestion[] = [];
  for (const triggerKey of keys) {
    if (triggerKey.includes("__")) continue; // skip already-namespaced sub-state keys
    const hint = SUB_STATE_HINTS[triggerKey];
    // State label = triggerKey itself (path-style nesting). Children saved as
    // <triggerKey>__<childKey>. Consistent with per-row [Discover] button.
    const stateLabel = triggerKey;
    const description = hint?.description ?? `State after clicking ${humanizeKey(triggerKey)}`;
    const prefix = `${stateLabel}__`;
    const alreadyDiscovered = keys.some((k) => k.startsWith(prefix));
    out.push({ triggerKey, stateLabel, description, alreadyDiscovered });
  }
  return out;
}

type AiStateElement = { key: string; x: number; y: number; confidence?: number; role?: string };

function parseDiscoveredBetOptionValue(key: string): { prefix: string; value: number } | null {
  const m = key.match(/^([a-zA-Z]*bet[a-zA-Z]*)-(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const value = Number(m[2]);
  return Number.isFinite(value) ? { prefix: m[1]!, value } : null;
}

/** Snap a proposed bbox into the page viewport so `page.screenshot({clip})`
 *  never throws ClipOutOfBounds. Used by the AI ocr-region detector when
 *  the model returns a slightly-overshooting bbox (rounding, near-edge). */
function clampBboxForViewport(
  bbox: { x: number; y: number; width: number; height: number },
  vp: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(vp.width - 1, Math.round(bbox.x)));
  const y = Math.max(0, Math.min(vp.height - 1, Math.round(bbox.y)));
  const w = Math.max(1, Math.min(vp.width - x, Math.round(bbox.width)));
  const h = Math.max(1, Math.min(vp.height - y, Math.round(bbox.height)));
  return { x, y, width: w, height: h };
}

/** Crop a PNG buffer in memory. Used to extract verify-crops from a
 *  baseline screenshot WITHOUT touching the live Playwright page —
 *  important when autoDetectOcrRegions runs in parallel with deepDiscover
 *  (which is busy opening popups; a concurrent page.screenshot would
 *  capture mid-popup state and break crop verification). */
function cropPngBufferSync(
  buf: Buffer,
  clip: { x: number; y: number; width: number; height: number },
): Buffer {
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const src = PNG.sync.read(buf);
  const sx = Math.max(0, Math.min(src.width, Math.round(clip.x)));
  const sy = Math.max(0, Math.min(src.height, Math.round(clip.y)));
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(clip.width)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(clip.height)));
  const dst = new PNG({ width: sw, height: sh });
  for (let y = 0; y < sh; y++) {
    const srcRow = ((sy + y) * src.width + sx) * 4;
    const dstRow = y * sw * 4;
    src.data.copy(dst.data, dstRow, srcRow, srcRow + sw * 4);
  }
  return PNG.sync.write(dst);
}

export class ManualSessionManager {
  private session: BrowserSession | null = null;
  /** window.open tabs observed on this session's context (newest last). */
  private externalTabs: import("playwright").Page[] = [];
  private gameSlug: string | null = null;
  private gameUrl: string | null = null;
  private startedAt: string | null = null;
  private registry: UiRegistry | null = null;
  private verifyState: Record<string, "pending" | "confirmed" | "rejected"> = {};
  private skippedMainKeys = new Set<string>();
  /** 2026-06-01: mutex for expensive long-running ops (autoOnboard,
   *  deepDiscover). Node's single-threaded event loop happily queues
   *  multiple concurrent HTTP requests against the same route; without this
   *  guard, a curl that was TaskStop'd CLIENT-SIDE still has its request
   *  sitting in the server queue, ready to fire after the current one
   *  completes. Observed: 4 prior curl tasks stacked up → server ran
   *  autoOnboard 5 times in a row, last 4 overwriting the first's results.
   *  Set when work begins, cleared in finally. Re-entries return 409. */
  private autoOnboardInProgress = false;
  /** Latest detected game-engine error popup (PP "Internal server
   *  error. The game will be restarted." style). Set by automation
   *  flows that call throwIfGameError. Cleared when QA acknowledges
   *  via /api/qa/manual/game-error/clear. Surfaced in session status
   *  so dashboard can render a halt banner. */
  private gameError: NonNullable<SessionStatus["gameError"]> | null = null;
  /** Per-phase progress tracker — see SessionStatus.autoOnboardPhases doc.
   *  Lives across Auto-Onboard runs (replaced each run via initAutoOnboardPhases).
   *  Read-only from outside via status(). */
  private autoOnboardPhases: NonNullable<SessionStatus["autoOnboardPhases"]> = [];
  private autoOnboardCurrentPhase: string | null = null;
  /** Timestamp of the active Auto-Onboard run (or last run if completed).
   *  Persisted to _onboard-state.json so a resumed run keeps the original
   *  start time + duration math stays correct across restart. */
  private autoOnboardStartedAt: string | null = null;
  /** True when the on-disk state file indicates a prior run was interrupted
   *  (server killed / crashed mid-flow). Computed at session resume + after
   *  reading _onboard-state.json; clears when a fresh Auto-Onboard
   *  successfully completes. Frontend uses this to swap the button label
   *  from "Auto-Onboard" → "Resume Auto-Onboard". */
  private autoOnboardResumeAvailable = false;
  /** Cooperative pause flag — set by pauseAutoOnboard(). The autoOnboard
   *  loop polls this between phases; when true, it persists state + exits
   *  cleanly (ok=true, reason="paused by request"). Granularity is
   *  phase-level: mid-phase pause isn't supported because each phase
   *  (deep-discover, calibrate, …) is an opaque async call. User has to
   *  wait for the current phase to finish before pause takes effect. */
  private autoOnboardPauseRequested = false;
  /** Mutex for previewCase. Without it, a proxy 504 timeout that's CLIENT-side
   *  doesn't cancel the server-side promise — case-executor keeps running.
   *  If the dashboard's Run-All loop catches the 504 as failure and fires the
   *  NEXT case, two executeCase() invocations attach response listeners to
   *  the SAME Playwright page simultaneously → spin events leak between cases
   *  → assertion sees mixed collector data (e.g. autoplay-50 case sees free-
   *  spin frames from a different case). Concurrent requests 409 fast. */
  private previewCaseInProgress = false;
  /** Polling-pattern bookkeeping — see SessionStatus.previewCase* docs. */
  private previewCaseId: string | null = null;
  private previewCaseLastFinishedId: string | null = null;
  private previewCaseLastFinishedAt: string | null = null;
  /** Polling-pattern bookkeeping for /api/qa/manual/generate-catalog.
   *  Same pattern as previewCase: long-running endpoint (30-90s typical)
   *  often dies behind proxies at 60s timeout, so client falls back to
   *  polling /status with these flags to detect completion. */
  /** Polling-pattern bookkeeping for /api/qa/manual/start. Browser launch +
   *  crawl + AI UI discovery often exceeds a 60s proxy timeout, so the client
   *  falls back to polling /status with these flags (mirrors generateCatalog). */
  private startInProgress = false;
  private startStartedAt: string | null = null;
  private startLastFinishedAt: string | null = null;
  private startError: string | null = null;
  /** Admission/queue bookkeeping (set by session-pool's admission logic). */
  private queuedPosition: number | null = null;
  private queuedTotal = 0;
  /** Epoch ms of the last mutating interaction — drives idle-reaping. */
  private lastActivityAt = Date.now();
  private generateCatalogInProgress = false;
  private generateCatalogStartedAt: string | null = null;
  private generateCatalogLastFinishedAt: string | null = null;
  /** Background batch-retranslate state (see SessionStatus docs). */
  private retranslateAllInProgress = false;
  private retranslateAllStartedAt: string | null = null;
  private retranslateAllLastFinishedAt: string | null = null;
  private retranslateAllLastResult: SessionStatus["retranslateAllLastResult"] = null;
  /** Shared server-side progress for /run-all-testcases. */
  private runAllInProgress = false;
  private runAllProgress: SessionStatus["runAllProgress"] = {
    mode: "all",
    total: 0,
    completed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    currentCaseId: null,
    startedAt: null,
    lastFinishedAt: null,
    rows: [],
  };
  /** P3 — game-specific buttons the AI noticed beyond the expected list during
   *  the last discovery, AUTO-ADDED to the registry as pending. Tracked so the
   *  dashboard can highlight them for QA to verify / rename / remove. */
  private discoveryAutoAdded: Array<{ key: string; x: number; y: number; confidence: number; note?: string }> = [];
  /** P4 — resolved expected-element target keys for the active game (defaults
   *  + per-game overrides). Populated on start/resume; read by status() to feed
   *  the dashboard "missing elements" checklist. */
  private expectedElementKeys: string[] = [];
  /**
   * Wallet balance tracker. Updated from any network response containing
   * `balance=N` (doInit, doSpin, reloadBalance, etc.). Used as priorBalance
   * for case-executor — so first spin's startingBalance isn't null even
   * when the spin response itself doesn't expose startingBalance.
   *
   * Lifecycle: reset on session start/resume/stop. Listener attached once
   * per page; persists across reloads (browser context survives reload).
   */
  private lastBalance: number | null = null;

  /** Lease owner — the QA user driving this live session. See SessionStatus.owner.
   *  Claimed on start/resume, released on stop. */
  private owner: { userId: string; username: string; since: string } | null = null;

  /** Current lease owner (read-only snapshot), or null when unleased. */
  getOwner(): { userId: string; username: string; since: string } | null {
    return this.owner ? { ...this.owner } : null;
  }

  /** Claim the lease for a user. No-op if the same user already holds it.
   *  Throws when a DIFFERENT user holds it (hard block — caller maps to 409). */
  claimOwner(user: { id: string; username: string }): void {
    if (this.owner && this.owner.userId !== user.id) {
      throw new Error(`session is in use by "${this.owner.username}"`);
    }
    if (!this.owner) {
      this.owner = { userId: user.id, username: user.username, since: new Date().toISOString() };
    }
  }

  /** Release the lease unconditionally (called on stop). */
  releaseOwner(): void {
    this.owner = null;
  }

  /**
   * Game spec extracted from doInit response — used by case-action-translator
   * to generate correct actions (ladder-aware bet adjustment, multi-spin, etc.).
   * Captured automatically from network listener; null until doInit observed.
   */
  private gameSpec: {
    coinValues: number[];     // sc=0.01,0.015,...
    lines: number;            // l=20
    defaultCoin: number;      // defc=0.15
    betLevels: number[];      // bls=20,100,200
    betMin: number;           // total_bet_min=0.2
    betMax: number;           // total_bet_max=10000
    defaultBet: number;       // computed: defc * l
    betLadder: number[];      // computed: coinValues.map(c => c * l)
  } | null = null;
  /** Last-captured RAW gameSpec before override applied. Kept so QA can
   *  see the difference + a "reset to auto-captured" UI action can erase
   *  the override file. Null until first do_init capture. */
  private gameSpecRaw: NonNullable<ManualSessionManager["gameSpec"]> | null = null;
  /** Cached override loaded from disk on session start. Mutations go
   *  through saveGameSpecOverride() which writes the file + recomputes
   *  effective `this.gameSpec`. */
  private gameSpecOverrideCached: GameSpecOverride | null = null;

  /**
   * Game mechanic cache loaded from registry on resume(), or derived from
   * first observed balance-changing spin in start(). `undefined` = not yet
   * loaded; `null` = no entry exists; object = available. Avoids repeated
   * disk reads + repeated derivation attempts.
   */
  private gameMechanicsCached: import("../registry/types.js").GameMechanics | null | undefined = undefined;

  async start(url: string, opts: { autoDiscover?: boolean } = {}): Promise<SessionStatus> {
    if (this.session) {
      throw new Error("Session already active — call stop() first");
    }
    // Headed by default so QA can watch what the backend is doing. Override
    // with QA_HEADLESS=1 for CI / remote deploys / batch onboard without UI.
    this.session = await openBrowser(process.env.QA_HEADLESS === "1");
    this.gameUrl = url;
    this.startedAt = new Date().toISOString();
    this.lastBalance = null;
    this.attachBalanceTracker();
    this.attachExternalTabTracker();
    this.attachWsCapture();

    const identity = deriveGameRecordIdentity(url);
    const clonedFromSlug = await cloneRegistrySeedIfNeeded({
      targetSlug: identity.recordSlug,
      baseGameSlug: identity.baseGameSlug,
      currency: identity.currency,
      language: identity.language,
      gameUrl: url,
    });
    const crawled = await crawl(this.session.page, { gameUrl: url, gameSlug: identity.recordSlug });
    this.gameSlug = crawled.gameSlug;
    this.expectedElementKeys = (await resolveExpectedUiElements(this.gameSlug)).map((e) => e.key);
    this.skippedMainKeys = await this.loadSkippedMainKeys(this.gameSlug);
    await initMeta(this.gameSlug, url, {
      baseGameSlug: identity.baseGameSlug,
      currency: identity.currency,
      language: identity.language,
      recordSlug: identity.recordSlug,
      ...(clonedFromSlug ? { clonedFromSlug } : {}),
    });
    await providerCache.save(this.gameSlug, {
      provider: crawled.provider,
      gameName: crawled.gameName,
      platform: crawled.platform,
      iframeCount: crawled.iframeCount,
      canvasCount: crawled.canvasCount,
      detectedAt: new Date().toISOString(),
    });

    // OCR popup dismissal — detect "PRESS ANYWHERE TO CONTINUE" etc. and
    // auto-click to clear before UI discovery. Deterministic (Tesseract.js,
    // no AI). Skips if no popup keywords detected.
    try {
      await this.session.page.waitForTimeout(2000); // let popup render
      const r = await dismissPopupsLoop(this.session.page);
      if (r.attempts > 0) console.log(`[manual/ocr] popup dismiss: ok=${r.ok} attempts=${r.attempts} matched=${r.finalDetect.matchedKeywords.join(",")}`);
    } catch (err) {
      console.warn(`[manual/ocr] popup dismiss failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Server-side account state may carry an active autoplay from a previous
    // browser session. Detect spontaneous spin responses + stop before discover
    // runs (otherwise discover sees a moving game + AI vision drifts).
    try {
      const a = await this.stopAutoplayIfActive();
      if (a.wasActive) console.log(`[manual/autoplay-stop] stopped leaked autoplay on start`);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] failed on start (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (opts.autoDiscover !== false) {
      // Run initial AI discovery so QA has a seed registry to verify.
      // QA can confirm/reject/edit each entry.
      //
      // IMPORTANT: disable AI verify-loop here. In manual mode, the HUMAN is
      // the verifier — AI auto-verify (3 rounds per element) is redundant and
      // adds 30-60s of latency before dashboard becomes interactive. Restore
      // prior env state in finally to avoid leaking globally.
      const prevVerify = process.env.QA_UI_VERIFY_LOOP;
      process.env.QA_UI_VERIFY_LOOP = "0";
      try {
        const { uiMap, autoAdded } = await discoverUi(this.session.page, { slug: this.gameSlug });
        this.registry = uiMap;
        this.discoveryAutoAdded = autoAdded ?? [];
        for (const key of Object.keys(uiMap)) this.verifyState[key] = "pending";
        if (this.discoveryAutoAdded.length > 0) {
          console.log(`[manual] auto-added ${this.discoveryAutoAdded.length} extra button(s): ${this.discoveryAutoAdded.map((a) => a.key).join(", ")}`);
        }
        await uiRegistry.save(this.gameSlug, uiMap);
      } finally {
        if (prevVerify === undefined) delete process.env.QA_UI_VERIFY_LOOP;
        else process.env.QA_UI_VERIFY_LOOP = prevVerify;
      }
    } else {
      // Pure manual mode: empty registry, QA builds it from scratch.
      this.registry = {};
    }

    return this.status();
  }

  /** True while a background start() is running (idempotency guard for the
   *  route + read by the dashboard's 504 polling fallback). */
  isStarting(): boolean {
    return this.startInProgress;
  }

  /** Record a mutating interaction (resets the idle-reap clock). Called by the
   *  route layer on every non-GET manual request targeting this session. */
  touchActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** True when this session is running an automated batch (onboard / run-all /
   *  preview / generate-catalog / retranslate-all / start). Such a session is
   *  NEVER reaped. */
  hasActiveBatch(): boolean {
    return this.autoOnboardInProgress
      || this.runAllInProgress
      || this.previewCaseInProgress
      || this.generateCatalogInProgress
      || this.retranslateAllInProgress
      || this.startInProgress;
  }

  /** Set/clear admission-queue position (session-pool owns the queue). */
  setQueued(position: number | null, total: number): void {
    this.queuedPosition = position;
    this.queuedTotal = total;
  }

  /** Idle ms if this session is REAPABLE (auto-stoppable to free a slot):
   *  it holds a live browser, is running no batch, and has been idle for at
   *  least `graceMs`. Returns -1 when not reapable. */
  reapableIdleMs(graceMs: number): number {
    if (this.session === null) return -1;       // no browser → nothing to free
    if (this.hasActiveBatch()) return -1;        // mid-batch → never kill
    const idle = Date.now() - this.lastActivityAt;
    return idle >= graceMs ? idle : -1;
  }

  /** Counts toward the active-session cap: holding a browser OR mid-start. */
  occupiesSlot(): boolean {
    return this.session !== null || this.startInProgress;
  }

  /** Fire-and-forget wrapper around start() with status-flag bookkeeping, so
   *  the /start route can return 202 immediately and the dashboard can poll
   *  /status to detect completion when the long start (>60s) is cut by a proxy
   *  504. Mirrors the generateCatalog / previewCase polling pattern.
   *
   *  Because the work outlives the HTTP request, we SNAPSHOT the request context
   *  (per-QA Claude token etc.) and re-enter it so AI calls inside discoverUi
   *  still use the right token — see src/server/request-context.ts.
   *
   *  `onResolved` fires once the slug is known (success) so the caller can
   *  register the manager in the session pool under its real slug. */
  startInBackground(
    url: string,
    opts: { autoDiscover?: boolean } = {},
    hooks: { onResolved?: (slug: string | null) => void; owner?: { id: string; username: string } | null } = {},
  ): void {
    if (this.startInProgress) return; // already starting — idempotent
    this.startInProgress = true;
    this.startStartedAt = new Date().toISOString();
    this.startError = null;
    const ctx = requestContext.getStore();
    const run = <T>(fn: () => Promise<T>): Promise<T> =>
      ctx ? requestContext.run(ctx, fn) : fn();
    void run(() => this.start(url, opts))
      .then(() => {
        if (hooks.owner) this.claimOwner(hooks.owner);
        hooks.onResolved?.(this.gameSlug);
      })
      .catch((err) => {
        this.startError = err instanceof Error ? err.message : String(err);
        console.error(`[manual/start-bg] start failed for ${url}: ${this.startError}`);
      })
      .finally(() => {
        this.startInProgress = false;
        this.startLastFinishedAt = new Date().toISOString();
      });
  }

  status(): SessionStatus {
    return {
      active: this.session !== null,
      gameSlug: this.gameSlug,
      gameUrl: this.gameUrl,
      startedAt: this.startedAt,
      registry: this.registry,
      verifyState: { ...this.verifyState },
      skippedMainKeys: Array.from(this.skippedMainKeys),
      subStateSuggestions: computeSuggestions(this.registry),
      expectedElements: [...this.expectedElementKeys],
      discoveryAutoAdded: [...this.discoveryAutoAdded],
      autoOnboardInProgress: this.autoOnboardInProgress,
      autoOnboardPhases: this.autoOnboardPhases.map((p) => ({ ...p })),
      autoOnboardCurrentPhase: this.autoOnboardCurrentPhase,
      autoOnboardResumeAvailable: this.autoOnboardResumeAvailable,
      autoOnboardPauseRequested: this.autoOnboardPauseRequested,
      previewCaseInProgress: this.previewCaseInProgress,
      previewCaseId: this.previewCaseId,
      previewCaseLastFinishedId: this.previewCaseLastFinishedId,
      previewCaseLastFinishedAt: this.previewCaseLastFinishedAt,
      startInProgress: this.startInProgress,
      startStartedAt: this.startStartedAt,
      startLastFinishedAt: this.startLastFinishedAt,
      startError: this.startError,
      queuedPosition: this.queuedPosition,
      queuedTotal: this.queuedTotal,
      lastActivityAt: this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : null,
      generateCatalogInProgress: this.generateCatalogInProgress,
      generateCatalogStartedAt: this.generateCatalogStartedAt,
      generateCatalogLastFinishedAt: this.generateCatalogLastFinishedAt,
      retranslateAllInProgress: this.retranslateAllInProgress,
      retranslateAllStartedAt: this.retranslateAllStartedAt,
      retranslateAllLastFinishedAt: this.retranslateAllLastFinishedAt,
      retranslateAllLastResult: this.retranslateAllLastResult ? { ...this.retranslateAllLastResult } : null,
      runAllInProgress: this.runAllInProgress,
      runAllProgress: { ...this.runAllProgress },
      gameSpec: this.gameSpec ? { ...this.gameSpec } : null,
      gameSpecOverride: this.gameSpecOverrideCached ? { ...this.gameSpecOverrideCached } : null,
      gameError: this.gameError ? { ...this.gameError } : null,
      owner: this.owner ? { ...this.owner } : null,
    };
  }

  /** Run a game-error scan + record + throw if hit. Wrappers around
   *  throwIfGameError that also persists the detection into this.gameError
   *  so the dashboard banner can render it after the run halts. Caller
   *  should call this at safe pre-action checkpoints (between phases,
   *  before each spin, after popup recovery). Returns silently when
   *  no error detected. */
  async detectAndRecordGameError(site: string): Promise<void> {
    if (!this.session) return;
    const { detectGameError, GameErrorDetectedError } = await import("../utils/game-error-detect.js");
    const r = await detectGameError(this.session.page);
    if (r.hasError) {
      this.gameError = {
        site,
        matchedKeywords: [...r.matchedKeywords],
        detectedText: r.detectedText,
        detectedAt: new Date().toISOString(),
      };
      console.error(`[manual/game-error] ⛔ detected at ${site}: ${r.matchedKeywords.join(", ")} — halting flow. QA must reload game URL.`);
      throw new GameErrorDetectedError(r, site);
    }
  }

  /** Acknowledge + clear the recorded game error. Used after QA reloads
   *  the game URL — banner goes away, automation can resume. */
  clearGameError(): void {
    if (this.gameError) {
      console.log(`[manual/game-error] cleared — was: ${this.gameError.matchedKeywords.join(", ")}`);
    }
    this.gameError = null;
  }

  /** Wrap an operation with the generate-catalog mutex + status tracking
   *  so the dashboard can detect completion via /status polling when the
   *  HTTP response itself is cut by a proxy 504. Caller MUST own the
   *  outer route handler — this just sets/clears flags + records
   *  timestamps. Re-entrant calls reject so concurrent requests serialize. */
  async withGenerateCatalogMutex<T>(work: () => Promise<T>): Promise<{ ok: boolean; reason?: string; result?: T }> {
    if (this.generateCatalogInProgress) {
      return { ok: false, reason: "another generate-catalog is already running on this session (HTTP 409)" };
    }
    this.generateCatalogInProgress = true;
    this.generateCatalogStartedAt = new Date().toISOString();
    try {
      const result = await work();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.generateCatalogInProgress = false;
      this.generateCatalogLastFinishedAt = new Date().toISOString();
    }
  }

  /** Click at the cached coord of a registered element. QA watches result. */
  async clickElement(uiKey: string): Promise<{ ok: boolean; clickedAt: { x: number; y: number } | null; error?: string }> {
    if (!this.session || !this.registry) return { ok: false, clickedAt: null, error: "no active session" };
    const el = this.registry[uiKey];
    if (!el) return { ok: false, clickedAt: null, error: `uiKey ${uiKey} not in registry` };
    try {
      // Elements discovered on an EXTERNAL TAB: their coords are tab-relative
      // — clicking the game page hits whatever sits at those coords there.
      // Route to the most recent OPEN tab; without one, fail with guidance
      // (the parent trigger must be clicked first to open the tab).
      if (el.externalPage) {
        const tab = [...this.externalTabs].reverse().find((p) => !p.isClosed());
        if (!tab) {
          const parent = uiKey.includes("__") ? uiKey.slice(0, uiKey.lastIndexOf("__")) : null;
          return {
            ok: false, clickedAt: null,
            error: `"${uiKey}" lives on an external tab but no tab is open — Test/click its parent trigger first${parent ? ` (${parent})` : ""} to open the tab, then retry`,
          };
        }
        await tab.mouse.click(el.x, el.y);
        console.log(`[manual] click ${uiKey} (${el.x},${el.y}) [external tab]`);
        return { ok: true, clickedAt: { x: el.x, y: el.y } };
      }
      // Tab-opening trigger (direct children are externalPage): canvas games
      // swallow the first programmatic click — double-click so ONE Test press
      // opens the tab (mirrors the runtime executor's gesture).
      const prefix = `${uiKey}__`;
      const opensTab = Object.entries(this.registry).some(([k, v]) =>
        k.startsWith(prefix) && !k.slice(prefix.length).includes("__") && v?.externalPage === true);
      await this.session.page.mouse.click(el.x, el.y);
      if (opensTab) {
        await this.session.page.waitForTimeout(150);
        await this.session.page.mouse.click(el.x, el.y);
        console.log(`[manual] click ${uiKey} ×2 (tab-opening trigger)`);
      }
      return { ok: true, clickedAt: { x: el.x, y: el.y } };
    } catch (err) {
      return { ok: false, clickedAt: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Click at arbitrary coord (manual correction). */
  async clickAt(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.session) return { ok: false, error: "no active session" };
    try {
      await this.session.page.mouse.click(x, y);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Confirm (verify) an element — marks status verified + verifiedBy QA. */
  async confirm(uiKey: string): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    const el = this.registry[uiKey];
    if (!el) throw new Error(`uiKey ${uiKey} not in registry`);
    el.verifiedBy = "QA";
    el.status = "verified";
    el.verifiedAt = new Date().toISOString();
    this.verifyState[uiKey] = "confirmed";
    this.skippedMainKeys.delete(uiKey);
    await this.saveSkippedMainKeys(this.gameSlug);
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Bulk verify ALL descendants of a parent element (keys starting with
   * `<parentKey>__`, including grandchildren). The parent itself is NOT
   * touched. Use to verify a whole popup's children in one click (e.g. all
   * autoCountSlide-N slider stops under autoButton).
   */
  async confirmChildren(parentKey: string): Promise<{ ok: boolean; count: number; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, count: 0, reason: "no active session" };
    const registry = this.registry;
    const prefix = `${parentKey}__`;
    const childKeys = Object.keys(registry).filter((k) => k.startsWith(prefix) && registry[k]);
    if (childKeys.length === 0) return { ok: false, count: 0, reason: `no children under ${parentKey}` };
    const now = new Date().toISOString();
    for (const k of childKeys) {
      const el = registry[k]!;
      el.verifiedBy = "QA";
      el.status = "verified";
      el.verifiedAt = now;
      this.verifyState[k] = "confirmed";
      this.skippedMainKeys.delete(k);
    }
    await this.saveSkippedMainKeys(this.gameSlug);
    await uiRegistry.save(this.gameSlug, this.registry);
    console.log(`[manual] bulk verified ${childKeys.length} children of ${parentKey}`);
    return { ok: true, count: childKeys.length };
  }

  /**
   * Remove ALL descendants of a parent element (keys starting with
   * `<parentKey>__`, including grandchildren). The parent itself is kept so QA
   * can re-run Discover from that same trigger after clearing bad children.
   */
  async removeChildren(parentKey: string): Promise<{ ok: boolean; count: number; removedKeys?: string[]; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, count: 0, reason: "no active session" };
    const prefix = `${parentKey}__`;
    const childKeys = Object.keys(this.registry).filter((k) => k.startsWith(prefix) && this.registry?.[k]);
    if (childKeys.length === 0) return { ok: false, count: 0, removedKeys: [], reason: `no children under ${parentKey}` };
    for (const k of childKeys) {
      delete this.registry[k];
      delete this.verifyState[k];
      this.skippedMainKeys.delete(k);
    }
    await this.saveSkippedMainKeys(this.gameSlug);
    await uiRegistry.save(this.gameSlug, this.registry);
    console.log(`[manual] removed ${childKeys.length} children of ${parentKey}`);
    return { ok: true, count: childKeys.length, removedKeys: childKeys };
  }

  /** QA manually corrects coord by clicking on dashboard screenshot. */
  async updateCoord(uiKey: string, x: number, y: number): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    const existing = this.registry[uiKey];
    const now = new Date().toISOString();
    const updated: UiElement = {
      x: Math.round(x),
      y: Math.round(y),
      strategy: "manual",
      confidence: 1.0,
      detectedAt: now,
      baselineScreenshot: existing?.baselineScreenshot,
      verifiedBy: "QA",
      status: "verified",
      verifiedAt: now,
    };
    this.registry[uiKey] = updated;
    this.verifyState[uiKey] = "confirmed";
    if (this.skippedMainKeys.delete(uiKey)) {
      await this.saveSkippedMainKeys(this.gameSlug);
    }
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  async setMainKeySkipped(uiKey: string, skipped: boolean): Promise<{ ok: boolean; reason?: string }> {
    if (!this.session || !this.gameSlug) return { ok: false, reason: "no active session" };
    if (skipped) {
      this.skippedMainKeys.add(uiKey);
      if (this.registry?.[uiKey]) {
        this.registry[uiKey]!.status = "rejected";
        this.registry[uiKey]!.verifiedBy = null;
      }
      this.verifyState[uiKey] = "rejected";
    } else {
      this.skippedMainKeys.delete(uiKey);
      if (this.verifyState[uiKey] === "rejected") {
        this.verifyState[uiKey] = this.registry?.[uiKey]?.status === "verified" ? "confirmed" : "pending";
      }
    }
    await this.saveSkippedMainKeys(this.gameSlug);
    if (this.registry) await uiRegistry.save(this.gameSlug, this.registry);
    return { ok: true };
  }

  /** Add a brand-new element (not in current registry). Rejects if key exists. */
  async addElement(uiKey: string, x: number, y: number): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    if (this.registry[uiKey]) throw new Error(`uiKey '${uiKey}' already exists — use Pick in Game on its row to update, or Remove first`);
    const now = new Date().toISOString();
    const el: UiElement = {
      x: Math.round(x),
      y: Math.round(y),
      strategy: "manual",
      confidence: 1.0,
      detectedAt: now,
      verifiedBy: "QA",
      status: "verified",
      verifiedAt: now,
    };
    this.registry[uiKey] = el;
    this.verifyState[uiKey] = "confirmed";
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Multi-level discovery with ANCESTOR PATH WALK + AUTO-RESET to main state.
   *
   * For nested triggers like "buyBonusButton__freeSpinsOption":
   *   1. Close any open popups (ESC ×2 + outside-click) → ensure main state
   *   2. Walk ancestor chain: click buyBonusButton, wait, click freeSpinsOption, wait
   *   3. AI-discover elements in resulting state → save under <triggerKey>__*
   *
   * Works regardless of starting state because step 1 force-resets to main.
   */
  async discoverVia(
    triggerKey: string,
    stateLabel: string,
    opts: { gesture?: "click" | "hold"; holdMs?: number } = {},
  ): Promise<{ ok: boolean; addedKeys?: string[]; reason?: string; clickedPath?: Array<{ key: string; x: number; y: number; gesture?: "click" | "hold"; holdMs?: number }> }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const holdMs = Math.max(300, Math.min(15_000, Math.round(opts.holdMs ?? Number(process.env.QA_DISCOVER_HOLD_MS ?? 5000))));

    // 1. Reset to main state. Send ESC twice to close any nested popups, then
    //    click an empty corner to dismiss any non-ESC-respecting overlay. Slot
    //    games typically close popups via either ESC or background-click.
    const vp = this.session.page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await this.session.page.keyboard.press("Escape");
      await this.session.page.waitForTimeout(300);
      await this.session.page.keyboard.press("Escape");
      await this.session.page.waitForTimeout(300);
      // Click top-left corner (empty area, no game UI normally there) as
      // additional outside-click dismissal. Safe coord.
      await this.session.page.mouse.click(5, 5);
      await this.session.page.waitForTimeout(500);
    } catch {
      // Reset failures non-fatal — proceed with walk anyway.
    }
    void vp;

    // 2. Build ancestor chain: "a__b__c" → ["a", "a__b", "a__b__c"]
    const parts = triggerKey.split("__");
    const ancestors: string[] = [];
    for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join("__"));

    const clickedPath: Array<{ key: string; x: number; y: number; gesture?: "click" | "hold"; holdMs?: number }> = [];
    // External-tab detection (same mechanism graph-explorer uses): the FINAL
    // trigger may window.open a separate browser tab (e.g. historyButton →
    // external game-history page). Listen on the context before that click;
    // when a tab appears, discovery runs ON THE TAB and children are flagged
    // `externalPage: true` so runtime clicks route there.
    const tabSlot: Array<import("playwright").Page> = [];
    const onNewPage = (p: import("playwright").Page): void => {
      if (tabSlot.length === 0) tabSlot.push(p);
    };
    const pageCtx = this.session.page.context();
    try {
      // EFFECT-VERIFIED click for EVERY ancestor, via the AI verify-click agent
      // (replaces the old pixel-diff probe). Pixel-diff just measured "did the
      // screen change", which slot canvases defeat both ways: they animate
      // constantly (false "changed" every frame) AND a wrong-coord click can
      // still produce visible change (canvas tap → spin) → false "landed". The
      // agent clicks the coord and reasons over screenshot + network about
      // whether it actually opened the expected sub-state — the same judgment a
      // human QA makes. A new TAB on the final step is still detected via the
      // pageCtx "page" listener regardless of who issued the click.
      for (let i = 0; i < ancestors.length; i++) {
        const key = ancestors[i]!;
        const isLast = i === ancestors.length - 1;
        const el = this.registry[key];
        if (!el) {
          return { ok: false, reason: `ancestor missing in registry: ${key} (need to discover + verify it first)`, clickedPath };
        }
        if (isLast) pageCtx.on("page", onNewPage);
        const gesture = (opts.gesture === "hold" || el.preferredGesture === "hold") ? "hold" : "click";
        const stepHoldMs = Math.max(300, Math.min(15_000, Math.round(el.preferredHoldMs ?? holdMs)));
        clickedPath.push({ key, x: el.x, y: el.y, gesture, ...(gesture === "hold" ? { holdMs: stepHoldMs } : {}) });
        try {
          if (gesture === "hold") {
            console.log(`[manual/discover] walk ${key}: holding @ (${el.x},${el.y}) for ${stepHoldMs}ms`);
            el.preferredGesture = "hold";
            el.preferredHoldMs = stepHoldMs;
            await uiRegistry.save(this.gameSlug, this.registry);
            await this.session.page.mouse.move(el.x, el.y);
            await this.session.page.mouse.down();
            await this.session.page.waitForTimeout(stepHoldMs);
            await this.session.page.mouse.up();
            await this.session.page.waitForTimeout(2000);
          } else if (!this.session.cdpEndpoint) {
            // No CDP endpoint → can't run the agent; click directly so the walk
            // can still proceed (unverified).
            console.warn(`[manual/discover] walk ${key}: no CDP endpoint — clicking unverified`);
            await this.session.page.mouse.click(el.x, el.y);
            await this.session.page.waitForTimeout(1500);
          } else {
            const stateContext = i > 0
              ? `Walking a trigger chain; popups opened so far: ${ancestors.slice(0, i).join(" → ")}.`
              : undefined;
            const v = await verifyClickAgent({
              cdpEndpoint: this.session.cdpEndpoint,
              coord: { x: el.x, y: el.y },
              elementKey: key,
              expectedBehavior: expectedBehaviorFor(key),
              stateContext,
              outputDir: path.join(dirForGame(this.gameSlug), "debug-agent"),
            });
            await this.session.page.waitForTimeout(500); // let a popup/tab settle (onNewPage)
            if (isLast && tabSlot[0]) {
              console.log(`[manual/discover] walk ${key}: opened external tab ✓`);
            } else if (v.ok) {
              console.log(`[manual/discover] walk ${key}: AI-verified effect — ${v.reason.slice(0, 100)}`);
            } else {
              console.warn(`[manual/discover] walk ${key}: AI says click had no effect (${v.reason.slice(0, 140)}) — continuing, but the walk may be off-state`);
            }
          }
        } catch (err) {
          return { ok: false, reason: `click on ${key} (${el.x},${el.y}) failed: ${err instanceof Error ? err.message : String(err)}`, clickedPath };
        }
      }

      // 3. AI-discover elements at the final state — on the external tab when
      //    the trigger opened one, else on the game page as before.
      const tab = tabSlot[0];
      if (tab && !tab.isClosed()) {
        console.log(`[manual/discover] ${triggerKey} opened an external tab — discovering its contents (children will be externalPage:true)`);
        await tab.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
        await tab.waitForTimeout(1000); // let the page paint past DOM-ready
        const discovered = await this.discoverSubState(stateLabel, { sourcePage: tab, externalPage: true });
        try { await tab.close(); } catch { /* already closed */ }
        return { ...discovered, clickedPath };
      }
      const discovered = await this.discoverSubState(stateLabel);
      return { ...discovered, clickedPath };
    } finally {
      pageCtx.off("page", onNewPage);
      // Never leak a tab on early-return/error paths.
      const leftover = tabSlot[0];
      if (leftover && !leftover.isClosed()) {
        try { await leftover.close(); } catch { /* already closed */ }
      }
    }
  }

  private async enrichScrollableBetDropdownOptions(
    page: import("playwright").Page,
    safeLabel: string,
    aiElements: AiStateElement[],
    debugDir: string,
  ): Promise<{ added: number; totalValues: number; values: number[] }> {
    const dropdown = aiElements.find((e) =>
      /dropdown/i.test(e.key)
      && (/bet/i.test(e.key) || aiElements.some((x) => parseDiscoveredBetOptionValue(x.key) != null)));
    if (!dropdown) return { added: 0, totalValues: 0, values: [] };

    const visibleBetRows = aiElements
      .map((e) => parseDiscoveredBetOptionValue(e.key))
      .filter((v): v is { prefix: string; value: number } => v != null);
    const rowPrefix = visibleBetRows.find((r) => /totalbet/i.test(r.prefix))?.prefix
      ?? visibleBetRows[0]?.prefix
      ?? "bet";
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const { transcribeBetDropdown } = await import("../../ai/vision.js");
    const maxAiReads = Math.max(3, Math.min(20, Math.round(Number(process.env.QA_BET_DROPDOWN_DISCOVER_MAX_READS ?? 8))));
    const maxNormalizeTopScrolls = Math.max(0, Math.min(8, Math.round(Number(process.env.QA_BET_DROPDOWN_DISCOVER_TOP_SCROLLS ?? 4))));
    const maxDownScrolls = Math.max(1, Math.min(16, Math.round(Number(process.env.QA_BET_DROPDOWN_DISCOVER_DOWN_SCROLLS ?? 8))));
    const enableFallbackScroll = process.env.QA_BET_DROPDOWN_FALLBACK_SCROLL === "1";
    let aiReads = 0;

    const readRows = async (): Promise<import("../../ai/vision.js").BetDropdownRead> => {
      aiReads++;
      if (aiReads > maxAiReads) {
        throw new Error(`AI read budget exceeded (${maxAiReads}) while enumerating bet dropdown`);
      }
      const p = path.join(debugDir, `bet-dropdown-${safeLabel}-${Date.now()}.png`);
      await writeFile(p, await page.screenshot({ type: "png", fullPage: false }));
      return transcribeBetDropdown({ screenshotPath: p, viewport: vp });
    };
    const sig = (rows: { value: number }[]) => rows.map((r) => r.value).sort((a, b) => a - b).join(",");
    const scrollOnce = async (dir: 1 | -1, beforeSig: string): Promise<import("../../ai/vision.js").BetDropdownRead | null> => {
      const methods: Array<"wheel" | "keys" | "drag"> = enableFallbackScroll ? ["wheel", "keys", "drag"] : ["wheel"];
      for (const m of methods) {
        try {
          if (m === "wheel") {
            await page.mouse.move(dropdown.x, dropdown.y);
            await page.mouse.wheel(0, dir * 260);
          } else if (m === "keys") {
            await page.mouse.click(dropdown.x, dropdown.y);
            await page.keyboard.press(dir > 0 ? "PageDown" : "PageUp");
          } else {
            await page.mouse.move(dropdown.x, dropdown.y);
            await page.mouse.down();
            await page.mouse.move(dropdown.x, dropdown.y - dir * 170, { steps: 8 });
            await page.mouse.up();
          }
        } catch { /* try next method */ }
        await page.waitForTimeout(450);
        const after = await readRows();
        if (sig(after.rows) !== beforeSig) return after;
      }
      return null;
    };

    try {
      let read = await readRows();
      if (read.rows.length === 0) return { added: 0, totalValues: 0, values: [] };

      const seen = new Map<number, { value: number; y: number }>();
      const remember = (rows: Array<{ value: number; y: number }>) => {
        for (const r of rows) {
          const value = Number(r.value.toFixed(2));
          if (!Number.isFinite(value)) continue;
          seen.set(value, { value, y: r.y });
        }
      };

      // First normalize to the top; discover may start from the current
      // selected value, so visible rows are only a middle slice.
      for (let i = 0; i < maxNormalizeTopScrolls && read.moreAbove; i++) {
        const before = sig(read.rows);
        const moved = await scrollOnce(-1, before);
        if (!moved) break;
        read = moved;
      }

      for (let i = 0; i < maxDownScrolls; i++) {
        remember(read.rows);
        if (!read.moreBelow) break;
        const before = sig(read.rows);
        const moved = await scrollOnce(1, before);
        if (!moved) break;
        read = moved;
      }

      const existingValues = new Set(
        aiElements
          .map((e) => parseDiscoveredBetOptionValue(e.key)?.value)
          .filter((v): v is number => typeof v === "number")
          .map((v) => Number(v.toFixed(2))),
      );
      let added = 0;
      const sorted = [...seen.values()].sort((a, b) => a.value - b.value);
      for (const row of sorted) {
        if (existingValues.has(row.value)) continue;
        aiElements.push({
          key: `${rowPrefix}-${row.value.toFixed(2)}`,
          x: Math.round(dropdown.x),
          y: Math.round(row.y),
          confidence: 0.55,
          role: "option",
        });
        existingValues.add(row.value);
        added++;
      }

      if (seen.size > 0) {
        console.log(`[manual/discover] ${safeLabel}: scroll-enumerated ${seen.size} bet dropdown value(s) in ${aiReads}/${maxAiReads} AI read(s) [${sorted.map((r) => r.value.toFixed(2)).join(", ")}]; row coords are snapshot-only, runtime selects by live value`);
      }
      return { added, totalValues: seen.size, values: sorted.map((r) => r.value) };
    } catch (err) {
      console.warn(`[manual/discover] ${safeLabel}: bet dropdown scroll enumeration failed: ${err instanceof Error ? err.message : String(err)}`);
      return { added: 0, totalValues: 0, values: [] };
    }
  }

  /**
   * Multi-level discovery — after QA opens a popup/sub-screen (e.g. clicks
   * buyBonusButton → popup appears), QA invokes this with a state label.
   * AI vision detects clickable elements with popup-focus prompt:
   *   - Strict instruction to return ONLY popup/overlay elements
   *   - Filter out any element whose coord overlaps a known main-state entry
   *     (within 30px) — AI sometimes still sees main controls faintly through
   *     dimmed background
   */
  async discoverSubState(
    stateLabel: string,
    opts: {
      /** Discover on a DIFFERENT page than the game page — set when the
       *  trigger opened an external browser tab (e.g. history). Screenshot,
       *  AI vision and coords all come from this page. */
      sourcePage?: import("playwright").Page;
      /** Mark added children `externalPage: true` so runtime clicks route to
       *  the captured tab instead of the game page. */
      externalPage?: boolean;
    } = {},
  ): Promise<{ ok: boolean; addedKeys?: string[]; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const safeLabel = stateLabel.trim().replace(/[^a-zA-Z0-9_]+/g, "_");
    if (!safeLabel) return { ok: false, reason: "stateLabel required (alphanumeric)" };
    const debugDir = path.join(dirForGame(this.gameSlug), "debug-subdiscover");
    await mkdir(debugDir, { recursive: true });
    try {
      // Per-popup discover hint: pin naming conventions / expected children for
      // known states (e.g. autoplay → autoCountSlide-N). The discover flow uses
      // the TRIGGER KEY as the stateLabel/namespace (e.g. "autoButton"), so the
      // hints map (keyed by trigger key) is looked up directly. Fall back to
      // matching by hint.stateLabel for ad-hoc / legacy labels.
      const hints = await resolveSubStateHints(this.gameSlug);
      const matched = hints[safeLabel] ?? Object.values(hints).find((h) => h.stateLabel === safeLabel);
      // Build the popup-discovery prompt with 3 layers:
      //   1. POPUP_FOCUS_PROMPT — general "this is a popup, ignore background".
      //   2. State-specific discoverHint (e.g. autoplay slider anchor instructions).
      //   3. Main-elements hint — explicit list of canonical main coords so AI
      //      knows EXACTLY which buttons are background bleed-through and must
      //      be skipped (matches the coord-based filter that runs post-AI).
      const stateGuidance = matched?.discoverHint
        ? `\n\n--- STATE-SPECIFIC GUIDANCE (${safeLabel}) ---\n${matched.discoverHint}`
        : "";
      const mainHint = buildMainElementsHint(this.registry);
      // Existing-children hint: AI sees which keys + coords already exist
      // under this parent → REUSES exact key names instead of inventing
      // synonyms (bet-0.40 vs betAmount-0.40). Mechanical coord dedup
      // is still applied below as a safety net.
      const { buildExistingChildrenHint } = await import("../step2-detect-ui/popup-filter.js");
      const existingHint = buildExistingChildrenHint(this.registry, safeLabel);
      const prompt = `${POPUP_FOCUS_PROMPT}${stateGuidance}${mainHint}${existingHint}`;
      if (matched?.discoverHint) {
        console.log(`[manual/discover] applied discover-hint for "${safeLabel}" (${matched.discoverHint.length} chars)`);
      }
      // Settle before the AI screenshot — popups/sub-states fade/slide in over
      // a few hundred ms, and capturing mid-animation gives the model a blurred
      // or half-rendered frame (missed/misplaced controls). One short wait here
      // covers every caller (discoverVia, /discover-state, external tab).
      const discoverPage = opts.sourcePage ?? this.session.page;
      const settleMs = Number(process.env.QA_DISCOVER_SETTLE_MS ?? 1000);
      if (settleMs > 0) await discoverPage.waitForTimeout(settleMs).catch(() => undefined);
      const result = await aiDiscoverState(discoverPage, debugDir, Date.now(), prompt);
      if (result.elements.length === 0) {
        return { ok: false, reason: "AI returned 0 elements — popup may not be visible" };
      }

      // Drop main-screen false positives — AI sometimes flags main controls
      // visible THROUGH the dimmed popup background. Deterministic safety net
      // on top of the prompt's "DO NOT include main-game buttons behind the
      // popup" instruction (which AI doesn't always honor).
      // SKIP for external tabs: their coords live on a DIFFERENT page, so a
      // coincidental overlap with a main-game coord is meaningless and would
      // wrongly drop real tab elements.
      const filtered = opts.externalPage
        ? { kept: result.elements, dropped: [] as ReturnType<typeof filterMainOverlap>["dropped"] }
        : filterMainOverlap(result.elements, this.registry);
      if (filtered.dropped.length > 0) {
        const sample = filtered.dropped.slice(0, 5).map((d) => `${d.key}@(${d.x},${d.y})→${d.overlapsMainKey}`).join("; ");
        console.log(`[manual/discover] dropped ${filtered.dropped.length}/${result.elements.length} main-overlap false positives: ${sample}${filtered.dropped.length > 5 ? "…" : ""}`);
      }
      if (filtered.kept.length === 0) {
        return { ok: false, reason: `AI returned ${result.elements.length} elements but ALL overlapped main-screen controls — popup likely not open or fully transparent. Re-open the popup and retry.` };
      }
      // Use the FILTERED list from here on (snapshot + registry).
      const aiElements = filtered.kept;

      // Replay-stable row keys: the AI sometimes names a repeated row list with
      // the row's SESSION/SPIN ID (e.g. `expandRow-01KV9GTV…` / `expandRow-Xhsa…`)
      // instead of a positional index. Those IDs change every session, so a
      // testcase referencing them never matches on replay. Deterministically
      // renumber any base whose suffix is an ID (non-numeric) to a positional
      // index by vertical row order (`expandRow-1..N`). Numeric/value suffixes
      // (`bet-0.40`, `autoCountSlide-10`) are meaningful + stable → left alone.
      normalizeVolatileRowKeys(aiElements);

      // Scrollable bet dropdowns only expose a slice of their option ladder at
      // any one scrollbar position. Enumerate the list by scrolling now, but
      // keep runtime selection value-driven (the executor ignores stale row
      // coords for dropdown bet values and re-locates the value live).
      await this.enrichScrollableBetDropdownOptions(discoverPage, safeLabel, aiElements, debugDir);
      const snapshotElements = [...aiElements];

      // Persist the AI's view of this state for visual QA review. Save with
      // NAMESPACED keys (matching the registry) so the dashboard can cross-ref
      // each marker against current verify status by key. Non-fatal on error.
      try {
        await saveDiscoverySnapshot(
          this.gameSlug,
          safeLabel,
          result.pngBuf,
          snapshotElements.map((e) => ({
            key: `${safeLabel}__${e.key}`,
            x: e.x,
            y: e.y,
            confidence: e.confidence,
            role: e.role,
          })),
          "discover-substate",
        );
      } catch (err) {
        console.warn(`[manual/snapshot] failed to save discovery snapshot for ${safeLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // No dedup — QA wants every AI-returned element registered, even if
      // the coord overlaps an existing entry (e.g., betMinus and betPlus open
      // the SAME panel → same physical chips under different parent namespaces;
      // both names are legitimate keys the AI translator may reference).
      // Same-key under same parent will overwrite (idempotent re-discover).
      // Coord-overlap skip: AI may label the same chip differently across
      // runs (`bet-0.40` vs `betAmount-0.40`). When a NEW emission lands
      // within COORD_OVERLAP_TOLERANCE px of an EXISTING VERIFIED entry
      // under the same parent namespace, treat it as synonym + skip
      // (verified wins). Mirrors the graph-explorer dedup added 2026-06-05.
      const COORD_OVERLAP_TOLERANCE = 12;
      const verifiedSiblings: Array<{ key: string; x: number; y: number }> = [];
      for (const [key, regEl] of Object.entries(this.registry)) {
        if (!regEl) continue;
        if (regEl.verifiedBy !== "QA" && regEl.verifiedBy !== "probe") continue;
        if (!key.startsWith(`${safeLabel}__`)) continue;
        verifiedSiblings.push({ key, x: regEl.x, y: regEl.y });
      }
      const addedKeys: string[] = [];
      const overwrittenKeys: string[] = [];
      const skippedDuplicates: Array<{ proposed: string; matchedExisting: string }> = [];
      const now = new Date().toISOString();
      for (const e of aiElements) {
        const namespacedKey = `${safeLabel}__${e.key}`;
        const overlap = verifiedSiblings.find(
          (s) => Math.abs(s.x - Math.round(e.x)) <= COORD_OVERLAP_TOLERANCE
              && Math.abs(s.y - Math.round(e.y)) <= COORD_OVERLAP_TOLERANCE
              && s.key !== namespacedKey,
        );
        if (overlap) {
          skippedDuplicates.push({ proposed: namespacedKey, matchedExisting: overlap.key });
          continue;
        }
        const wasPresent = Boolean(this.registry[namespacedKey]);
        const el: UiElement = {
          x: Math.round(e.x),
          y: Math.round(e.y),
          strategy: "ai_vision",
          confidence: e.confidence ?? 0.8,
          detectedAt: now,
          status: "pending",
          // Children discovered on an external tab: runtime clicks must route
          // to the captured tab, not the game page (case-executor honors this).
          ...(opts.externalPage ? { externalPage: true } : {}),
        };
        this.registry[namespacedKey] = el;
        this.verifyState[namespacedKey] = "pending";
        if (wasPresent) overwrittenKeys.push(namespacedKey);
        else addedKeys.push(namespacedKey);
      }
      if (skippedDuplicates.length > 0) {
        const sample = skippedDuplicates.slice(0, 5).map((d) => `${d.proposed}→${d.matchedExisting}`).join("; ");
        console.log(`[manual/discover] dedup: skipped ${skippedDuplicates.length} AI emissions that overlap verified entries (synonym names): ${sample}${skippedDuplicates.length > 5 ? "…" : ""}`);
      }
      if (overwrittenKeys.length > 0) {
        console.log(`[manual/discover] overwrote ${overwrittenKeys.length} existing entries with fresh coords: ${overwrittenKeys.slice(0, 5).join(", ")}`);
      }

      // Continuous-slider stop synthesis: if this state has sliderMarks config
      // and the AI returned both track-end anchors, interpolate the discrete
      // stops EVENLY between them. Coords are ESTIMATED (low confidence) — QA
      // re-picks for precision. Anchors are then removed (the marks replace them).
      const sm = matched?.sliderMarks;
      if (sm) {
        const minEl = this.registry[`${safeLabel}__${sm.minAnchor}`];
        const maxEl = this.registry[`${safeLabel}__${sm.maxAnchor}`];
        if (minEl && maxEl && sm.values.length > 0) {
          const n = sm.values.length;
          const stops = interpolateSliderStops(minEl, maxEl, sm.values);
          for (const stop of stops) {
            const key = `${safeLabel}__${sm.keyPrefix}-${stop.value}`;
            const wasPresent = Boolean(this.registry[key]);
            this.registry[key] = {
              x: stop.x,
              y: stop.y,
              strategy: "ai_vision",
              confidence: 0.4, // estimated — QA must re-pick
              detectedAt: now,
              status: "pending",
            };
            this.verifyState[key] = "pending";
            if (!wasPresent) addedKeys.push(key);
          }
          // Remove the raw anchors — the synthesized marks supersede them.
          delete this.registry[`${safeLabel}__${sm.minAnchor}`];
          delete this.registry[`${safeLabel}__${sm.maxAnchor}`];
          delete this.verifyState[`${safeLabel}__${sm.minAnchor}`];
          delete this.verifyState[`${safeLabel}__${sm.maxAnchor}`];
          console.log(`[manual/discover] synthesized ${n} slider stops ${sm.keyPrefix}-{${sm.values.join(",")}} between anchors (estimated — QA re-pick) for ${safeLabel}`);
        } else {
          console.log(`[manual/discover] sliderMarks configured for ${safeLabel} but anchors not found (min=${!!minEl} max=${!!maxEl}) — skipped synthesis`);
        }
      }
      console.log(`[manual/discover] ${addedKeys.length} new + ${overwrittenKeys.length} overwritten under ${safeLabel}__*`);
      await uiRegistry.save(this.gameSlug, this.registry);
      // Auto-probe newly-added probeable elements (P1 of "AI auto-discover").
      // Discover happens at the sub-state we just entered; only canonical
      // main-screen-style keys (spinButton, betPlus, etc.) probe meaningfully
      // here — sub-state-scoped keys typically aren't probeable in P1.
      const probeable = addedKeys.filter((k) => inferProbeKind(k) != null);
      let probe: Awaited<ReturnType<typeof this.probePendingElements>> | undefined;
      if (probeable.length > 0) {
        probe = await this.probePendingElements({ onlyKeys: probeable });
      }
      return { ok: true, addedKeys, ...(probe ? { probe } : {}) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * P1 of AI auto-discover — runtime self-validation gate. For each element
   * with status="pending" that has a probe defined (inferProbeKind), click the
   * proposed coord and observe a signal (network response / popup keyword).
   * On success: flip to verified + verifiedBy="probe" + record the signal tag.
   * On failure: stay pending for QA. Probes use offset retry (±5/10px) to
   * absorb AI-vision coord drift. Each probe leaves the game on MAIN.
   */
  async probePendingElements(
    opts: { onlyKeys?: string[] } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    probed: number;
    verified: number;
    failed: number;
    skipped: number;
    results: Array<{ key: string; ok: boolean; probed: boolean; signal?: string; reason?: string; attempts: number }>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session", probed: 0, verified: 0, failed: 0, skipped: 0, results: [] };
    }
    // Pre-flight: ensure on main before probing (a leftover popup would
    // sabotage every probe — main-state recovery is the runner's job here).
    const pre = await this.waitForMainScreen({ maxWaitMs: 30_000 });
    if (!pre.onMain) {
      return { ok: false, reason: `not on main before probe (${pre.reason ?? "unknown"})`, probed: 0, verified: 0, failed: 0, skipped: 0, results: [] };
    }

    const allCandidates: Array<[string, UiElement]> = [];
    for (const [key, el] of Object.entries(this.registry)) {
      if (!el) continue;
      if (opts.onlyKeys && !opts.onlyKeys.includes(key)) continue;
      if (el.status !== "pending") continue;
      allCandidates.push([key, el]);
    }

    // Split: canonical (key has NO `__`) vs sub-state (namespaced via __).
    // Canonical probes assume game-on-main + look for kind-specific signals
    // (gameService response, popup OCR, bet display change). Sub-state probes
    // need the parent popup OPEN — handled in a separate sub-state loop
    // below that walks the FULL trigger chain (level 1 → 2 → 3 …) for each
    // candidate so probes can verify elements at any depth, not just
    // first-level popups.
    const candidates: Array<[string, UiElement]> = [];
    const subStateCandidates: Array<[string, UiElement]> = [];
    for (const [key, el] of allCandidates) {
      if (key.includes("__")) {
        subStateCandidates.push([key, el]);
      } else {
        candidates.push([key, el]);
      }
    }
    // Sort sub-state candidates by depth ascending (level 1 first, then 2,
    // then 3) — probing a parent before its descendants means the parent
    // is verified by the time we walk the chain, satisfying the
    // "trigger-chain fully verified" check below.
    subStateCandidates.sort(([a], [b]) => a.split("__").length - b.split("__").length);

    const results: Array<{ key: string; ok: boolean; probed: boolean; signal?: string; reason?: string; attempts: number }> = [];
    let probed = 0, verified = 0, failed = 0, skipped = 0;
    for (const [key, el] of candidates) {
      // Re-ensure main between probes (the previous popup-kind probe just
      // recovered, but be defensive — a slow dismiss could leak otherwise).
      await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
      const r: ProbeResult = await probeElement(this.session.page, key, el);
      results.push({ key, ok: r.ok, probed: r.probed, signal: r.signal, reason: r.reason, attempts: r.attempts });
      if (!r.probed) { skipped++; continue; }
      probed++;
      if (r.ok) {
        verified++;
        if (r.finalCoord) { el.x = r.finalCoord.x; el.y = r.finalCoord.y; }
        el.status = "verified";
        el.verifiedBy = "probe";
        el.verifiedAt = new Date().toISOString();
        el.probeSignal = r.signal;
        this.verifyState[key] = "confirmed";
        console.log(`[manual/probe] ${key} VERIFIED via ${r.signal} (attempts=${r.attempts})`);
      } else {
        // Option B: probe failed (signal not seen after offset retries). For
        // CANONICAL keys we have a description for, invoke the stateful
        // crop-verify AGENT (Claude Agent SDK with conversation memory — the
        // agent iteratively crops + verifies + adjusts, learning from previous
        // attempts within ONE session). Then re-probe with the refined coord.
        const baseDescription = describeCanonicalElement(key);
        if (baseDescription) {
          // Enrich with spin anchor when spinButton has a finite coord.
          // Adjacent canonical buttons (autoButton, betPlus/Minus) commonly
          // drift onto spin without a measurable reference. The agent's
          // description now carries "spinButton is at (X, Y); your target is
          // ~80px right of it" which materially cuts the drift rate.
          const spinCoord =
            this.registry.spinButton && Number.isFinite(this.registry.spinButton.x) && Number.isFinite(this.registry.spinButton.y)
              ? { x: this.registry.spinButton.x, y: this.registry.spinButton.y }
              : null;
          const description = enrichDescriptionWithSpinAnchor(key, baseDescription, spinCoord);
          console.log(`[manual/probe] ${key} probe failed — invoking stateful crop-verify agent${spinCoord && key !== "spinButton" ? ` (anchor=spin@(${spinCoord.x},${spinCoord.y}))` : ""}…`);
          await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
          const cdpEndpoint = this.session.cdpEndpoint;
          let cv: AgentLocateResult;
          if (!cdpEndpoint) {
            cv = { ok: false, reason: "no CDP endpoint on session — cannot run Playwright-MCP agent" };
          } else {
            try {
              cv = await cropVerifyAgent({ description, label: key, cdpEndpoint, outputDir: path.join(dirForGame(this.gameSlug), "debug-agent") });
            } catch (err) {
              cv = { ok: false, reason: err instanceof Error ? err.message : String(err) };
            }
          }
          if (cv.ok && typeof cv.x === "number" && typeof cv.y === "number") {
            const moved = Math.abs(cv.x - el.x) > 5 || Math.abs(cv.y - el.y) > 5;
            if (moved) {
              el.x = cv.x;
              el.y = cv.y;
              el.strategy = "ai_vision";
              el.confidence = 0.85; // agent converged on a verified-centered crop
              console.log(`[manual/probe] ${key} agent refined → (${cv.x},${cv.y}) turns=${cv.turnsUsed ?? "?"}; re-probing…`);
              await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
              const r2 = await probeElement(this.session.page, key, el);
              if (r2.ok) {
                verified++;
                if (r2.finalCoord) { el.x = r2.finalCoord.x; el.y = r2.finalCoord.y; }
                el.status = "verified";
                el.verifiedBy = "probe";
                el.verifiedAt = new Date().toISOString();
                el.probeSignal = `${r2.signal} (via crop-verify agent fallback)`;
                this.verifyState[key] = "confirmed";
                const row = results[results.length - 1]!;
                row.ok = true;
                row.signal = el.probeSignal;
                row.reason = undefined;
                console.log(`[manual/probe] ${key} VERIFIED after agent refine (signal=${r2.signal})`);
                continue;
              }
              console.log(`[manual/probe] ${key} still fails after agent refine — stays pending`);
            } else {
              console.log(`[manual/probe] ${key} agent returned same coord (drift ≤ 5px) — skipping re-probe`);
            }
          } else {
            console.log(`[manual/probe] ${key} agent did not commit a coord — ${cv.reason ?? "unknown"}`);
          }
        }
        failed++;
        console.log(`[manual/probe] ${key} stays pending — ${r.reason} (attempts=${r.attempts})`);
      }
    }

    // Sub-state pass — multi-level trigger-chain navigation. For each
    // candidate key like "paytableButton__nextPageButton__symbolButton" the
    // chain is ["paytableButton", "paytableButton__nextPageButton"]: click
    // them in sequence from main and we end up in the state where
    // symbolButton lives. After probing, dismiss everything so the next
    // candidate starts from main again.
    //
    // Why per-candidate (not per-trigger group): probing one element in a
    // popup can flip a toggle / advance a page / open a sub-popup. The next
    // candidate's coord was discovered against the ORIGINAL popup baseline,
    // not the post-click state. Re-opening from main between probes is the
    // simplest way to guarantee a clean baseline — slower but correct.
    //
    // Ordering: candidates were sorted by depth ascending above, so level-1
    // elements are probed BEFORE their level-2 descendants. By the time we
    // walk a level-3 chain like [A, A__B, A__B__C], A and A__B will have
    // been verified earlier in the same run.
    const triggerChainOf = (uiKey: string): string[] => {
      const parts = uiKey.split("__");
      if (parts.length < 2) return [];
      const chain: string[] = [];
      for (let i = 1; i < parts.length; i++) chain.push(parts.slice(0, i).join("__"));
      return chain;
    };

    for (const [key, el] of subStateCandidates) {
      const chain = triggerChainOf(key);
      // Verify every trigger in the chain is verified — clicking an
      // unverified trigger risks landing on a wrong button (e.g. spin →
      // costs real bet). If even one link is unverified, skip the
      // candidate; it'll get re-tried in a subsequent run after QA
      // verifies the parents.
      let chainOk = true;
      let badLink: string | null = null;
      for (const t of chain) {
        const tEl = this.registry[t];
        if (!tEl || (tEl.verifiedBy !== "QA" && tEl.verifiedBy !== "probe")) {
          chainOk = false;
          badLink = t;
          break;
        }
      }
      if (!chainOk) {
        results.push({ key, ok: false, probed: false, reason: `trigger chain broken at "${badLink}" (not verified)`, attempts: 0 });
        skipped++;
        continue;
      }

      // Ensure main → walk trigger chain → probe → dismiss.
      const main1 = await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
      if (!main1 || !main1.onMain) {
        results.push({ key, ok: false, probed: false, reason: "couldn't reach main before opening popup chain", attempts: 0 });
        skipped++;
        continue;
      }
      let navOk = true;
      for (const t of chain) {
        const tEl = this.registry[t]!;
        try {
          await this.session.page.mouse.click(tEl.x, tEl.y);
          await this.session.page.waitForTimeout(2000);
        } catch (err) {
          results.push({ key, ok: false, probed: false, reason: `chain nav click failed at "${t}": ${err instanceof Error ? err.message : String(err)}`, attempts: 0 });
          navOk = false;
          break;
        }
      }
      if (!navOk) {
        skipped++;
        try { await dismissPopupsLoop(this.session.page, { maxAttempts: 3 }); } catch {}
        continue;
      }
      if (chain.length > 1) {
        console.log(`[manual/probe] navigating ${chain.length}-deep chain for ${key}: ${chain.join(" → ")}`);
      }

      // Verify via AI agent (2026-06-01 — replaces pixel-diff probe).
      // The agent clicks the coord ONCE, screenshots before/after, reads
      // recent network requests, and reasons about whether the response
      // matches the expected behavior derived from the key name. This is
      // the same observe-and-judge pattern the upstream code-gen tool
      // (logic-data-crawler-creator) uses, adapted to per-element
      // verification.
      //
      // WHY agent over pixel-diff: pixel-diff just measures "did the
      // screen change", which 10+ ghost namespaces in the previous run
      // exploited — clicking at wrong coord still produced visible
      // change (canvas tap → spin, click on spin coord through namespace
      // → reels spin → 67.9% pixDiff falsely "verified"). The agent
      // reads the SAME signals a human QA would (screenshot, network)
      // and rejects ghost responses ("you clicked spinButton again,
      // not a sub-state element"). No hardcoded threshold can substitute
      // for that judgment.
      let finalResult: ProbeResult;
      let agentTurns: number | undefined;
      if (!this.session.cdpEndpoint) {
        finalResult = { ok: false, probed: false, attempts: 0, reason: "no CDP endpoint — cannot run verify agent" };
      } else {
        const stateContext = chain.length > 0
          ? `Inside the popup opened by the trigger chain: ${chain.join(" → ")}.`
          : undefined;
        const expectedBehavior = expectedBehaviorFor(key);
        try {
          const v = await verifyClickAgent({
            cdpEndpoint: this.session.cdpEndpoint,
            coord: { x: el.x, y: el.y },
            elementKey: key,
            expectedBehavior,
            stateContext,
            outputDir: path.join(dirForGame(this.gameSlug), "debug-agent"),
          });
          agentTurns = v.turnsUsed;
          if (v.ok) {
            finalResult = {
              ok: true,
              probed: true,
              signal: `agentVerified: ${v.reason.slice(0, 120)}`,
              attempts: 1,
              finalCoord: { x: el.x, y: el.y },
            };
          } else {
            finalResult = {
              ok: false,
              probed: true,
              attempts: 1,
              reason: `agent rejected: ${v.reason.slice(0, 160)}`,
            };
          }
        } catch (err) {
          finalResult = {
            ok: false,
            probed: true,
            attempts: 1,
            reason: `agent threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      results.push({ key, ok: finalResult.ok, probed: finalResult.probed, signal: finalResult.signal, reason: finalResult.reason, attempts: finalResult.attempts });
      if (!finalResult.probed) {
        skipped++;
      } else if (finalResult.ok) {
        probed++;
        verified++;
        if (finalResult.finalCoord) { el.x = finalResult.finalCoord.x; el.y = finalResult.finalCoord.y; }
        el.status = "verified";
        el.verifiedBy = "probe";
        el.verifiedAt = new Date().toISOString();
        el.probeSignal = finalResult.signal;
        this.verifyState[key] = "confirmed";
        console.log(`[manual/probe] ${key} VERIFIED via agent (turns=${agentTurns ?? "?"}): ${finalResult.signal}`);
      } else {
        probed++;
        failed++;
        console.log(`[manual/probe] ${key} stays pending (turns=${agentTurns ?? "?"}) — ${finalResult.reason}`);
      }
      // Aggressive state recovery between sub-state probes (2026-06-01 — max
      // quality requirement). A single dismissPopupsLoop is not enough when
      // the agent's click triggered a real action with delayed side-effects:
      //   - startAutoplayButton → autoplay loop fires N spins; until stopped,
      //     every subsequent probe sees autoplay state instead of expected
      //     parent popup and gets rejected on context mismatch.
      //   - confirmButton (buy bonus) → free-spin chain starts; chain takes
      //     5-15 minutes to play out by itself.
      //   - Any click that opens a popup chain → may need ESC + corner-click
      //     multiple times.
      //
      // forceRecoverToMain loops: stopAutoplayIfActive (catches auto-spin),
      // waits for FS chain to end (OCR no longer matches "free spins"
      // without popup-content discriminators), dismisses popups, and only
      // returns when game is verifiably on main. Times out at 15 min — at
      // that point caller logs and moves on (rare edge case where game
      // is stuck and QA must intervene).
      try {
        await this.forceRecoverToMain({ maxWaitMs: 15 * 60 * 1000 });
      } catch (err) {
        console.warn(`[manual/probe] force-recover after ${key} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await uiRegistry.save(this.gameSlug, this.registry);
    return { ok: true, probed, verified, failed, skipped, results };
  }

  /**
   * Synthesize slider-stop chips for every trigger whose sub-state-hints have
   * a `sliderMarks` config (e.g. autoButton → autoCountSlide-{10,20,30,50,
   * 70,100,500,1000}). Reads the min/max anchor elements the AI detected,
   * interpolates the discrete values evenly between them, writes the chip
   * keys, then removes the raw anchors. Idempotent — chip keys already in the
   * registry are not overwritten. Used by both discoverSubState (per-row
   * Discover) and deepDiscover (Deep Discover / Auto-Onboard).
   */
  private async synthesizeSliderStopsForAllHints(): Promise<string[]> {
    const warnings: string[] = [];
    if (!this.gameSlug || !this.registry) return warnings;
    const hints = await resolveSubStateHints(this.gameSlug);
    let synthesizedAny = false;
    for (const [triggerKey, hint] of Object.entries(hints)) {
      const sm = hint.sliderMarks;
      if (!sm) continue;
      const minEl = this.registry[`${triggerKey}__${sm.minAnchor}`];
      const maxEl = this.registry[`${triggerKey}__${sm.maxAnchor}`];
      if (!minEl || !maxEl || sm.values.length === 0) {
        const msg = `slider-synth ${triggerKey}: anchors not found (min=${!!minEl} max=${!!maxEl}) — ${sm.keyPrefix}-N chips NOT registered. Re-run Discover on ${triggerKey} row, or Pick the missing anchor(s) manually.`;
        console.warn(`[manual/slider-synth] ${msg}`);
        warnings.push(msg);
        continue;
      }
      const stops = interpolateSliderStops(minEl, maxEl, sm.values);
      const now = new Date().toISOString();
      let added = 0;
      for (const stop of stops) {
        const key = `${triggerKey}__${sm.keyPrefix}-${stop.value}`;
        if (this.registry[key]) continue;
        this.registry[key] = {
          x: stop.x,
          y: stop.y,
          strategy: "ai_vision",
          confidence: 0.4,
          detectedAt: now,
          status: "pending",
        };
        this.verifyState[key] = "pending";
        added++;
      }
      // Remove the raw anchors so the chips supersede them.
      delete this.registry[`${triggerKey}__${sm.minAnchor}`];
      delete this.registry[`${triggerKey}__${sm.maxAnchor}`];
      delete this.verifyState[`${triggerKey}__${sm.minAnchor}`];
      delete this.verifyState[`${triggerKey}__${sm.maxAnchor}`];
      console.log(`[manual/slider-synth] ${triggerKey}: synthesized ${added}/${sm.values.length} ${sm.keyPrefix}-{${sm.values.join(",")}} between anchors`);
      synthesizedAny = true;
    }
    if (synthesizedAny) await uiRegistry.save(this.gameSlug, this.registry);
    return warnings;
  }

  /**
   * P2 of AI auto-discover — recursive deep exploration. Reuses the cold-start
   * `exploreUiGraph` (DFS with safe-click whitelist, state hashing/dedup,
   * navigate-back, bounded by maxDepth/maxAiCalls/maxStates). After the explorer
   * merges newly-discovered states' elements into the registry, we auto-probe
   * any probeable new keys via `probePendingElements` (P1 chain). End result:
   * one click → graph of UI states explored → elements auto-verified where
   * possible → only un-probeable elements left pending for QA.
   */
  async deepDiscover(
    opts: { maxDepth?: number; maxAiCalls?: number; maxStates?: number; triggerHints?: Record<string, string> } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    addedKeys?: string[];
    statesDiscovered?: number;
    transitionsRecorded?: number;
    aiCallsUsed?: number;
    elapsedMs?: number;
    warnings?: string[];
    /** Per-key explanation of why the explorer did or didn't try a click.
     *  Critical for diagnosing "0 elements discovered" — usually means every
     *  registry key was skipped by the safe-click whitelist. */
    safetyReport?: { clickable: string[]; skipped: Array<{ key: string; reason: string }> };
    probe?: Awaited<ReturnType<typeof this.probePendingElements>>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session" };
    }
    const pre = await this.waitForMainScreen({ maxWaitMs: 30_000 });
    if (!pre.onMain) return { ok: false, reason: `not on main before deep-discover (${pre.reason ?? "unknown"})` };
    // Halt-on-error pre-check. Game-engine errors (PP "Internal server
    // error. The game will be restarted." modal) block all clicks +
    // would silently waste 10-30 minutes of Discover effort. Detect
    // once here; throw early so caller surfaces the banner to QA.
    await this.detectAndRecordGameError("deepDiscover/start");

    // Re-detect policy (2026-05-29): Deep Discover treats unverified entries as
    // stale candidates from prior AI runs and CLEARS them before re-detecting.
    // QA-verified and probe-verified entries are preserved as ground truth.
    const cleared: string[] = [];
    for (const [key, el] of Object.entries(this.registry)) {
      if (!el) continue;
      if (el.verifiedBy === "QA" || el.verifiedBy === "probe") continue;
      delete this.registry[key];
      delete this.verifyState[key];
      cleared.push(key);
    }
    if (cleared.length > 0) {
      await uiRegistry.save(this.gameSlug, this.registry);
      console.log(`[manual/deep-discover] cleared ${cleared.length} unverified entries for re-detection: ${cleared.slice(0, 8).join(",")}${cleared.length > 8 ? "…" : ""}`);
    }

    // Seed main-screen via AI vision when canonical keys are missing — lets
    // Start session be cheap (browser only) and concentrate ALL AI work in this
    // deep-discover / auto-onboard flow. Captured AFTER the clear so re-detected
    // keys count as `addedKeys` and downstream probe runs on them.
    const before = new Set(Object.keys(this.registry));
    // Seed main-screen via batch ai-vision (one call returns all detected
    // elements). Fast — ~5-10s. The trade-off vs the crop-verify locator is
    // coord drift (~10-50px on canvas slots), which is handled DOWNSTREAM by
    // the probe step + a crop-verify fallback when probe fails (Option B
    // 2026-05-30). Verified entries (QA/probe) are preserved.
    const missingCanonical = LEVEL1_EXPECTED_KEYS.filter((k) => {
      const el = this.registry[k];
      if (!el) return true;
      return el.verifiedBy !== "QA" && el.verifiedBy !== "probe";
    });
    if (missingCanonical.length > 0) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: missing canonical main keys [${missingCanonical.join(",")}] — waiting for canvas to settle before AI seed…`);
      try {
        await waitUntilStable(this.session.page, {
          maxIterations: 10,
          changeThreshold: 0.01,
          consecutiveStable: 2,
        });
      } catch (err) {
        console.warn(`[manual/deep-discover] waitUntilStable warning: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.session.page.waitForTimeout(2000);
      console.log(`[manual/deep-discover] canvas settled — running AI vision`);
      const prevVerify = process.env.QA_UI_VERIFY_LOOP;
      process.env.QA_UI_VERIFY_LOOP = "0";
      try {
        const { uiMap } = await discoverUi(this.session.page, { slug: this.gameSlug });
        let seededCount = 0;
        for (const [key, el] of Object.entries(uiMap)) {
          if (!el) continue;
          const existing = this.registry[key];
          if (existing && (existing.verifiedBy === "QA" || existing.verifiedBy === "probe")) continue;
          this.registry[key] = el;
          this.verifyState[key] = "pending";
          seededCount++;
        }
        await uiRegistry.save(this.gameSlug, this.registry);
        console.log(`[manual/deep-discover] seeded ${seededCount} main-screen elements (verified entries preserved): ${Object.keys(uiMap).slice(0, 12).join(",")}${Object.keys(uiMap).length > 12 ? "…" : ""}`);
        if (seededCount === 0 && Object.keys(this.registry).length === 0) {
          return {
            ok: false,
            reason: "AI seeded 0 elements — the game canvas may still be loading or the screen is unrecognizable. Wait 10–20s after Start, then try again.",
          };
        }

        // Cluster check (2026-05-31). The batch AI-vision occasionally returns
        // a tight cluster of canonical coords (≥3 within ~80px), which is
        // virtually always a vision-failure mode — real slot UIs spread main
        // controls across the bottom row. When that happens, every cluster
        // entry will fail probe AND the crop-verify fallback gets pulled
        // toward the same wrong region (one wrong neighbor → same wrong
        // coord). Detect it here and re-discover the cluster keys per-element
        // BEFORE probe runs, so each element gets the agent's full attention
        // with a clean spinButton anchor.
        //
        // Hybrid policy: batch is the default path (cheap, usually correct);
        // per-element kicks in ONLY when the cluster heuristic trips. Cost
        // stays low on healthy games; recovery is automatic on broken ones.
        const cluster = detectCanonicalCluster(this.registry, LEVEL1_EXPECTED_KEYS);
        if (cluster.detected && this.session.cdpEndpoint) {
          console.warn(
            `[manual/deep-discover] batch seed produced suspicious cluster: ` +
            `[${cluster.keys.join(",")}] within 80px of centroid (${cluster.centroid?.x},${cluster.centroid?.y}) — ` +
            `re-discovering per-element with spinButton anchor`,
          );
          // Clear the cluster entries (verified ones stay; cluster detection
          // already excluded them). Per-element will rebuild from scratch
          // with crop-verify agent.
          for (const k of cluster.keys) {
            delete this.registry[k];
            delete this.verifyState[k];
          }
          const pe = await discoverCanonicalPerElement(this.session.page, {
            cdpEndpoint: this.session.cdpEndpoint,
            existingRegistry: this.registry,
            onlyKeys: cluster.keys,
            outputDir: path.join(dirForGame(this.gameSlug), "debug-agent"),
          });
          for (const [key, el] of Object.entries(pe.registry)) {
            if (!el) continue;
            // Preserve any QA/probe-verified entry from this.registry — pe
            // already skipped overwriting them, but guard here too in case
            // verification raced.
            const existing = this.registry[key];
            if (existing && (existing.verifiedBy === "QA" || existing.verifiedBy === "probe")) continue;
            this.registry[key] = el;
            this.verifyState[key] = this.verifyState[key] ?? "pending";
          }
          await uiRegistry.save(this.gameSlug, this.registry);
          console.log(
            `[manual/deep-discover] per-element re-discovery: ` +
            `discovered=[${pe.discovered.join(",")}] notFound=[${pe.notFound.join(",")}] failed=${pe.failed.length}`,
          );
        }
      } finally {
        if (prevVerify === undefined) delete process.env.QA_UI_VERIFY_LOOP;
        else process.env.QA_UI_VERIFY_LOOP = prevVerify;
      }
    }

    // Pre-compute safe-click report so the user can SEE why exploration may
    // have nothing to click (e.g., all registry keys conservative-skipped).
    const safetyReport: { clickable: string[]; skipped: Array<{ key: string; reason: string }> } = {
      clickable: [],
      skipped: [],
    };
    for (const key of Object.keys(this.registry)) {
      const reason = explainSafety(key);
      if (reason === "safe") safetyReport.clickable.push(key);
      else safetyReport.skipped.push({ key, reason });
    }
    const aggressiveMode = process.env.QA_AGGRESSIVE_DISCOVER === "1";
    console.log(`[manual/deep-discover] ${this.gameSlug}: safety report — ${safetyReport.clickable.length} clickable, ${safetyReport.skipped.length} skipped (mode: ${aggressiveMode ? "AGGRESSIVE (QA_AGGRESSIVE_DISCOVER=1)" : "PRODUCTION-SAFE"})`);
    if (safetyReport.clickable.length === 0) {
      return {
        ok: false,
        reason: `no safe-to-click elements in registry — the explorer can't open anything to explore (${safetyReport.skipped.length} elements skipped). See safetyReport for details.`,
        safetyReport,
      };
    }

    // Pre-explorer canonical probe (2026-06-01). The explorer iterates the
    // safe-clickable canonical buttons and OPENS THEIR POPUPS to discover
    // sub-state elements. If the canonical coords are still WRONG at this
    // point (typical when batch AI vision misplaces them but the cluster
    // heuristic didn't trip — observed 2026-06-01 on vswaysmahwin2 where
    // spinButton was at (1130,685) but real was (985,685)), explorer clicks
    // miss every popup → popup-filter drops the AI-hallucinated main
    // elements → 0 sub-state in registry → no level 2 at all. Refining
    // canonical coords HERE — via the standard probe flow with agent
    // fallback — costs ~$3-8 extra but is the difference between a fully
    // populated registry and an empty one.
    // anteButton included here so probe refines its coord (via
    // genericToggle path — click → verify pixel diff → restore) BEFORE
    // normalizeAnteOff runs. Without this, normalize uses raw AI-vision
    // coord (~5-30px drift typical) which can miss the toggle and bail
    // Discover. Probe's offset-retry pattern lands much more reliably.
    // historyButton EXCLUDED — it lives inside the menu popup, not on main
    // (localizing it here yields a hallucinated main-screen coord). Discover it
    // as menuButton__historyButton via the per-row [Discover] flow. Mirrors the
    // note in EXPECTED_UI_ELEMENTS_DEFAULTS / CANONICAL_PRIORITY_ORDER.
    const PRE_EXPLORE_CANONICAL = ["spinButton", "betPlus", "betMinus", "menuButton", "paytableButton", "autoButton", "buyBonusButton", "anteButton"];
    const preProbeKeys = PRE_EXPLORE_CANONICAL.filter((k) => {
      const el = this.registry[k];
      if (!el) return false;
      return el.status === "pending"; // verified entries skip
    });
    if (preProbeKeys.length > 0) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: pre-explorer probe refining ${preProbeKeys.length} canonical: [${preProbeKeys.join(",")}]`);
      const preProbe = await this.probePendingElements({ onlyKeys: preProbeKeys });
      console.log(`[manual/deep-discover] pre-explorer probe done: verified=${preProbe.verified} failed=${preProbe.failed} skipped=${preProbe.skipped}`);
    }

    // Ante normalize — runs BEFORE the graph explorer opens any popup.
    // If the registry has anteButton, force it OFF + capture a baseline
    // PNG. This guarantees popups like bet_settings get discovered with
    // BASE bet values (not ante-inflated). Without this, a Discover run
    // that happens to start with ante ON would permanently bake wrong
    // chip values into the registry. Skipped silently when no
    // anteButton (games without the feature). Failure here ABORTS
    // discover — better than poisoning the registry.
    // ante-normalize phase tracking. Status surfaces in autoOnboardPhases
    // so QA sees a discrete row in the dashboard progress panel. When
    // running outside autoOnboard (e.g. manual /deep-discover endpoint),
    // startPhase silently no-ops (phase array may not be initialized) —
    // safe.
    if (this.registry["anteButton"]) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: ▶ PHASE — Ante Normalize (anteButton present, will enforce OFF before exploration)`);
      // Pre-flight: pre-explorer probe may have left a popup open (e.g.
      // betPlus/betMinus probe opened the bet-selector popup as its last
      // action and probePendingElements only re-asserts main BEFORE each
      // probe, not after the final one). normalizeAnteOff clicks
      // anteButton, which can be blocked / hijacked by an open popup.
      // Reach main first.
      await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
      this.startPhase("ante-normalize");
      const norm = await normalizeAnteOff(this.session.page, this.gameSlug, this.registry);
      if (!norm.ok) {
        this.endPhase("ante-normalize", "fail", norm.reason?.slice(0, 80));
        return {
          ok: false,
          reason: `ante normalize failed (tier=${norm.detectionTier}): ${norm.reason ?? "unknown"}. Discover aborted to avoid contaminating registry with ante-inflated bet values.`,
          safetyReport,
        };
      }
      // Persist baseline path into registry entry so runtime ensure_ante_off
      // + discover-time guards can find it later.
      if (norm.baselinePath && this.registry["anteButton"]) {
        this.registry["anteButton"]!.offBaseline = path.relative(dirForGame(this.gameSlug), norm.baselinePath);
        await uiRegistry.save(this.gameSlug, this.registry);
      }
      this.endPhase(
        "ante-normalize",
        "ok",
        `${norm.initialState === "off" ? "already OFF" : `flipped ${norm.initialState}→off`} · tier=${norm.detectionTier} · ${norm.toggledCount} toggle${norm.toggledCount === 1 ? "" : "s"}`,
      );
      console.log(`[manual/deep-discover] ${this.gameSlug}: ✅ PHASE Ante Normalize COMPLETE — initial=${norm.initialState} toggled=${norm.toggledCount} tier=${norm.detectionTier}`);
    } else {
      this.endPhase("ante-normalize", "skip", "no anteButton in registry (game has no ante feature)");
      console.log(`[manual/deep-discover] ${this.gameSlug}: ⊘ PHASE Ante Normalize SKIPPED — no anteButton in registry (game has no ante feature)`);
    }

    console.log(`[manual/deep-discover] ${this.gameSlug}: starting recursive UI graph exploration (depth<=${opts.maxDepth ?? 3}, aiCalls<=${opts.maxAiCalls ?? 25}, states<=${opts.maxStates ?? 15}, clickable=${safetyReport.clickable.join(",")})…`);
    // Per-trigger hints to pin AI labels to real values where the popup
    // contents are predictable. For bet selector (opened via betPlus or
    // betMinus), inject the exact gameSpec.betLadder so each bet cell is
    // labeled with a value that actually exists in the ladder — otherwise
    // the AI interpolates plausible-looking values like "bet-87.50" that
    // don't exist, and downstream agent-verify rejects every such probe.
    const triggerHints: Record<string, string> = {};
    if (this.gameSpec?.betLadder?.length) {
      const ladder = this.gameSpec.betLadder
        .map((v) => v.toFixed(2))
        .join(", ");
      const betHint =
        `This popup is the BET SELECTOR. Emit ONE element per VISIBLE bet ` +
        `button. The button shows a numeric bet value (often prefixed with $). ` +
        `READ the value rendered on each button and use key format "bet-<value>" ` +
        `where <value> is the number you READ (e.g. a button showing "$0.20" → ` +
        `key "bet-0.20"; "$100" → "bet-100.00"; format with 2 decimal places). ` +
        `For reference the game's full bet ladder is [${ladder}]. If a value ` +
        `you read is close to one of those, use the ladder value verbatim. ` +
        `Do NOT generate keys for values not visibly rendered on a button. ` +
        `Also emit "closeButton" for the X / dismiss control if visible.`;
      triggerHints["betPlus"] = betHint;
      triggerHints["betMinus"] = betHint;
    }
    // Inject per-trigger discoverHints from sub-state-hints (autoplay slider
    // anchors, paytable nextButton, menu historyButton, etc.). Without this
    // the explorer's AI runs unguided through autoButton → inconsistently
    // labels the slider track ends → slider-stop synthesis below silently
    // skips and autoCountSlide-N chips never register. Existing hints (bet
    // selector) take priority. See sub-state-hints.ts for the full list.
    const subHints = await resolveSubStateHints(this.gameSlug);
    for (const [triggerKey, hint] of Object.entries(subHints)) {
      if (!hint.discoverHint) continue;
      if (triggerHints[triggerKey]) continue;
      triggerHints[triggerKey] = hint.discoverHint;
    }
    const result = await exploreUiGraph(
      this.session.page,
      this.gameSlug,
      this.registry,
      { ...opts, triggerHints: { ...(opts.triggerHints ?? {}), ...triggerHints } },
    );

    // Migrate stale state-id-namespaced keys to trigger-namespaced. The explorer
    // now namespaces sub-state elements by the TRIGGER KEY (matching
    // discoverSubState's convention). Older runs used the AI-assigned state
    // label as namespace (e.g. autoplay_settings_popup__*). Re-running picks up
    // the same physical popup but creates new keys under the trigger → the
    // dashboard would show TWO duplicate groups. Rename the stale ones so the
    // tree groups everything under the trigger (autoButton__*).
    let migrated = 0;
    for (const fromStateId of Object.keys(result.graph.states ?? {})) {
      const fromState = result.graph.states[fromStateId];
      if (!fromState) continue;
      for (const [trigger, targetStateId] of Object.entries(fromState.transitions ?? {})) {
        if (!trigger || !targetStateId || trigger === targetStateId) continue;
        const stalePrefix = `${targetStateId}__`;
        const newPrefix = `${trigger}__`;
        if (stalePrefix === newPrefix) continue;
        for (const k of Object.keys(this.registry)) {
          if (!k.startsWith(stalePrefix)) continue;
          const tail = k.slice(stalePrefix.length);
          const newKey = newPrefix + tail;
          if (this.registry[newKey]) {
            // Conflict — fresh trigger-namespaced entry already exists from
            // this same explore. Stale loses; delete it.
            delete this.registry[k];
            delete this.verifyState[k];
          } else {
            this.registry[newKey] = this.registry[k];
            this.verifyState[newKey] = this.verifyState[k] ?? "pending";
            delete this.registry[k];
            delete this.verifyState[k];
          }
          migrated++;
        }
      }
    }
    if (migrated > 0) console.log(`[manual/deep-discover] migrated ${migrated} stale stateId-namespaced keys to trigger-namespaced`);

    // Merge new elements as pending. Explorer returns a mergedRegistry that
    // includes initial + all discovered; pick out the genuinely-new keys.
    const now = new Date().toISOString();
    const addedKeys: string[] = [];
    for (const [key, el] of Object.entries(result.registry)) {
      if (!el) continue;
      if (before.has(key)) continue;
      this.registry[key] = {
        ...el,
        status: el.status ?? "pending",
        detectedAt: el.detectedAt ?? now,
      };
      this.verifyState[key] = "pending";
      addedKeys.push(key);
    }
    await uiRegistry.save(this.gameSlug, this.registry);
    console.log(`[manual/deep-discover] explored ${result.graph.exploration.statesDiscovered} states, ${result.graph.exploration.transitionsRecorded} transitions, ${result.graph.exploration.aiCallsUsed} AI calls, +${addedKeys.length} new elements`);

    // Slider-stop synthesis: per-row Discover already does this in
    // discoverSubState; mirror here so Deep Discover (which goes through the
    // explorer, not discoverSubState) also synthesizes the discrete chips
    // (e.g. autoButton's autoCountSlide-{10,20,30,50,70,100,500,1000}).
    const synthWarnings = await this.synthesizeSliderStopsForAllHints();
    if (synthWarnings.length > 0) {
      (result.warnings ?? (result.warnings = [])).push(...synthWarnings);
    }

    // Post-explore ante drift check. anteButton is already in the
    // production safe-click blacklist, so the explorer shouldn't have
    // toggled it. But: AGGRESSIVE mode ignores blacklist, AND coord
    // errors near ante can still hit it. If we drifted, surface a loud
    // warning + try a single recovery click — but DON'T overwrite
    // already-discovered sub-state captures (too late, damage is done).
    // QA sees the warning and decides whether to re-run Discover.
    if (this.registry["anteButton"] && this.registry["anteButton"]!.offBaseline) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: ▶ PHASE — Post-Explore Ante Drift Check`);
      const drift = await verifyAnteOff(this.session.page, this.gameSlug, this.registry);
      if (!drift.isOff && drift.baselineFound) {
        const warn = `ante DRIFTED during exploration (ratio=${drift.ratio?.toFixed(3) ?? "?"}) — popups captured AFTER the drift event may have ante-inflated values. Recommend: clear unverified entries and re-run Discover.`;
        console.warn(`[manual/deep-discover] ${this.gameSlug}: ⚠ ${warn}`);
        (result.warnings ?? (result.warnings = [])).push(warn);
        // Best-effort recovery so subsequent operations (probe, etc) run
        // with ante OFF again.
        await ensureAnteOff(this.session.page, this.gameSlug, this.registry).catch(() => undefined);
      } else {
        console.log(`[manual/deep-discover] ${this.gameSlug}: ✅ ante still OFF after exploration (ratio=${drift.ratio?.toFixed(3) ?? "?"})`);
      }
    }

    // Auto-probe all pending probeable elements (P1 chain). With the new
    // re-detect policy (clear unverified at start), even keys that EXISTED
    // before but were re-seeded as pending should be re-probed — calling with
    // no `onlyKeys` filter scans the full registry and skips verified ones.
    const probe = await this.probePendingElements({});
    return {
      ok: true,
      addedKeys,
      statesDiscovered: result.graph.exploration.statesDiscovered,
      transitionsRecorded: result.graph.exploration.transitionsRecorded,
      aiCallsUsed: result.graph.exploration.aiCallsUsed,
      elapsedMs: result.graph.exploration.elapsedMs,
      warnings: result.warnings,
      safetyReport,
      probe,
    };
  }

  /**
   * P3 of AI auto-discover — one-click onboarding. Runs the full chain:
   *   1. deepDiscover (P2) — recursive UI graph exploration + element probe.
   *   2. calibratePayoutModel — multi-bet spins + payout-model derivation.
   * Returns combined summary. Skips PayoutModel calibration silently for
   * non-PP games (calibratePayoutModel will return ok=false with a reason).
   *
   * Note: paytable extraction is NOT part of auto-onboard in v1 — it's
   * performed during cold-start (`qa:cold`) and persisted to paytable.json.
   * If the game's paytable.json is stale/missing, payout calibration will
   * complete but with `paytableAgreement=false` → model untrusted (a safe,
   * informative outcome). Re-running cold-start is the path to refresh it.
   */

  /** Request a cooperative pause of the running Auto-Onboard. Returns 200
   *  immediately; the actual pause happens after the current phase
   *  finishes (granularity limit — phases like deep-discover are blackbox
   *  ~5-15min). State is persisted via the normal endPhase write so resume
   *  works identically to crash-recovery. */
  pauseAutoOnboard(): { ok: boolean; reason?: string } {
    if (!this.autoOnboardInProgress) {
      return { ok: false, reason: "no Auto-Onboard is currently running" };
    }
    if (this.autoOnboardPauseRequested) {
      return { ok: true, reason: "pause already requested — waiting for current phase to finish" };
    }
    this.autoOnboardPauseRequested = true;
    console.log(`[manual/auto-onboard] ${this.gameSlug}: PAUSE REQUESTED — will exit after current phase`);
    return { ok: true };
  }

  private skippedMainKeysFilePath(slug: string): string {
    return path.join(dirForGame(slug), "qa-main-skip.json");
  }

  private async loadSkippedMainKeys(slug: string): Promise<Set<string>> {
    try {
      const raw = await readFile(this.skippedMainKeysFilePath(slug), "utf8");
      const parsed = JSON.parse(raw) as { keys?: string[] };
      const keys = Array.isArray(parsed?.keys) ? parsed.keys.filter((k) => typeof k === "string" && k.length > 0) : [];
      return new Set(keys);
    } catch {
      return new Set<string>();
    }
  }

  private async saveSkippedMainKeys(slug: string): Promise<void> {
    try {
      await writeFile(
        this.skippedMainKeysFilePath(slug),
        JSON.stringify({ keys: Array.from(this.skippedMainKeys), updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch (err) {
      console.warn(`[manual/skip-main] persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Path to the on-disk Auto-Onboard state file. Returns null when no
   *  active session (slug needed for path resolution). */
  private onboardStateFilePath(): string | null {
    if (!this.gameSlug) return null;
    return path.join(dirForGame(this.gameSlug), "_onboard-state.json");
  }

  /** Persist current phase progress so a server crash mid-onboard can
   *  resume via loadOnboardState() on next click. Called after every
   *  startPhase/endPhase + when autoOnboard finishes. `completedAt` is
   *  null while the run is mid-flight; set when finally{} hits. */
  private async saveOnboardState(): Promise<void> {
    const file = this.onboardStateFilePath();
    if (!file || !this.gameSlug) return;
    const state = {
      schemaVersion: 1 as const,
      gameSlug: this.gameSlug,
      startedAt: this.autoOnboardStartedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: this.autoOnboardInProgress ? null : new Date().toISOString(),
      currentPhase: this.autoOnboardCurrentPhase,
      phases: this.autoOnboardPhases,
    };
    try {
      await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch (err) {
      console.warn(`[auto-onboard/state] persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read prior Auto-Onboard state from disk (if exists). Returns null when
   *  no state file, file unreadable, or run completed (completedAt set). */
  private async loadOnboardState(): Promise<{
    phases: typeof this.autoOnboardPhases;
    startedAt: string;
    currentPhase: string | null;
  } | null> {
    const file = this.onboardStateFilePath();
    if (!file) return null;
    try {
      const raw = await readFile(file, "utf8");
      const state = JSON.parse(raw) as {
        schemaVersion: number; phases: typeof this.autoOnboardPhases;
        startedAt: string; completedAt: string | null;
        currentPhase: string | null;
      };
      // Only resume from INTERRUPTED runs. Completed (success) runs leave
      // their state on disk but autoOnboard ignores them — re-clicking
      // starts fresh by design (catalog/translate auto-skip via their own
      // idempotency, no need for phase-level skip).
      if (state.completedAt != null) return null;
      // Validate phase shape minimally — if schema drifted, bail.
      if (!Array.isArray(state.phases) || state.phases.length === 0) return null;
      return {
        phases: state.phases,
        startedAt: state.startedAt,
        currentPhase: state.currentPhase,
      };
    } catch {
      return null;
    }
  }

  /** Reset phase tracker at the start of an Auto-Onboard run. All known
   *  phases declared pending so the dashboard can render the full checklist
   *  before any phase actually runs. Phase NAMES here must match the labels
   *  passed to `startPhase()` exactly. */
  private initAutoOnboardPhases(): void {
    const names = [
      // Auto-onboard no longer deep-discovers the UI graph — QA discovers all
      // levels manually. This phase only behaviorally VERIFIES the pending
      // elements (probePendingElements, walks each trigger chain to probe deep
      // elements too) — NO new discovery. Use the standalone "Deep Discover
      // (AI)" button for exploration.
      "verify-pending",
      // Ante normalize tracked separately so QA sees it in the progress panel.
      // Runs right before verify-pending (bet assertions + calibration need
      // ante OFF). Note field shows tier + toggle count.
      "ante-normalize",
      "verify-registry",
      "ocr-auto-detect",
      "deep-extract",
      "calibrate-payout",
      "generate-catalog",
      "translate-cases",
      "run-cases",
    ];
    this.autoOnboardPhases = names.map((name) => ({ name, status: "pending" as const }));
    this.autoOnboardCurrentPhase = null;
  }

  /** Mark a phase as running. Captures startedAt for duration tracking.
   *  Sets currentPhase so the dashboard's progress banner can show "Phase X
   *  of N: <name>" without inspecting the array. */
  private startPhase(name: string): void {
    const p = this.autoOnboardPhases.find((x) => x.name === name);
    if (!p) {
      console.warn(`[phase-tracker] unknown phase "${name}" — not declared in initAutoOnboardPhases`);
      return;
    }
    p.status = "running";
    p.startedAt = new Date().toISOString();
    this.autoOnboardCurrentPhase = name;
    // Persist async — don't block phase execution. Failure logged but
    // doesn't break Auto-Onboard flow.
    this.saveOnboardState().catch(() => undefined);
  }

  /** Mark a phase finished. `status` ∈ {ok, fail, skip}. Optional `note`
   *  shows in dashboard tooltip (e.g. "30 elements added", "ffmpeg missing"). */
  private endPhase(name: string, status: "ok" | "fail" | "skip", note?: string): void {
    const p = this.autoOnboardPhases.find((x) => x.name === name);
    if (!p) return;
    p.status = status;
    p.completedAt = new Date().toISOString();
    if (p.startedAt) p.durationMs = Date.parse(p.completedAt) - Date.parse(p.startedAt);
    if (note) p.note = note;
    if (this.autoOnboardCurrentPhase === name) this.autoOnboardCurrentPhase = null;
    this.saveOnboardState().catch(() => undefined);
  }

  /**
   * Force the ante bet OFF and capture its OFF baseline (the "ante-normalize"
   * phase). Extracted so auto-onboard can run it standalone — auto-onboard no
   * longer deep-discovers, but bet assertions + payout calibration still need
   * ante OFF before they run. No-op (skip) when the game has no anteButton.
   * Returns { ok:false, reason } so the caller can abort if normalization fails
   * (an ante-ON registry would bake inflated bet values).
   */
  private async normalizeAntePhase(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) {
      return { ok: false, reason: "no active session" };
    }
    if (!this.registry["anteButton"]) {
      this.endPhase("ante-normalize", "skip", "no anteButton in registry (game has no ante feature)");
      return { ok: true };
    }
    // Reach main first — a leftover popup would block the anteButton click.
    await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
    this.startPhase("ante-normalize");
    const norm = await normalizeAnteOff(this.session.page, this.gameSlug, this.registry);
    if (!norm.ok) {
      console.warn(`[manual/auto-onboard] ${this.gameSlug}: deterministic ante normalize failed (tier=${norm.detectionTier}: ${norm.reason ?? "unknown"}) — trying ensureAnteOff AI fallback`);
      const ai = await ensureAnteOff(this.session.page, this.gameSlug, this.registry);
      if (!ai.ok) {
        this.endPhase("ante-normalize", "fail", norm.reason?.slice(0, 80));
        return { ok: false, reason: `ante normalize failed (tier=${norm.detectionTier}): ${norm.reason ?? "unknown"}; AI fallback failed: ${ai.reason ?? "unknown"}` };
      }
      this.endPhase("ante-normalize", "ok", `AI fallback forced OFF after deterministic tier=${norm.detectionTier}`);
      return { ok: true };
    }
    if (norm.baselinePath && this.registry["anteButton"]) {
      this.registry["anteButton"]!.offBaseline = path.relative(dirForGame(this.gameSlug), norm.baselinePath);
      await uiRegistry.save(this.gameSlug, this.registry);
    }
    this.endPhase(
      "ante-normalize",
      "ok",
      `${norm.initialState === "off" ? "already OFF" : `flipped ${norm.initialState}→off`} · tier=${norm.detectionTier} · ${norm.toggledCount} toggle${norm.toggledCount === 1 ? "" : "s"}`,
    );
    return { ok: true };
  }

  async autoOnboard(
    opts: {
      deepDiscover?: { maxDepth?: number; maxAiCalls?: number; maxStates?: number };
      calibrationSpinsPerLevel?: number;
      /** When true, attempt to resume from `_onboard-state.json` left by a
       *  prior interrupted run — skip phases already marked ok/skip, run
       *  the rest. Default true (auto-detect resume opportunity). Pass
       *  false to FORCE fresh onboard ignoring any prior state. */
      resume?: boolean;
    } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    discover?: Awaited<ReturnType<typeof this.deepDiscover>>;
    verify?: Awaited<ReturnType<typeof this.verifyRegistry>>;
    ocr?: Awaited<ReturnType<typeof this.autoDetectOcrRegions>> | { ok: false; reason: string; saved: never[]; proposed: never[]; skipped: never[] };
    payout?: Awaited<ReturnType<typeof this.calibratePayoutModel>>;
    testRun?: Awaited<ReturnType<typeof this.runAllTestcases>>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session" };
    }
    // Hard precondition: refuse to onboard when the platform loaded a DIFFERENT
    // game than this session's slug (detected from the asset URL game-code) —
    // otherwise we write the wrong game's UI/paytable/cases under this label and
    // silently corrupt its registry.
    if (this.gameError?.site === "game-mismatch") {
      console.warn(`[manual/auto-onboard] ${this.gameSlug}: ABORT — ${this.gameError.detectedText}`);
      return { ok: false, reason: this.gameError.detectedText };
    }
    // Hard precondition: Auto-Onboard depends on reliable OCR evidence for
    // bet/balance; require QA to define these regions before any run.
    const ocrState = await this.loadOcrRegions();
    if (!ocrState.ok) {
      return { ok: false, reason: ocrState.reason ?? "failed to load OCR regions" };
    }
    const requiredKeys = ["balanceArea", "betArea"] as const;
    // Auto-Onboard OCR policy: only balance/bet are required and auto-managed.
    // win/freeSpinCounter are intentionally excluded from this phase.
    const autoDetectKeys = requiredKeys;
    const isValidOcrRegion = (region: { x: number; y: number; width: number; height: number } | undefined): boolean => {
      if (!region) return false;
      return Number.isFinite(region.x)
        && Number.isFinite(region.y)
        && Number.isFinite(region.width)
        && Number.isFinite(region.height)
        && region.width > 0
        && region.height > 0;
    };
    const missingRequired = requiredKeys.filter((key) => {
      const region = ocrState.regions?.[key];
      return !isValidOcrRegion(region);
    });
    if (missingRequired.length > 0) {
      return {
        ok: false,
        reason: `missing required OCR regions for Auto-Onboard: ${missingRequired.join(", ")}. Draw Balance widget + Bet widget in OCR Regions first.`,
      };
    }
    const missingOrInvalidOcr = autoDetectKeys.filter((key) => !isValidOcrRegion(ocrState.regions?.[key]));
    const expectedTopLevel = this.expectedElementKeys.filter((k) => typeof k === "string" && k.length > 0 && !k.includes("__"));
    const requiredMainKeys = Array.from(new Set<string>([...LEVEL1_EXPECTED_KEYS, ...expectedTopLevel]));
    const missingLevel1Qa = requiredMainKeys.filter((key) => {
      if (this.skippedMainKeys.has(key)) return false;
      const el = this.registry?.[key];
      if (!el) return true;
      return el.verifiedBy !== "QA" && !hasUsableRegistryCoord(el);
    });
    if (missingLevel1Qa.length > 0) {
      return {
        ok: false,
        reason: `missing QA-verified level-1 elements: ${missingLevel1Qa.join(", ")}. Use Start-session level-1 picker popup to pick or skip each key first.`,
      };
    }
    // Mutex: reject if another autoOnboard is already running on this
    // session (handles queued duplicate HTTP requests that survived a
    // client-side TaskStop — server keeps processing them otherwise).
    if (this.autoOnboardInProgress) {
      console.warn(`[manual/auto-onboard] ${this.gameSlug}: REJECTED — another autoOnboard is already in progress (duplicate request likely queued)`);
      return { ok: false, reason: "another autoOnboard is already in progress for this session" };
    }
    this.autoOnboardInProgress = true;
    // Resume from prior interrupted run if state file present and not
    // explicitly disabled. Skipped phases preserve their `ok`/`skip`
    // status and notes; only `pending`/`running`/`fail` get re-attempted
    // by the per-phase guards below. Default behavior: opt-in resume.
    let resumed = false;
    if (opts.resume !== false) {
      const prior = await this.loadOnboardState();
      if (prior) {
        this.autoOnboardPhases = prior.phases;
        this.autoOnboardStartedAt = prior.startedAt;
        this.autoOnboardCurrentPhase = prior.currentPhase;
        // Reset any phase stuck in "running" — it was interrupted, treat
        // as pending so it re-runs cleanly.
        for (const p of this.autoOnboardPhases) {
          if (p.status === "running") {
            p.status = "pending";
            delete p.startedAt;
          }
        }
        const okCount = this.autoOnboardPhases.filter((p) => p.status === "ok" || p.status === "skip").length;
        console.log(`[manual/auto-onboard] ${this.gameSlug}: RESUMING — ${okCount}/${this.autoOnboardPhases.length} phases already done`);
        resumed = true;
      }
    }
    if (!resumed) {
      this.initAutoOnboardPhases();
      this.autoOnboardStartedAt = new Date().toISOString();
    }
    this.autoOnboardResumeAvailable = false; // clear — we're running now
    this.autoOnboardPauseRequested = false; // reset from any prior pause
    // Helper: returns true if phase should be skipped (already ok/skip in
    // resumed state). Per-phase wrapping inline below to preserve original
    // type narrowing of phase-specific result variables.
    const isPhaseDone = (name: string): boolean => {
      const p = this.autoOnboardPhases.find((x) => x.name === name);
      return !!p && (p.status === "ok" || p.status === "skip");
    };
    // Helper: throws a sentinel error caught below to exit autoOnboard
    // when QA clicked Pause. Called before each phase's start guard so
    // the loop bails BETWEEN phases (mid-phase pause unsupported — each
    // phase is an opaque async call). State persistence is unchanged —
    // already-finished phases keep their ok/skip status in the on-disk
    // state file → resume picks up where we left off.
    const PAUSE_SENTINEL = Symbol("autoOnboardPaused");
    const checkPause = (): void => {
      if (this.autoOnboardPauseRequested) {
        throw PAUSE_SENTINEL;
      }
    };
    // Clear any stale game error from a prior run — caller knows we're
    // starting fresh + the dashboard banner shouldn't persist.
    this.clearGameError();
    try {
      console.log(`[manual/auto-onboard] ${this.gameSlug}: starting — verify-pending (no deep-discover) → verify-registry → extract → calibrate → catalog`);

      // PARALLEL: kick off OCR-region auto-detection now using a baseline
      // screenshot of the (currently-main) game canvas. The detection chain
      // makes ~5 Claude vision calls + in-memory crops — completes in ~40s,
      // overlaps with deepDiscover's ~5-15 min runtime. No live screenshots
      // taken inside the chain, so deepDiscover's popup navigation can't
      // race against it. Failures here are non-fatal (returned in `ocr`).
      let ocrPromise: Promise<Awaited<ReturnType<typeof this.autoDetectOcrRegions>> | { ok: false; reason: string; saved: never[]; proposed: never[]; skipped: never[] }> = Promise.resolve(
        { ok: false, reason: "no baseline captured", saved: [], proposed: [], skipped: [] },
      );
      checkPause();
      let ocrSkipped = isPhaseDone("ocr-auto-detect");
      if (!ocrSkipped && missingOrInvalidOcr.length === 0) {
        // All OCR regions already exist and are valid from prior QA/manual work.
        // Skip expensive re-detect loop unless resume state explicitly requires it.
        this.endPhase("ocr-auto-detect", "skip", "all OCR regions already valid");
        ocrSkipped = true;
        console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-auto-detect SKIPPED (all regions already valid)`);
      }
      if (this.session && !ocrSkipped) {
        this.startPhase("ocr-auto-detect");
        try {
          const baseline = await this.session.page.screenshot({ type: "png" });
          ocrPromise = this.autoDetectOcrRegions({
            baselineScreenshot: baseline,
            regions: missingOrInvalidOcr,
          }).catch((err) => ({
            ok: false as const,
            reason: err instanceof Error ? err.message : String(err),
            saved: [] as never[], proposed: [] as never[], skipped: [] as never[],
          }));
          console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-region detection running in parallel (targets=${missingOrInvalidOcr.join(",") || "none"})`);
        } catch (err) {
          console.warn(`[manual/auto-onboard] ${this.gameSlug}: baseline screenshot for OCR detection threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (ocrSkipped) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-auto-detect SKIPPED (resumed — already done)`);
      }

      // VERIFY-PENDING phase (2026-06 workflow change). Auto-onboard no longer
      // deep-discovers the UI graph — QA discovers all levels manually. Here we
      // only force ante OFF, then behaviorally probe the PENDING elements
      // (probePendingElements walks each trigger chain so deep/sub-state
      // elements are verified too) — NO new discovery, no deeper-level
      // exploration. For exploration use the standalone "Deep Discover (AI)"
      // button. `discover` kept as an empty stub for the return shape.
      const discover: Awaited<ReturnType<typeof this.deepDiscover>> = { ok: true, addedKeys: [] };
      if (isPhaseDone("verify-pending")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: verify-pending SKIPPED (resumed — already done)`);
      } else {
        // Ante OFF first — bet assertions + payout calibration assume base wager.
        const ante = await this.normalizeAntePhase();
        if (!ante.ok) {
          const ocr = await ocrPromise;
          if (!ocrSkipped) this.endPhase("ocr-auto-detect", ocr.ok ? "ok" : "fail", ocr.ok ? `saved=${ocr.saved.length}` : (ocr.reason ?? "failed"));
          return { ok: false, reason: `ante normalize failed: ${ante.reason ?? "unknown"}`, discover, ocr };
        }
        this.startPhase("verify-pending");
        const vp = await this.probePendingElements({});
        this.endPhase(
          "verify-pending",
          vp.ok ? "ok" : "fail",
          `verified=${vp.verified}/${vp.probed} failed=${vp.failed} skipped=${vp.skipped}${vp.reason ? ` · ${vp.reason}` : ""}`,
        );
        console.log(`[manual/auto-onboard] ${this.gameSlug}: verify-pending — probed=${vp.probed} verified=${vp.verified} failed=${vp.failed} skipped=${vp.skipped}`);
      }
      const ocr = await ocrPromise;
      if (!ocrSkipped) {
        this.endPhase(
          "ocr-auto-detect",
          ocr.ok ? "ok" : "fail",
          ocr.ok ? `saved=${ocr.saved.length} proposed=${ocr.proposed.length}` : (ocr.reason ?? "failed"),
        );
      }
      console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-region detection done — saved=${ocr.saved.length} proposed=${ocr.proposed.length} skipped=${ocr.skipped.length}`);

      // Registry-verify phase (2026-06-02). After deep-discover, audit the
      // registry against the per-parent EXPECTED_CHILDREN rules: prune legacy
      // namespace dups, re-discover missing required/dynamic children via
      // discoverVia(), then bidirectionally mirror verified entries across
      // partner pairs (betPlus ↔ betMinus popup is identical). Bounded — one
      // discoverVia call per missing trigger, no infinite re-audit loops.
      checkPause();
      let verify: Awaited<ReturnType<typeof this.verifyRegistry>>;
      if (isPhaseDone("verify-registry")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: verify-registry SKIPPED (resumed — already done)`);
        verify = { ok: true, pruned: [], reDiscoveredTriggers: [], mirrored: [] };
      } else {
        this.startPhase("verify-registry");
        // reDiscover:false — QA discovers all levels manually; here we only
        // prune legacy dups + mirror verified partner pairs, NOT re-discover
        // missing expected-children.
        verify = await this.verifyRegistry({ reDiscover: false });
        this.endPhase("verify-registry", "ok", `pruned=${verify.pruned.length} mirrored=${verify.mirrored.length}`);
        console.log(
          `[manual/auto-onboard] ${this.gameSlug}: verify — pruned=${verify.pruned.length} ` +
          `re-discovered=${verify.reDiscoveredTriggers.length} ` +
          `mirrored=${verify.mirrored.length}`,
        );
      }

      // Deep-extract: vision-driven capture of paytable / rules / buy-options
      // / special-bets from in-game popups. Auto-Onboard previously skipped
      // this (cold-start only) → catalog regen had `auxiliary sources:
      // synthesized-from-registry` and AI guessed rules. Run BEFORE calibrate
      // so payout-model has paytable data when it derives symbol values.
      checkPause();
      if (isPhaseDone("deep-extract")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: deep-extract SKIPPED (resumed — already done)`);
      } else {
        this.startPhase("deep-extract");
        const { phaseDeepExtract } = await import("../phases/phase-deep-extract.js");
        const deepExtract = await phaseDeepExtract({
          page: this.session.page,
          gameSlug: this.gameSlug,
          uiMap: this.registry,
        });
        this.endPhase(
          "deep-extract",
          deepExtract.ok ? "ok" : "fail",
          deepExtract.extract
            ? `paytable=${!!deepExtract.extract.paytableMd} rules=${!!deepExtract.extract.infoMd}`
            : deepExtract.reason,
        );
        console.log(
          `[manual/auto-onboard] ${this.gameSlug}: deep-extract `
          + (deepExtract.ok ? `done in ${deepExtract.durationMs}ms` : `failed: ${deepExtract.reason}`),
        );
      }

      // Calibrate payout + persist network rounds to canonical
      // network/network.jsonl (so subsequent catalog regen has spin samples
      // without needing case-evidence aggregation).
      checkPause();
      let payout: Awaited<ReturnType<typeof this.calibratePayoutModel>>;
      if (isPhaseDone("calibrate-payout")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: calibrate-payout SKIPPED (resumed — already done)`);
        payout = { ok: true };
      } else {
        this.startPhase("calibrate-payout");
        const { withNetworkPersist } = await import("../phases/phase-persist-network.js");
        let persistNet: Awaited<ReturnType<typeof withNetworkPersist>>["persist"] | null = null;
        try {
          const wrapped = await withNetworkPersist(
            { page: this.session.page, gameSlug: this.gameSlug },
            () => this.calibratePayoutModel({ spinsPerLevel: opts.calibrationSpinsPerLevel }),
          );
          payout = wrapped.workResult;
          persistNet = wrapped.persist;
          console.log(`[manual/auto-onboard] ${this.gameSlug}: persisted ${persistNet.roundsAppended ?? 0} network rounds → network.jsonl (total ${persistNet.totalRoundsOnDisk ?? "?"})`);
        } catch (err) {
          payout = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        this.endPhase(
          "calibrate-payout",
          payout.ok ? "ok" : "fail",
          payout.ok ? `trusted=${payout.trusted ?? false} combos=${payout.combosMatched ?? 0}/${payout.combosTotal ?? 0}` : payout.reason,
        );
      }

      // Generate AI catalog now that all inputs (registry, network rounds,
      // aux sources, parser.json from calibrate's createParserForGame call)
      // are on disk. This was previously a separate "Generate Cases" button
      // click; folding it into Auto-Onboard means a single click = game
      // ready to run cases. Skip when already exists (idempotent — don't
      // burn AI cost on every Auto-Onboard re-run; QA uses the dedicated
      // "Generate Cases" button to force regen).
      checkPause();
      const existingCatalog = await loadAiCatalog(this.gameSlug).catch(() => null);
      let catalog: Awaited<ReturnType<typeof import("../phases/phase-generate-catalog.js").phaseGenerateCatalog>> | null = null;
      if (isPhaseDone("generate-catalog")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: generate-catalog SKIPPED (resumed — already done)`);
      } else {
        this.startPhase("generate-catalog");
        const { phaseGenerateCatalog } = await import("../phases/phase-generate-catalog.js");
        if (existingCatalog && existingCatalog.cases.length > 0) {
          this.endPhase("generate-catalog", "skip", `existing ${existingCatalog.cases.length} cases reused`);
          console.log(`[manual/auto-onboard] ${this.gameSlug}: catalog already exists (${existingCatalog.cases.length} cases) — skipping generation. Use "Generate Cases" to regenerate.`);
        } else {
          catalog = await phaseGenerateCatalog({ gameSlug: this.gameSlug });
          this.endPhase(
            "generate-catalog",
            catalog.ok ? "ok" : "fail",
            catalog.ok ? `${catalog.totalCases} cases · rounds=${catalog.roundsLoaded} aux=${catalog.hadAuxSources}` : catalog.reason,
          );
          console.log(
            `[manual/auto-onboard] ${this.gameSlug}: catalog `
            + (catalog.ok
              ? `generated ${catalog.totalCases} cases (rounds=${catalog.roundsLoaded} aux=${catalog.hadAuxSources}, ${catalog.durationMs}ms)`
              : `failed: ${catalog.reason}`),
          );
        }
      }

      // Translate cases so each case has a ready-to-run actions array.
      // Cheap (~$0.02-0.10 per case, parallel-able) and means subsequent
      // "Run" doesn't pay the per-case translation AI cost on demand.
      checkPause();
      let translate: Awaited<ReturnType<typeof import("../phases/phase-translate-cases.js").phaseTranslateCases>> | null = null;
      if (isPhaseDone("translate-cases")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: translate-cases SKIPPED (resumed — already done)`);
      } else {
        this.startPhase("translate-cases");
        const { phaseTranslateCases } = await import("../phases/phase-translate-cases.js");
        translate = (catalog?.ok || existingCatalog)
          ? await phaseTranslateCases({ gameSlug: this.gameSlug })
          : null;
        if (translate) {
          this.endPhase(
            "translate-cases",
            translate.ok ? "ok" : "fail",
            translate.ok ? `${translate.totalCases} total` : translate.reason,
          );
          console.log(
            `[manual/auto-onboard] ${this.gameSlug}: translate `
            + (translate.ok ? `done (${translate.totalCases} total, +${translate.newCount} new, ${translate.durationMs}ms)` : `failed: ${translate.reason}`),
          );
        } else {
          this.endPhase("translate-cases", "skip", "no catalog to translate");
        }
      }

      // Run cases — the catalog is now guaranteed to exist (either pre-
      // existing or just generated). Skips gracefully if generation failed.
      checkPause();
      let testRun: Awaited<ReturnType<typeof this.runAllTestcases>>;
      if (isPhaseDone("run-cases")) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: run-cases SKIPPED (resumed — already done)`);
        testRun = { ok: true, results: [], passed: 0, failed: 0, skipped: 0 };
      } else {
        this.startPhase("run-cases");
        testRun = await this.runAllTestcases({ continueOnFail: true });
        this.endPhase(
          "run-cases",
          testRun.ok ? "ok" : "skip",
          testRun.ok ? `${testRun.passed}/${testRun.results.length} pass` : testRun.reason,
        );
      }
      console.log(
        `[manual/auto-onboard] ${this.gameSlug}: test-run ${testRun.ok ? "complete" : "skipped"}` +
        (testRun.ok ? ` — ${testRun.results.length} cases, ${testRun.passed} pass, ${testRun.failed} fail, ${testRun.skipped} skip` : ` — ${testRun.reason}`),
      );

      const deepExtractStatus = this.autoOnboardPhases.find((p) => p.name === "deep-extract")?.status ?? "unknown";
      console.log(`[manual/auto-onboard] ${this.gameSlug}: done — discover.added=${discover.addedKeys?.length ?? 0} verify.mirrored=${verify.mirrored.length} ocr.saved=${ocr.saved.length} deep-extract=${deepExtractStatus} payout.trusted=${payout.trusted ?? false} catalog=${catalog?.ok ?? (existingCatalog ? "existing" : "skip")} test=${testRun.ok ? `${testRun.passed}/${testRun.results.length}p` : "skip"}`);
      return { ok: true, discover, verify, ocr, payout, testRun };
    } catch (err) {
      // Pause sentinel → exit cleanly with paused=true so the on-disk state
      // file (written via the normal endPhase calls) marks the run as
      // resumable. completedAt stays null so loadOnboardState will return
      // it on next click. autoOnboardResumeAvailable gets set in the
      // finally block so the dashboard's Resume button appears.
      if (err === PAUSE_SENTINEL) {
        console.log(`[manual/auto-onboard] ${this.gameSlug}: PAUSED — state persisted, resume via dashboard button`);
        this.autoOnboardResumeAvailable = true;
        return { ok: true, reason: "paused by request" };
      }
      // GameErrorDetectedError → halt with a clear message so the route
      // handler can surface "game error — reload URL and resume" to QA.
      // The detection site already recorded this.gameError, so the
      // dashboard banner will show the popup text. Mark resume available
      // so QA can pick up where they left off after reloading.
      const { GameErrorDetectedError } = await import("../utils/game-error-detect.js");
      if (err instanceof GameErrorDetectedError) {
        console.error(`[manual/auto-onboard] ${this.gameSlug}: HALTED by game error — ${err.message}`);
        this.autoOnboardResumeAvailable = true;
        return { ok: false, reason: `Game error detected: ${err.matchedKeywords.join(", ")}. Reload the game URL in the browser, then click Resume Auto-Onboard.` };
      }
      throw err;
    } finally {
      this.autoOnboardInProgress = false;
      this.autoOnboardPauseRequested = false;
      // Persist final state. If we paused via PAUSE_SENTINEL, the early
      // return above didn't reach the "no-pause" path; saveOnboardState
      // here writes the on-disk file with completedAt depending on whether
      // we're paused (autoOnboardResumeAvailable=true) or actually done.
      // The saveOnboardState helper uses autoOnboardInProgress (just set
      // to false) to determine completedAt — so paused runs ALSO get
      // completedAt set on disk, which would defeat resume. Override by
      // writing the file manually with completedAt=null when paused.
      if (this.autoOnboardResumeAvailable && this.gameSlug) {
        const file = this.onboardStateFilePath();
        if (file) {
          try {
            await writeFile(file, JSON.stringify({
              schemaVersion: 1,
              gameSlug: this.gameSlug,
              startedAt: this.autoOnboardStartedAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null, // paused — resumable
              currentPhase: null,
              phases: this.autoOnboardPhases,
            }, null, 2) + "\n", "utf8");
          } catch { /* non-fatal */ }
        }
      } else {
        await this.saveOnboardState().catch(() => undefined);
      }
    }
  }

  /**
   * Run every test case in the AI-generated catalog sequentially. Used as
   * the final step of `autoOnboard()`. Skips gracefully when the catalog
   * doesn't exist (game not yet cold-started for testcase gen).
   *
   * Returns per-case results + aggregated counts. When `continueOnFail` is
   * true (default), keeps running after a fail; when false, bails on first
   * non-pass. Each case runs through `previewCase()` so the standard
   * pre-flight ensure-main + post-case eval still applies.
   */
  async runAllTestcases(
    opts: { continueOnFail?: boolean; caseFilter?: (id: string) => boolean; mode?: "all" | "unrun" | "failed" } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    results: Array<{ caseId: string; status: string; durationMs: number; skipReason?: string }>;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    if (!this.session || !this.gameSlug) {
      return { ok: false, reason: "no active session", results: [], passed: 0, failed: 0, skipped: 0 };
    }
    if (this.runAllInProgress) {
      return { ok: false, reason: "run-all already in progress", results: [], passed: 0, failed: 0, skipped: 0 };
    }
    const catalog = await loadAiCatalog(this.gameSlug);
    if (!catalog) {
      return {
        ok: false,
        reason: "test-cases.json not found — run cold-start (qa:cold) to generate the catalog first",
        results: [], passed: 0, failed: 0, skipped: 0,
      };
    }
    const continueOnFail = opts.continueOnFail ?? true;
    const mode = opts.mode ?? "all";
    const resultsByCaseId: Record<string, { status?: string }> = {};
    if (mode === "unrun" || mode === "failed") {
      const { readFile } = await import("node:fs/promises");
      const safe = (id: string) => id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      for (const c of catalog.cases) {
        const file = path.join(dirForGame(this.gameSlug), "case-evidence", `${safe(c.id)}.result.json`);
        try {
          const txt = await readFile(file, "utf8");
          const parsed = JSON.parse(txt) as { status?: string };
          resultsByCaseId[c.id] = { status: parsed.status };
        } catch {
          // no result yet for this case
        }
      }
    }
    const modeFilter = (id: string): boolean => {
      if (mode === "all") return true;
      const r = resultsByCaseId[id];
      if (mode === "failed") return !!r && r.status === "fail";
      return !r || r.status === "skip";
    };
    const cases = catalog.cases.filter((c) => modeFilter(c.id) && (!opts.caseFilter || opts.caseFilter(c.id)));
    const results: Array<{ caseId: string; status: string; durationMs: number; skipReason?: string }> = [];
    let passed = 0; let failed = 0; let skipped = 0;
    this.runAllInProgress = true;
    this.runAllProgress = {
      mode,
      total: cases.length,
      completed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      currentCaseId: null,
      startedAt: new Date().toISOString(),
      lastFinishedAt: null,
      rows: cases.map((c) => ({
        caseId: c.id,
        category: c.category,
        status: "pending",
      })),
    };
    console.log(`[manual/run-all] ${this.gameSlug}: starting — ${cases.length} cases (continueOnFail=${continueOnFail})`);
    try {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        this.runAllProgress.currentCaseId = c.id;
        if (this.runAllProgress.rows[i]) {
          this.runAllProgress.rows[i]!.status = "running";
          this.runAllProgress.rows[i]!.detail = "running";
        }
        console.log(`[manual/run-all] [${i + 1}/${cases.length}] ${c.id} (${c.severity ?? "?"}) — ${c.name}`);
        let runResult: Awaited<ReturnType<typeof this.previewCase>>;
        try {
          runResult = await this.previewCase(c.id, { ensureMain: true });
        } catch (err) {
          runResult = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        const status = runResult.result?.status ?? (runResult.ok ? "unknown" : "error");
        const durationMs = runResult.result?.durationMs ?? 0;
        results.push({ caseId: c.id, status, durationMs, skipReason: runResult.result?.skipReason });
        if (status === "pass") passed++;
        // "inconclusive" (e.g. free-spin trigger never fired — RNG) is NOT a
        // failure; group it with skipped so it never inflates the fail count.
        else if (status === "skip" || status === "inconclusive") skipped++;
        else failed++;
        const rowStatus: "pass" | "fail" | "skip" | "inconclusive" =
          status === "pass" ? "pass"
          : status === "skip" ? "skip"
          : status === "inconclusive" ? "inconclusive"
          : "fail";
        if (this.runAllProgress.rows[i]) {
          this.runAllProgress.rows[i]!.status = rowStatus;
          this.runAllProgress.rows[i]!.durationMs = durationMs;
          this.runAllProgress.rows[i]!.detail = runResult.result?.skipReason
            ? runResult.result.skipReason
            : `${(durationMs / 1000).toFixed(1)}s`;
        }
        this.runAllProgress.completed = results.length;
        this.runAllProgress.passed = passed;
        this.runAllProgress.failed = failed;
        this.runAllProgress.skipped = skipped;
        console.log(`[manual/run-all] [${i + 1}/${cases.length}] ${c.id} → ${status} (${(durationMs / 1000).toFixed(1)}s)`);
        if (!continueOnFail && status === "fail") {
          console.log(`[manual/run-all] bailing after fail (continueOnFail=false)`);
          break;
        }
      }
      console.log(`[manual/run-all] ${this.gameSlug}: done — ${passed} pass / ${failed} fail / ${skipped} skip`);
      return { ok: true, results, passed, failed, skipped };
    } finally {
      this.runAllInProgress = false;
      this.runAllProgress.currentCaseId = null;
      this.runAllProgress.lastFinishedAt = new Date().toISOString();
    }
  }

  /**
   * Post-discover registry audit pass. Reads EXPECTED_CHILDREN rules to:
   *  1. Prune LEGACY_NAMESPACES dups (old discoverVia calls using stateLabel
   *     as prefix when canonical trigger-key prefix also exists).
   *  2. For each parent missing REQUIRED children, call discoverVia(trigger,
   *     trigger) to re-open the popup and discover its elements (then probe
   *     the new entries).
   *  3. For each parent below dynamicPrefix threshold (e.g. bet popup with
   *     <5 bet-X entries), same as #2.
   *  4. Bidirectionally mirror verified entries across mirrorPartner pairs
   *     (betPlus ↔ betMinus): if betMinus__bet-1.00 is verified and
   *     betPlus__bet-1.00 isn't, copy verification (same coord, same popup).
   *
   *  No iterative re-audit — runs each phase once, bounded.
   */
  async verifyRegistry(opts: { reDiscover?: boolean } = {}): Promise<{
    ok: boolean;
    pruned: string[];
    reDiscoveredTriggers: Array<{ trigger: string; addedKeys: string[]; reason?: string }>;
    mirrored: Array<{ from: string; to: string }>;
  }> {
    if (!this.registry || !this.gameSlug) {
      return { ok: false, pruned: [], reDiscoveredTriggers: [], mirrored: [] };
    }
    const { auditRegistry, applyMirrorRules, pruneLegacyNamespaces } = await import("../registry/expected-children.js");

    // Phase 1 — prune legacy-namespace dups.
    const pruned = pruneLegacyNamespaces(this.registry as Record<string, any>);
    if (pruned.length > 0) {
      console.log(`[manual/verify] pruned ${pruned.length} legacy-namespace dups: ${pruned.slice(0, 4).join(",")}${pruned.length > 4 ? ",…" : ""}`);
      for (const k of pruned) delete this.verifyState[k];
    }

    // Phase 2 — re-discover missing required & dynamic-prefix children.
    // Skipped when reDiscover === false (auto-onboard's verify-only mode: QA
    // discovers all levels manually, so we must NOT auto-explore here).
    const audit = auditRegistry(this.registry as Record<string, any>);
    const reDiscoveredTriggers: Array<{ trigger: string; addedKeys: string[]; reason?: string }> = [];
    const triggersToReDiscover = new Set<string>();
    if (opts.reDiscover !== false) {
      for (const m of audit.missingRequired) triggersToReDiscover.add(m.trigger);
      for (const m of audit.missingDynamic) triggersToReDiscover.add(m.trigger);
    } else if (audit.missingRequired.length + audit.missingDynamic.length > 0) {
      console.log(`[manual/verify] reDiscover=false — NOT auto-discovering ${audit.missingRequired.length + audit.missingDynamic.length} missing expected-children (QA discovers manually)`);
    }
    for (const trigger of Array.from(triggersToReDiscover)) {
      console.log(`[manual/verify] re-discovering ${trigger} children…`);
      try {
        const r = await this.discoverVia(trigger, trigger);
        if (r.ok) {
          reDiscoveredTriggers.push({ trigger, addedKeys: r.addedKeys ?? [] });
          // Probe the freshly added children so we know which actually work.
          if ((r.addedKeys?.length ?? 0) > 0) {
            try {
              await this.probePendingElements({ onlyKeys: r.addedKeys });
            } catch (err) {
              console.warn(`[manual/verify] probe new ${trigger} children threw: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else {
          reDiscoveredTriggers.push({ trigger, addedKeys: [], reason: r.reason });
        }
      } catch (err) {
        reDiscoveredTriggers.push({ trigger, addedKeys: [], reason: err instanceof Error ? err.message : String(err) });
      }
      // Ensure we're back on main between re-discover invocations.
      try { await this.forceRecoverToMain({ maxWaitMs: 60_000 }); } catch {}
    }

    // Phase 3 — mirror partner pairs.
    const mirrored = applyMirrorRules(this.registry as Record<string, any>, new Date().toISOString());
    for (const m of mirrored) {
      this.verifyState[m.to] = "confirmed";
    }
    if (mirrored.length > 0) {
      console.log(`[manual/verify] mirrored ${mirrored.length} entries via partner-pair (e.g. ${mirrored[0]!.from} → ${mirrored[0]!.to})`);
    }

    await uiRegistry.save(this.gameSlug, this.registry);
    return { ok: true, pruned, reDiscoveredTriggers, mirrored };
  }

  /**
   * Invoke AI recover to suggest a new coord for a single element. QA reviewer
   * then [Click]s the proposed coord to verify; if right → [Confirm], if wrong
   * → [Manual] correction. Doesn't auto-save — QA decides.
   */
  async aiRecover(uiKey: string): Promise<{ ok: boolean; proposed?: { x: number; y: number; confidence: number }; reason?: string }> {
    if (!this.session || !this.registry) return { ok: false, reason: "no active session" };
    try {
      // Build context hint based on whether key is namespaced (sub-state):
      // - Main key (no "__") → no special context
      // - Namespaced (e.g. buy_feature_popup__closeButton) → tell AI a popup is open
      const isNamespaced = uiKey.includes("__");
      const stateLabel = isNamespaced ? uiKey.split("__")[0] : null;
      const contextHint = isNamespaced
        ? `A "${stateLabel}" popup/sub-screen is currently open on top of the main game. Find the element INSIDE that popup, NOT in the background main controls.`
        : undefined;

      // Settle before the recovery screenshot — same reason as discoverSubState.
      const settleMs = Number(process.env.QA_DISCOVER_SETTLE_MS ?? 1000);
      if (settleMs > 0) await this.session.page.waitForTimeout(settleMs).catch(() => undefined);
      const recovered = await aiRecoverLocator(this.session.page, uiKey, { contextHint });
      if (!recovered) return { ok: false, reason: "AI returned no coord — element may not be visible" };

      // STRICT VERIFY: re-check proposed coord with the verifier (crop +
      // describe-and-confirm AI call). Catches AI mistakes like proposing the
      // info "i" icon while we asked for menu "☰". verifier itself may refine
      // the coord across 2 more rounds before giving up.
      const bareKey = isNamespaced ? uiKey.split("__").slice(1).join("__") : uiKey;
      const hasVisualCheck = bareKey in ELEMENT_VISUAL_CHECK;
      let finalCoord = recovered;
      if (hasVisualCheck) {
        const fullBuf = await this.session.page.screenshot({ type: "png" });
        const debugDir = path.join(dirForGame(this.gameSlug), "debug-ai-recover");
        await mkdir(debugDir, { recursive: true });
        const verification = await verifyElement(
          this.session.page,
          bareKey,
          { x: recovered.x, y: recovered.y, confidence: recovered.confidence },
          fullBuf,
          debugDir,
        );
        if (!verification.verified || !verification.finalCoord) {
          const lastTrace = verification.trace[verification.trace.length - 1];
          const what = lastTrace ? lastTrace.what : "unknown";
          return {
            ok: false,
            reason: `AI proposed (${recovered.x},${recovered.y}) but verifier rejected after ${verification.rounds} rounds — actual content at that coord: "${what}". Try [Manual Coord] or re-take screenshot.`,
          };
        }
        // verifier may have refined to a better coord — use that
        finalCoord = {
          ...recovered,
          x: verification.finalCoord.x,
          y: verification.finalCoord.y,
          confidence: verification.finalCoord.confidence,
        };
      }

      // Sanity check for namespaced (popup) keys: reject coord if it overlaps
      // a known main-state element (AI probably saw through the popup).
      if (isNamespaced) {
        const COORD_OVERLAP_PX = 30;
        for (const [k, el] of Object.entries(this.registry)) {
          if (!el || k.includes("__")) continue;
          if (Math.abs(el.x - finalCoord.x) < COORD_OVERLAP_PX && Math.abs(el.y - finalCoord.y) < COORD_OVERLAP_PX) {
            return { ok: false, reason: `Coord (${finalCoord.x},${finalCoord.y}) overlaps main-state ${k} — popup likely not open. Re-open popup and retry.` };
          }
        }
      }

      // Update coord (status pending). QA verifies via [Click] then [Confirm].
      this.registry[uiKey] = {
        ...this.registry[uiKey],
        x: finalCoord.x,
        y: finalCoord.y,
        strategy: "ai_recover",
        confidence: finalCoord.confidence,
        status: "pending",
        detectedAt: finalCoord.detectedAt,
      };
      this.verifyState[uiKey] = "pending";
      return { ok: true, proposed: { x: finalCoord.x, y: finalCoord.y, confidence: finalCoord.confidence } };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Remove a registry entry (e.g. AI hallucinated, doesn't actually exist). */
  async removeElement(uiKey: string): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    delete this.registry[uiKey];
    delete this.verifyState[uiKey];
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Click-thru capture: QA clicks DIRECTLY in the Playwright Chrome window.
   * A capture-phase DOM listener intercepts the click → captures (clientX,
   * clientY) → saves to registry → preventDefault so the game doesn't react.
   *
   * Used when AI Recover keeps failing (e.g. menu icon too small / ambiguous).
   * QA just clicks the real button — no screenshot scaling, no manual coord
   * entry. Coord saved with strategy "manual" + verifiedBy: "QA".
   *
   * The listener registers with { once: true } so it auto-removes after one click.
   */
  async captureNextClick(uiKey: string, opts: { timeoutMs?: number; failIfExists?: boolean } = {}): Promise<{ ok: boolean; coord?: { x: number; y: number }; reason?: string }> {
    const timeoutMs = opts.timeoutMs ?? 30000;
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    if (opts.failIfExists && this.registry[uiKey]) {
      return { ok: false, reason: `uiKey '${uiKey}' already exists — use Pick in Game on its row to update, or Remove first` };
    }
    const page = this.session.page;
    try {
      // Pass as plain JS string — TS function would carry esbuild's __name()
      // helper into the browser context and fail with "__name is not defined".
      const captureScript = `
        new Promise(function(resolve) {
          document.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            resolve({ x: e.clientX, y: e.clientY });
          }, { capture: true, once: true });
        })
      `;
      const result = (await Promise.race([
        page.evaluate(captureScript),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms — no click captured`)), timeoutMs),
        ),
      ])) as { x: number; y: number };

      const now = new Date().toISOString();
      const existing = this.registry[uiKey];
      this.registry[uiKey] = {
        baselineScreenshot: existing?.baselineScreenshot,
        ...(existing ?? {}),
        x: Math.round(result.x),
        y: Math.round(result.y),
        strategy: "manual",
        confidence: 1.0,
        detectedAt: now,
        verifiedBy: "QA",
        status: "verified",
        verifiedAt: now,
      };
      this.verifyState[uiKey] = "confirmed";
      await uiRegistry.save(this.gameSlug, this.registry);
      return { ok: true, coord: { x: Math.round(result.x), y: Math.round(result.y) } };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Navigate the existing browser to a new URL — used when token changes
   * (gameUrl updated) so registry coords can be re-verified live without
   * destroying the session.
   */
  async navigateTo(newUrl: string): Promise<void> {
    if (!this.session) throw new Error("no active session");
    this.gameUrl = newUrl;
    await this.session.page.goto(newUrl, { waitUntil: "domcontentloaded" });
  }

  /** Take a fresh screenshot of the current browser state. */
  async screenshot(): Promise<Buffer | null> {
    if (!this.session) return null;
    return this.session.page.screenshot({ type: "png" });
  }

  /** Load current ocr-regions.json for the active game. Returns empty object
   *  when none exist yet (UI shows "no regions defined" state).
   *  Also returns any pending PROPOSALS from ocr-regions.proposed.json
   *  (low-confidence picks the auto-detector flagged for QA review).
   *  Saved keys take priority — if a key appears in both lists, the
   *  proposal is filtered out (already accepted/superseded). */
  async loadOcrRegions(): Promise<{
    ok: boolean;
    regions?: import("../registry/types.js").OcrRegions;
    proposals?: import("../registry/ocr-regions-proposed.js").OcrProposalsFile["proposals"];
    reason?: string;
  }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const { loadOcrProposals } = await import("../registry/ocr-regions-proposed.js");
    const cur = (await ocrRegions.load(slug)) ?? {};
    const propFile = await loadOcrProposals(slug);
    // Filter proposals: if a key is already in saved regions, drop the
    // proposal — QA has already committed (or auto-detector vetted it).
    const proposals: typeof propFile.proposals = {};
    for (const [key, entry] of Object.entries(propFile.proposals)) {
      if (!entry) continue;
      if ((cur as Record<string, unknown>)[key]) continue;
      (proposals as Record<string, typeof entry>)[key] = entry;
    }
    return { ok: true, regions: cur, proposals };
  }

  /** Persist a region patch into ocr-regions.json (merge into existing).
   *  Caller passes one or more of balanceArea/betArea/winArea/freeSpinCounter
   *  as `{x, y, width, height}`. */
  async saveOcrRegion(
    key: "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
    region: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: boolean; regions?: import("../registry/types.js").OcrRegions; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    if (region.width <= 0 || region.height <= 0) return { ok: false, reason: "width and height must be positive" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const cur = (await ocrRegions.load(slug)) ?? {};
    const next = { ...cur, [key]: region };
    await ocrRegions.save(slug, next);
    // Clear any pending proposal for this key — QA has committed (either
    // by Accept on a proposal or Draw of a fresh bbox). Dashboard should
    // not continue to show "pending review" for a now-saved region.
    try {
      const { dropOcrProposal } = await import("../registry/ocr-regions-proposed.js");
      await dropOcrProposal(slug, key as keyof import("../registry/ocr-regions-proposed.js").OcrProposalsFile["proposals"]);
    } catch {
      /* non-fatal — proposal cleanup failure shouldn't break the save */
    }
    return { ok: true, regions: next };
  }

  /** AI auto-detect OCR-region bboxes via Claude vision. Takes a current
   *  screenshot, asks the model to locate the Balance / Bet / Win / FS-counter
   *  widgets, and merges the high-confidence results into ocr-regions.json
   *  (low-confidence ones are returned but NOT persisted — QA reviews them).
   *
   *  Replaces the manual "Draw bbox by clicking two corners" flow for games
   *  where these widgets are positioned conventionally. The endpoint stays
   *  available alongside Draw so QA can override AI guesses.
   *
   *  @param opts.regions  Subset of region keys to detect; defaults to all four.
   *  @param opts.minConfidence  Only persist regions with confidence ≥ this
   *    threshold (default 0.7). Lower-confidence picks come back as
   *    `proposed` for QA to review before saving.
   */
  async autoDetectOcrRegions(
    opts: {
      regions?: ReadonlyArray<"balanceArea" | "betArea" | "winArea" | "freeSpinCounter">;
      /** Pre-captured main-screen PNG. When provided, all crop verification
       *  is done in-memory against this buffer — no live `page.screenshot`
       *  calls. Used by `autoOnboard` to parallelise OCR-region detection
       *  with deep-discover (which is busy opening popups; concurrent
       *  page.screenshot would race against its state changes). */
      baselineScreenshot?: Buffer;
    } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    saved: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null }>;
    proposed: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null; rejectReason: string }>;
    skipped: Array<{ key: string; reason: string }>;
    regions?: import("../registry/types.js").OcrRegions;
  }> {
    if (!this.session || !this.gameSlug) {
      return { ok: false, reason: "no active session", saved: [], proposed: [], skipped: [] };
    }
    const page = this.session.page;
    // Use the caller-supplied baseline when present (parallel autoOnboard
    // path); otherwise grab a fresh shot (standalone dashboard call).
    const usingBaseline = Boolean(opts.baselineScreenshot);
    const shot = opts.baselineScreenshot ?? await page.screenshot({ type: "png" });
    const shotBase64 = shot.toString("base64");
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const { detectOcrRegions, verifyOcrRegionCrop } = await import("../../ai/detect-ocr-regions.js");
    const detection = await detectOcrRegions({ screenshotBase64: shotBase64, viewport: vp, regions: opts.regions });

    const saved: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null }> = [];
    const proposed: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null; rejectReason: string }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];

    const { ocrRegions } = await import("../registry/ocr-regions.js");
    let merged: Record<string, any> = { ...((await ocrRegions.load(this.gameSlug)) ?? {}) };

    const NUMERIC_KEYS = new Set(["balanceArea", "betArea", "winArea"]);
    const MAX_REFINEMENT_ITERS = 3; // initial pick + up to 3 refinements

    for (const [key, entry] of Object.entries(detection)) {
      if (!entry) continue;
      if ((entry as { skipped?: boolean }).skipped) {
        skipped.push({ key, reason: (entry as { reason?: string }).reason ?? "skipped" });
        continue;
      }
      const r = entry as { x: number; y: number; width: number; height: number; confidence: number; reason: string };
      let bbox = { x: r.x, y: r.y, width: r.width, height: r.height };
      let visionConfidence = r.confidence;
      let visionReason = r.reason;
      let aiValueRead: string | null = null;
      let lastVerdictReason = "";
      let verified = false;
      const rejectedHistory: Array<{ bbox: { x: number; y: number; width: number; height: number }; reason: string }> = [];

      // CROP-AND-VERIFY LOOP with anti-oscillation + OCR ground-truth.
      // AI vision can hallucinate `value_read` ("I see $99,991,116.99" when
      // the crop is empty/wrong widget); we Tesseract-OCR the EXACT cropped
      // pixels AI approved and confirm the digits match before promoting
      // to `verified`. If AI says verified but OCR disagrees, treat as
      // rejected and feed the mismatch into rejectedHistory so the next
      // refinement aims somewhere new.
      const { ocrBuffer, parseNumericFromOcr } = await import("../utils/ocr-popup.js");
      let ocrText: string | undefined;
      let ocrParsed: number | null | undefined;

      for (let iter = 0; iter < MAX_REFINEMENT_ITERS + 1; iter++) {
        let cropBuf: Buffer;
        try {
          const clip = clampBboxForViewport(bbox, vp);
          cropBuf = usingBaseline
            ? cropPngBufferSync(shot, clip)
            : await page.screenshot({ type: "png", clip });
        } catch (err) {
          lastVerdictReason = `crop screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        const verdict = await verifyOcrRegionCrop({
          cropBase64: cropBuf.toString("base64"),
          fullScreenshotBase64: shotBase64,
          bbox,
          region: key as "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
          viewport: vp,
          rejectedHistory,
        });
        lastVerdictReason = verdict.reason;
        aiValueRead = verdict.valueRead;

        if (verdict.verified) {
          // Ground-truth: Tesseract on the SAME crop. Numeric widgets must
          // yield a parseable number. FS counter just needs non-empty text.
          let groundTruthOk = true;
          let groundTruthDetail = "";
          try {
            const ocr = await ocrBuffer(cropBuf);
            ocrText = ocr.text;
            ocrParsed = parseNumericFromOcr(ocr.text);
            const isNumericKey = NUMERIC_KEYS.has(key);
            groundTruthOk = isNumericKey
              ? typeof ocrParsed === "number" && Number.isFinite(ocrParsed)
              : ocr.text.trim().length > 0;
            groundTruthDetail = `OCR read "${ocr.text.trim().slice(0, 80)}" (parsed=${ocrParsed ?? "null"})`;
          } catch (err) {
            groundTruthOk = false;
            groundTruthDetail = `Tesseract threw: ${err instanceof Error ? err.message : String(err)}`;
          }

          if (groundTruthOk) {
            verified = true;
            console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter} VERIFIED — AI: "${aiValueRead}" / ${groundTruthDetail}`);
            break;
          }
          // AI claimed verified but Tesseract couldn't read a number → AI
          // hallucinated. Demote to rejected, feed back into history so the
          // next refinement aims away from this empty/wrong-widget bbox.
          console.warn(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter} AI said verified ("${aiValueRead}") but Tesseract DISAGREES (${groundTruthDetail}) — treating as REJECTED`);
          lastVerdictReason = `AI hallucinated value_read="${aiValueRead}" — Tesseract: ${groundTruthDetail}`;
          rejectedHistory.push({ bbox, reason: lastVerdictReason });
          if (iter === MAX_REFINEMENT_ITERS) break;
          // No AI-suggested refinement here (AI thought it was right), so
          // we widen the bbox by 50% and re-try in case the issue was a
          // too-tight crop clipping digits. Bail if widening doesn't help.
          const widened = {
            x: Math.max(0, Math.round(bbox.x - bbox.width * 0.25)),
            y: Math.max(0, Math.round(bbox.y - bbox.height * 0.25)),
            width: Math.round(bbox.width * 1.5),
            height: Math.round(bbox.height * 1.5),
          };
          // If widening would overlap a previously-rejected bbox, bail.
          const widenOverlaps = rejectedHistory.slice(0, -1).some((h) =>
            Math.abs(h.bbox.x - widened.x) <= 10 && Math.abs(h.bbox.y - widened.y) <= 10,
          );
          if (widenOverlaps) {
            console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} widened bbox overlaps already-rejected — bailing`);
            break;
          }
          bbox = widened;
          continue;
        }

        if (!verdict.refinedBbox || iter === MAX_REFINEMENT_ITERS) break;

        // Anti-oscillation: reject refinement within ±10 px of a previously-
        // rejected bbox — AI is just looping on the same wrong place.
        const overlapsRejected = rejectedHistory.some((h) =>
          Math.abs(h.bbox.x - verdict.refinedBbox!.x) <= 10
          && Math.abs(h.bbox.y - verdict.refinedBbox!.y) <= 10,
        );
        if (overlapsRejected) {
          console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter + 1} refined bbox overlaps already-rejected — bailing (no convergence)`);
          lastVerdictReason = `refinement oscillated near already-rejected bbox — no convergence (${verdict.reason})`;
          break;
        }
        rejectedHistory.push({ bbox, reason: verdict.reason });
        console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter + 1} refining bbox → ${JSON.stringify(verdict.refinedBbox)} (${verdict.reason})`);
        bbox = verdict.refinedBbox;
      }

      const isNumericKey = NUMERIC_KEYS.has(key);
      const row = {
        key,
        region: bbox,
        visionConfidence,
        aiValueRead,
        aiReason: lastVerdictReason || visionReason,
        ocrText,
        ocrParsed,
      };
      if (verified) {
        merged[key] = bbox;
        saved.push(row);
      } else {
        const why = isNumericKey
          ? `AI rejected crop: ${lastVerdictReason || "unverified"}`
          : `AI could not verify crop: ${lastVerdictReason || "unverified"}`;
        proposed.push({ ...row, rejectReason: why });
      }
    }
    if (saved.length > 0) {
      await ocrRegions.save(this.gameSlug, merged as import("../registry/types.js").OcrRegions);
      console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: AI vision-verified ${saved.length} regions (${saved.map((s) => `${s.key}→${s.aiValueRead ?? s.ocrParsed ?? "?"}`).join(", ")}); ${proposed.length} need review, ${skipped.length} skipped`);
    } else {
      console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: no vision-verified picks — ${proposed.length} proposed for review, ${skipped.length} skipped`);
    }

    // Persist proposals to disk so the dashboard's OCR Regions panel can
    // show them as "pending review" rows. Without this, Auto-Onboard's
    // proposals were silently dropped (manual button surfaced them in
    // a one-off popup but Auto-Onboard ran in background with no popup).
    // Save once per run — wipe slate of prior proposals for the keys
    // this run produced, then write current `proposed` list keyed by
    // region name. The mergeOcrProposals helper preserves keys this run
    // didn't touch (skipped widgets keep their prior proposal if any).
    try {
      const { mergeOcrProposals, dropOcrProposal } = await import("../registry/ocr-regions-proposed.js");
      const nowIso = new Date().toISOString();
      const proposalMap: Record<string, import("../registry/ocr-regions-proposed.js").OcrProposalEntry> = {};
      for (const p of proposed) {
        proposalMap[p.key] = {
          region: p.region,
          visionConfidence: p.visionConfidence,
          aiValueRead: p.aiValueRead,
          aiReason: p.aiReason,
          ocrText: p.ocrText,
          ocrParsed: p.ocrParsed,
          rejectReason: p.rejectReason,
          proposedAt: nowIso,
        };
      }
      await mergeOcrProposals(this.gameSlug, proposalMap);
      // Any key that just got SAVED should not also have a stale proposal —
      // wipe its proposal so the dashboard doesn't show "saved + pending review"
      // for the same key. Cheap (at most 4 keys).
      for (const s of saved) {
        await dropOcrProposal(this.gameSlug, s.key as keyof import("../registry/ocr-regions-proposed.js").OcrProposalsFile["proposals"]);
      }
    } catch (err) {
      // Non-fatal — proposals fail to persist → user just has to re-run
      // manual auto-detect to see them. Logged so it's noticed.
      console.warn(`[manual/ocr-region/auto-detect] ${this.gameSlug}: failed to persist proposals: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: true, saved, proposed, skipped, regions: merged as import("../registry/types.js").OcrRegions };
  }

  /** Reject one pending OCR-region proposal — wipes it from
   *  ocr-regions.proposed.json without saving. Used by the dashboard's
   *  "Reject" button on pending review rows. Pairs with saveOcrRegion
   *  (which is the implicit "accept" flow). */
  async rejectOcrProposal(
    key: "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
  ): Promise<{ ok: boolean; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    const { dropOcrProposal } = await import("../registry/ocr-regions-proposed.js");
    await dropOcrProposal(slug, key);
    return { ok: true };
  }

  /** Delete one region entry from ocr-regions.json. */
  async removeOcrRegion(
    key: "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
  ): Promise<{ ok: boolean; regions?: import("../registry/types.js").OcrRegions; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const cur = (await ocrRegions.load(slug)) ?? {};
    if (!(key in cur)) return { ok: true, regions: cur };
    const next: Record<string, unknown> = { ...cur };
    delete next[key];
    await ocrRegions.save(slug, next as import("../registry/types.js").OcrRegions);
    return { ok: true, regions: next as import("../registry/types.js").OcrRegions };
  }

  /** Test-fire OCR on a bbox without persisting — QA draws a rectangle, hits
   *  "Test", sees the OCR text + parsed number before committing the region. */
  async testOcrRegion(
    region: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: boolean; text?: string; parsedValue?: number | null; durationMs?: number; reason?: string }> {
    if (!this.session) return { ok: false, reason: "no active session" };
    if (region.width <= 0 || region.height <= 0) return { ok: false, reason: "width and height must be positive" };
    const { ocrRegion, parseNumericFromOcr } = await import("../utils/ocr-popup.js");
    try {
      const ocr = await ocrRegion(this.session.page, {
        x: region.x,
        y: region.y,
        w: region.width,
        h: region.height,
      }, { numeric: true });
      return {
        ok: true,
        text: ocr.text,
        parsedValue: parseNumericFromOcr(ocr.text),
        durationMs: ocr.durationMs,
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Pre-flight check used before running each test case in a batch — verify
   * the game is sitting on the main play screen, not stuck in a popup or
   * sub-state from the previous case. Two-layer detection (B + C):
   *   B1) OCR keywords: scan screenshot for "PAYTABLE", "CONGRATULATIONS",
   *       "BUY FEATURE", etc. → popup present.
   *   B2) Dark overlay: sample 4 corners' brightness — semi-transparent
   *       popup dimmer means main is covered.
   *   C)  Behavioral probe (opt-in): click spinButton, listen 3s for a
   *       /gameService response. Response → confirmed on main. No response
   *       within 3s → popup/frozen → not on main.
   *
   * Caller can request recovery via `autoRecover: true` — runs ESC×2 +
   * click corner + 1500ms wait, re-detects up to maxRecoverAttempts (2).
   *
   * @returns onMain: final verdict; details: each layer's result; recovered:
   *          true if was off-main but successfully returned via recovery.
   */
  /**
   * Manual trigger for the runtime `ensure_ante_off` enforcement (dashboard
   * button). Runs the SAME `ensureAnteOff` used in case-run preambles against
   * the live session so a QA can eyeball whether it actually lands ante OFF
   * (watch the embedded Chrome + the returned bet/toggle counts).
   */
  async testEnsureAnteOff(): Promise<{
    ok: boolean;
    wasOff?: boolean;
    toggledCount?: number;
    hasAnteButton: boolean;
    reason?: string;
  }> {
    if (!this.session || !this.gameSlug || !this.registry) {
      return { ok: false, hasAnteButton: false, reason: "no active session" };
    }
    if (!this.registry["anteButton"]) {
      return { ok: true, hasAnteButton: false, reason: "registry has no anteButton (game has no ante feature)" };
    }
    const r = await ensureAnteOff(this.session.page, this.gameSlug, this.registry);
    return { ok: r.ok, wasOff: r.wasOff, toggledCount: r.toggledCount, hasAnteButton: true, reason: r.reason };
  }

  async ensureMainScreen(opts: {
    probe?: boolean;
    autoRecover?: boolean;
    maxRecoverAttempts?: number;
    /** Escalate to the AI-vision dismissal tier when deterministic recovery
     *  (keyword/Escape/corner) can't clear a blocker — handles promo splashes
     *  whose only dismiss control is a play/continue/skip button the blind taps
     *  miss. Off by default (costs an AI call); the QA wizard enables it. */
    aiDismiss?: boolean;
  } = {}): Promise<{
    ok: boolean;
    onMain: boolean;
    recovered: boolean;
    layers: {
      ocr?: { hasPopup: boolean; matched: string[]; durationMs: number };
      overlay?: { overlayPresent: boolean; cornerBrightness: number[]; durationMs: number };
      aiReady?: { playScreenReady: boolean | null; durationMs: number };
      probe?: { spinFired: boolean; durationMs: number };
    };
    reason?: string;
    attempts: number;
    /** True when off-main was due to a free-spin chain still playing (can't be
     *  dismissed — must wait for it to finish). Callers should poll/wait. */
    fsActive?: boolean;
  }> {
    if (!this.session) return { ok: false, onMain: false, recovered: false, layers: {}, reason: "no active session", attempts: 0 };
    const page = this.session.page;
    if (opts.aiDismiss) console.log(`[ensure-main] ▶ aiDismiss ENABLED — AI vision will classify ambiguous overlays + dismiss blockers (NEW CODE PATH)`);
    const maxAttempts = (opts.autoRecover === false ? 0 : (opts.maxRecoverAttempts ?? 2)) + 1;
    let fsActive = false;
    const layers: {
      ocr?: { hasPopup: boolean; matched: string[]; durationMs: number };
      overlay?: { overlayPresent: boolean; cornerBrightness: number[]; durationMs: number };
      aiReady?: { playScreenReady: boolean | null; durationMs: number };
      probe?: { spinFired: boolean; durationMs: number };
    } = {};
    let recovered = false;
    // Resolve per-game popup keywords (defaults if no override)
    const popupKws = await resolvePopupKeywords(this.gameSlug);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Layer B1: OCR keyword scan
      const ocr = await detectAnyPopup(page, {
        interstitialKeywords: popupKws.interstitial,
        substateKeywords: popupKws.substate,
      });
      // Common false-positive: some games always render an "AUTOPLAY" button
      // on the main screen. If OCR matched ONLY that label (no interstitial
      // text, no other substate cues), treat it as on-main noise.
      if (ocr.substate && !ocr.interstitial) {
        const lower = ocr.matchedKeywords.map((k) => k.toLowerCase());
        const autoplayOnly =
          lower.length > 0
          && lower.every((k) => k === "autoplay" || k === "auto play");
        if (autoplayOnly) {
          console.log(`[ensure-main] attempt ${attempt}: suppressing autoplay-only OCR match (main-screen label)`);
          ocr.hasPopup = false;
          ocr.substate = false;
          ocr.matchedKeywords = [];
        }
      }
      layers.ocr = { hasPopup: ocr.hasPopup, matched: ocr.matchedKeywords, durationMs: ocr.durationMs };
      console.log(`[ensure-main] attempt ${attempt} OCR: hasPopup=${ocr.hasPopup} matched=[${ocr.matchedKeywords.join(",")}] ms=${ocr.durationMs}`);

      // Layer B2: dark overlay sampler — reuse OCR screenshot to avoid a
      // second page.screenshot() call (each forces browser repaint in headed
      // mode → flicker). QA_SKIP_DARK_OVERLAY=1 disables this layer entirely.
      const overlay = process.env.QA_SKIP_DARK_OVERLAY === "1"
        ? { overlayPresent: false, cornerBrightness: [] as number[], durationMs: 0 }
        : await detectDarkOverlay(page, { sharedScreenshot: ocr.screenshot });
      layers.overlay = { overlayPresent: overlay.overlayPresent, cornerBrightness: overlay.cornerBrightness, durationMs: overlay.durationMs };
      console.log(`[ensure-main] attempt ${attempt} overlay: present=${overlay.overlayPresent} corners=[${overlay.cornerBrightness.join(",")}]`);

      // Overlay detector false-positives on games whose main UI has dark
      // corners (vs20rnriches, vsfiestamagenta…). Symptom: OCR consistently
      // reports no popup keywords but overlay flags present every attempt →
      // recover loop spins forever without making progress.
      // Policy: trust overlay on the FIRST attempt only (catches transient
      // dark popups + lets recovery try). On subsequent attempts, when OCR
      // remains "no popup", treat overlay as game-UI decoration and proceed.
      let overlayBlocking = overlay.overlayPresent && (attempt === 1 || ocr.hasPopup);
      // Ambiguous case: overlay persists but OCR is clean. Normally we downgrade
      // to "game-UI decoration" and proceed — but that wrongly passes promo
      // splashes whose stylized text OCR can't read (e.g. Playtech "WITH A MOVING
      // CASH COLLECT"). When aiDismiss is on, ask AI vision to classify: a real
      // play screen → proceed; a blocker → keep it blocking so recovery runs.
      if (overlay.overlayPresent && !overlayBlocking && opts.aiDismiss) {
        const aiStart = Date.now();
        const ready = await this.aiIsPlayScreenReady();
        layers.aiReady = { playScreenReady: ready, durationMs: Date.now() - aiStart };
        if (ready === false) {
          overlayBlocking = true;
          console.log(`[ensure-main] attempt ${attempt}: AI says NOT the play screen → overlay is a blocker, recovering`);
        } else {
          console.log(`[ensure-main] attempt ${attempt}: AI confirms play screen (or inconclusive) → proceeding`);
        }
      }
      const popupSignalB = ocr.hasPopup || overlayBlocking;
      if (overlay.overlayPresent && !overlayBlocking) {
        console.log(`[ensure-main] attempt ${attempt}: overlay still present but OCR clean — treating as game-UI decoration (not a popup), proceeding`);
      }

      // Distinguish an ACTIVE free-spin chain (FS counter / in-progress text,
      // no "press anywhere" dismiss affordance) from a dismissable popup. An
      // active FS chain CANNOT be dismissed (ESC/click won't stop it) — it must
      // play out. Flag it so we skip recovery + let the caller poll/wait.
      fsActive = isFreeSpinChainActive(ocr.matchedKeywords);

      // Layer C: behavioral probe (only when B says "clean" + opt-in)
      if (!popupSignalB && opts.probe === true) {
        const probe = await this.behavioralProbe();
        layers.probe = probe;
        console.log(`[ensure-main] attempt ${attempt} probe: spinFired=${probe.spinFired} ms=${probe.durationMs}`);
        if (probe.spinFired) {
          return { ok: true, onMain: true, recovered, layers, attempts: attempt };
        }
        // Probe failed → treat as off-main; fall through to recovery.
      } else if (!popupSignalB) {
        // B passed, probe not requested. When AI dismissal is enabled, require
        // positive play-screen evidence before trusting an otherwise "clean"
        // screenshot: Playtech/GPAS feature splashes can show a large PLAY
        // launcher button without OCR/popup/dark-overlay signals, and those
        // screens are NOT MAIN yet.
        if (opts.aiDismiss) {
          const aiStart = Date.now();
          const ready = await this.aiIsPlayScreenReady();
          layers.aiReady = { playScreenReady: ready, durationMs: Date.now() - aiStart };
          if (ready === false) {
            console.log(`[ensure-main] attempt ${attempt}: AI says clean screen is NOT MAIN → recovering/dismissing blocker`);
          } else if (ready === true) {
            console.log(`[ensure-main] attempt ${attempt}: AI positive MAIN evidence confirmed`);
            return { ok: true, onMain: true, recovered, layers, attempts: attempt };
          } else {
            console.log(`[ensure-main] attempt ${attempt}: AI MAIN check inconclusive → falling back to OCR/overlay verdict`);
            return { ok: true, onMain: true, recovered, layers, attempts: attempt };
          }
        } else {
          // Legacy fast path for callers that explicitly disable AI dismissal.
          return { ok: true, onMain: true, recovered, layers, attempts: attempt };
        }
        // AI says this clean-looking screen is still pre-game/off-main; fall
        // through to recovery.
        recovered = true;
        if (attempt < maxAttempts) {
          if (attempt >= 2) {
            const ai = await this.aiDismissToMain(3);
            console.log(`[ensure-main] attempt ${attempt}: AI dismissal issued ${ai.clicked} click(s), ready=${ai.ready}`);
          } else {
            await this.recoverToMain();
          }
          continue;
        }
      }

      // OFF MAIN → recover, UNLESS a free-spin chain is playing (don't ESC/click
      // an auto-playing chain — just let the caller wait it out).
      if (attempt < maxAttempts) {
        if (fsActive) {
          console.log(`[ensure-main] attempt ${attempt}: free-spin chain in progress → waiting (no dismiss)`);
        } else {
          recovered = true;
          // Tier 1 (attempt 1): cheap deterministic recover. Tier 2 (attempt ≥2,
          // when enabled): AI-vision locates the exact dismiss/continue control —
          // for promo splashes the blind corner-tap can't hit.
          if (opts.aiDismiss && attempt >= 2) {
            const ai = await this.aiDismissToMain(3);
            console.log(`[ensure-main] attempt ${attempt}: AI dismissal issued ${ai.clicked} click(s), ready=${ai.ready}`);
          } else {
            await this.recoverToMain();
          }
        }
      }
    }

    return {
      ok: false,
      onMain: false,
      recovered,
      layers,
      fsActive,
      reason: fsActive
        ? `free-spin chain still playing: ${layers.ocr?.matched.join(", ")}`
        : layers.ocr?.hasPopup
        ? `popup detected: ${layers.ocr.matched.join(", ")}`
        : layers.overlay?.overlayPresent
        ? `dark overlay covering corners [${layers.overlay.cornerBrightness.join(",")}]`
        : layers.aiReady?.playScreenReady === false
        ? "AI classifier says current screen is not the main play screen"
        : layers.probe && !layers.probe.spinFired
        ? "spinButton click did not fire a spin within 3s"
        : "unknown",
      attempts: maxAttempts,
    };
  }

  /**
   * Inter-case wait: poll ensureMainScreen on a 2s tick until we land on
   * the main play screen OR maxWaitMs elapses. Used instead of an arbitrary
   * fixed delay between cases — exits as soon as game is ready so fast cases
   * don't wait 60s, slow cases (free-spin cascade chain) get however long
   * they need within the cap.
   *
   * Returns total elapsed + final state so dashboard can report.
   */
  async waitForMainScreen(opts: { maxWaitMs?: number; pollMs?: number; aiDismiss?: boolean } = {}): Promise<{
    onMain: boolean;
    elapsedMs: number;
    polls: number;
    recoveredCount: number;
    reason?: string;
  }> {
    const maxWait = Math.max(2000, opts.maxWaitMs ?? 90_000);
    // Increased default from 2s → 5s to reduce screenshot frequency (each
    // poll = ~2 screenshots in headed mode → causes browser flicker).
    const pollMs = Math.max(500, opts.pollMs ?? 5000);
    const start = Date.now();
    let polls = 0;
    let recoveredCount = 0;
    // Only escalate to AI on the FIRST poll's recovery — repeating the (costly)
    // AI dismissal every 5s tick would burn vision calls; one shot is enough to
    // clear a promo splash, and the deterministic recover handles the rest.
    while (Date.now() - start < maxWait) {
      polls++;
      // AI dismissal defaults ON (opt out with QA_DISMISS_AI=0). Cost is bounded:
      // it only runs on the FIRST poll, and only actually calls AI when the OCR/
      // overlay layers are ambiguous (overlay present + OCR clean) — a clean main
      // screen never triggers a vision call. This is what gets promo splashes
      // (Playtech, etc.) cleared in EVERY spin path (calibrate, case preflight,
      // onboarding), so spins fire and the provider learner gets samples.
      const useAi = opts.aiDismiss ?? (process.env.QA_DISMISS_AI !== "0");
      const aiThisPoll = useAi && polls === 1;
      // AI dismissal only fires on attempt ≥2, so give the first poll 2 recover
      // attempts when AI is enabled (deterministic → AI). Other polls stay cheap.
      const r = await this.ensureMainScreen({ probe: false, autoRecover: true, maxRecoverAttempts: aiThisPoll ? 2 : 1, aiDismiss: aiThisPoll });
      if (r.recovered) recoveredCount++;
      if (r.onMain) {
        console.log(`[wait-for-main] onMain after ${Date.now() - start}ms (${polls} polls, ${recoveredCount} recoveries)`);
        return { onMain: true, elapsedMs: Date.now() - start, polls, recoveredCount };
      }
      // Wait remaining poll window before next check
      const elapsed = Date.now() - start;
      const remaining = maxWait - elapsed;
      if (remaining > 0) await this.session?.page.waitForTimeout(Math.min(pollMs, remaining));
    }
    return {
      onMain: false,
      elapsedMs: Date.now() - start,
      polls,
      recoveredCount,
      reason: `gave up after ${maxWait}ms — game stuck off-main`,
    };
  }

  /**
   * Recovery moves used when off-main detected:
   *   1. Try OCR auto-dismiss loop (handles "PRESS ANYWHERE TO CONTINUE" etc.)
   *   2. Press ESC × 2 (closes most modal popups)
   *   3. Click viewport corner (5, 5) — outside any centered popup
   *   4. Wait 1500ms for animations to settle
   * Doesn't return success; caller re-runs detection to verify.
   */
  /**
   * Detect + stop autoplay leaked from a prior session. Slot game servers
   * persist account state — if the previous QA browser exited mid-autoplay,
   * reopening the same game URL resumes spinning automatically. Manifests as
   * spontaneous /gameService POST responses with no QA input.
   *
   * Detection: watch for spontaneous spin responses for ~3s. Stop: click the
   * spinButton (shows STOP icon during autoplay) + dismiss the "Stop
   * Autoplay?" confirmation popup. If spinButton isn't registered yet (start()
   * before Discover), fall back to a viewport-center click.
   *
   * Called from start() + resume() after popup dismiss, before any operation
   * that assumes the game is idle. Adds ~3s when no autoplay (cheap insurance).
   */
  private async stopAutoplayIfActive(): Promise<{ wasActive: boolean }> {
    if (!this.session) return { wasActive: false };
    const page = this.session.page;
    let spinObserved = false;
    const handler = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url()) && res.request().method() === "POST") {
        spinObserved = true;
      }
    };
    page.on("response", handler);
    try {
      await page.waitForTimeout(3000);
    } finally {
      page.off("response", handler);
    }
    if (!spinObserved) return { wasActive: false };

    console.log("[manual/autoplay-stop] spontaneous gameService POST observed within 3s → autoplay likely active, stopping");
    const sb = this.registry?.spinButton;
    try {
      if (sb && Number.isFinite(sb.x) && Number.isFinite(sb.y)) {
        await page.mouse.click(sb.x, sb.y);
      } else {
        const vp = page.viewportSize() ?? { width: 1280, height: 720 };
        await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
      }
      await page.waitForTimeout(2500);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const r = await dismissPopupsLoop(page, { maxAttempts: 3 });
      if (r.attempts > 0) console.log(`[manual/autoplay-stop] post-stop popup dismiss: ok=${r.ok} attempts=${r.attempts}`);
    } catch {}
    // Verify autoplay actually stopped — if spins still firing, log loudly so
    // QA can intervene manually (don't loop here; the manual session can
    // continue once QA stops it via UI).
    let stillSpinning = false;
    const verifyHandler = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url()) && res.request().method() === "POST") {
        stillSpinning = true;
      }
    };
    page.on("response", verifyHandler);
    try {
      await page.waitForTimeout(2000);
    } finally {
      page.off("response", verifyHandler);
    }
    if (stillSpinning) {
      console.warn("[manual/autoplay-stop] autoplay still firing after stop attempt — QA intervention required");
    } else {
      console.log("[manual/autoplay-stop] autoplay successfully stopped");
    }
    return { wasActive: true };
  }

  /**
   * Aggressive state recovery — used between sub-state probes when the agent
   * verify click may have triggered a side-effect that persists past a single
   * dismissPopupsLoop call (autoplay loop, free-spin chain, nested popup
   * cascade). Loops until the game is verifiably back on the main play
   * screen OR maxWaitMs elapses.
   *
   * Steps per iteration:
   *   1. stopAutoplayIfActive — clicks the spin button (= STOP during
   *      autoplay) if spontaneous gameService POSTs are observed.
   *   2. dismissPopupsLoop — ESC + corner-click to close any popup.
   *   3. Re-check via OCR + overlay. If popup gone AND not a FS chain →
   *      return. If FS chain detected, wait 5s + retry (chains play out
   *      autonomously, can only be waited out).
   *
   * The 15-min default cap accommodates worst-case 100-spin autoplay or a
   * deep free-spin chain. Most recoveries finish in 5-30s.
   */
  /**
   * Registry-aware popup close: when a substate modal (buy-feature / autoplay /
   * paytable / settings) survives the generic ESC+corner dismiss, look up its
   * parent's explicit close affordance in the registry and click it. SAFETY:
   * only ever clicks a CANCEL / NO / CLOSE / EXIT control — NEVER confirm / yes
   * / buy (which would spend a real bet or purchase the feature). Maps the
   * detected OCR keywords → likely parent trigger, then resolves `<parent>__
   * <closeKey>` from the registry. Returns the key clicked, or null when no
   * safe close affordance is registered.
   */
  private async tryRegistryCloseSubstate(matchedKeywords: string[]): Promise<string | null> {
    if (!this.session || !this.registry) return null;
    const kw = matchedKeywords.map((k) => k.toLowerCase());
    const has = (...needles: string[]): boolean => needles.some((n) => kw.some((k) => k.includes(n)));

    // Keyword → candidate parent trigger key(s), most-specific first.
    const parents: string[] = [];
    if (has("buy", "purchase")) parents.push("buyBonusButton", "buyFeatureButton", "buyButton");
    if (has("number of spins", "loss limit", "autoplay", "auto play")) parents.push("autoButton");
    if (has("paytable", "pay table")) parents.push("paytableButton");
    if (has("history")) parents.push("historyButton", "menuButton");
    if (has("setting")) parents.push("settingsButton", "menuButton");
    if (has("menu")) parents.push("menuButton");
    if (parents.length === 0) return null;

    // SAFE close affordances, in priority order: cancel/no DECLINE the action,
    // close/exit just DISMISS. NEVER confirm/yes/buy (commits the purchase/spin).
    const CLOSE_SUFFIXES = ["__cancelButton", "__noButton", "__closeButton", "__exitButton", "__closePaytableButton"];
    const reg = this.registry as Record<string, UiElement | undefined>;
    for (const parent of parents) {
      for (const suf of CLOSE_SUFFIXES) {
        const key = `${parent}${suf}`;
        const el = reg[key];
        if (el && typeof el.x === "number" && typeof el.y === "number") {
          try {
            await this.session.page.mouse.click(el.x, el.y);
            await this.session.page.waitForTimeout(800);
            return key;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * AI-assisted close: when the deterministic registry lookup can't decide which
   * control closes the stuck popup, send the CURRENT screenshot + the registry's
   * SAFE close controls (cancel / close / exit — coords included) to the AI and
   * let it pick the exact one matching the visible popup. SAFETY: the candidate
   * set sent to the AI is pre-filtered to close-type controls only (confirm /
   * yes / buy / spin / start are never candidates), and the AI's choice is
   * re-validated against that set before clicking — so the AI can NEVER cause a
   * purchase/spin even if it mis-picks. Returns the clicked key, or null.
   */
  private async aiPickCloseFromRegistry(matchedKeywords: string[]): Promise<string | null> {
    if (!this.session || !this.registry) return null;
    const reg = this.registry as Record<string, UiElement | undefined>;
    // SAFE close candidates only — never confirm/yes/buy/spin/start/gamble.
    const SAFE = /(cancel|close|exit|dismiss|closePaytable)Button$/i;
    const UNSAFE = /(confirm|yes|buy|purchase|spin|start|gamble|double|collect|ok)/i;
    const candidates = Object.entries(reg)
      .filter(([k, el]) => el && typeof el.x === "number" && typeof el.y === "number" && SAFE.test(k) && !UNSAFE.test(k))
      .map(([k, el]) => ({ key: k, x: el!.x, y: el!.y }));
    if (candidates.length === 0) return null;

    let pngBuf: Buffer;
    try {
      pngBuf = await this.session.page.screenshot({ type: "png" });
    } catch {
      return null;
    }
    const list = candidates.map((c) => `- ${c.key} @ (${c.x},${c.y})`).join("\n");
    const { askClaude, extractJsonFromText } = await import("../../ai/claude.js");
    let raw: string;
    try {
      raw = await askClaude({
        label: "force-recover/close-picker",
        system:
          "You help dismiss a stuck modal popup in a slot game so the main screen returns. " +
          "You are given a screenshot and a list of REGISTERED close-type controls (cancel/close/exit) with coords. " +
          "Pick the ONE control that closes the popup currently visible in the screenshot. " +
          "Return STRICT JSON only: {\"key\": \"<one of the listed keys>\" | null, \"reason\": \"<short>\"}. " +
          "Rules: only return a key from the provided list, or null if NONE of them closes the visible popup. " +
          "NEVER invent coords. These are all safe dismiss controls — none confirm a purchase.",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngBuf.toString("base64") } },
          { type: "text", text: `Stuck popup keywords: [${matchedKeywords.join(", ")}].\nRegistered close-type controls:\n${list}\n\nWhich key closes the popup in the screenshot? JSON only.` },
        ],
        maxTurns: 1,
        timeoutMs: 60_000,
      });
    } catch (err) {
      console.warn(`[force-recover] AI close-picker failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const parsed = extractJsonFromText<{ key?: string | null; reason?: string }>(raw);
    const picked = parsed?.key ?? null;
    if (!picked) return null;
    // Re-validate: the AI's choice MUST be one of the safe candidates we sent.
    const match = candidates.find((c) => c.key === picked);
    if (!match) {
      console.warn(`[force-recover] AI picked "${picked}" which is NOT a safe candidate — ignoring`);
      return null;
    }
    try {
      await this.session.page.mouse.click(match.x, match.y);
      await this.session.page.waitForTimeout(800);
      return match.key;
    } catch {
      return null;
    }
  }

  private async forceRecoverToMain(opts: { maxWaitMs?: number } = {}): Promise<{ onMain: boolean; reason?: string; elapsedMs: number }> {
    if (!this.session) return { onMain: false, reason: "no session", elapsedMs: 0 };
    const page = this.session.page;
    const maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
    const start = Date.now();
    let attempt = 0;
    // Stuck-popup detection (2026-06-01 — observed substate popups like the
    // autoplay settings panel survive dismissPopupsLoop's ESC+corner-click
    // strategy because they require explicit close-X clicks at game-specific
    // coords. detectAnyPopup sees them via substate keywords; dismissPopupsLoop
    // doesn't. Without an exit, the loop spins for the full maxWaitMs (15 min
    // by default) printing "ocr/popup-detect: hasPopup=false" lines forever).
    // If the SAME popup signature appears 3 iterations in a row AND it's not a
    // free-spin chain (chains naturally complete in time), bail out with
    // "stuck-substate" — caller logs and moves on. The loss is acceptable: a
    // single sub-state probe failing to recover its parent popup state means
    // its downstream candidates skip, but the rest of the registry still
    // progresses.
    let prevSignature = "";
    let unchangedCount = 0;
    // Signatures we've already tried to close via the registry close affordance
    // (one attempt per distinct popup signature — don't spam clicks).
    const triedRegistryClose = new Set<string>();
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      // Phase 0: close any extra browser tabs the verify-click agent may have
      // opened (e.g. gameHistoryButton opens a new tab — without this, all
      // downstream probes see the history tab as the active page and reject
      // their parent-state context).
      try {
        const ctx = page.context();
        const pages = ctx.pages();
        if (pages.length > 1) {
          for (const p of pages) {
            if (p !== page) {
              try { await p.close(); } catch {}
            }
          }
          await page.bringToFront();
          console.log(`[force-recover] attempt ${attempt}: closed ${pages.length - 1} extra tab(s), restored game tab`);
        }
      } catch {}

      // Phase 1: stop autoplay if active.
      try {
        const a = await this.stopAutoplayIfActive();
        if (a.wasActive) {
          console.log(`[force-recover] attempt ${attempt}: autoplay stopped`);
        }
      } catch {}

      // Phase 2: dismiss popups.
      try {
        await dismissPopupsLoop(page, { maxAttempts: 3 });
      } catch {}

      // Phase 2.5: dismiss FREE SPINS COMPLETED result banner via Space/Enter.
      // OCR's suppressResultBannerMatches correctly classifies the COMPLETED
      // overlay as "on-main" (not a popup), so dismissPopupsLoop skips it.
      // But the overlay VISUALLY blocks canvas clicks — every subsequent
      // probe sees the COMPLETED banner instead of the expected popup
      // state. PP slot games typically dismiss it via Space/Enter without
      // triggering a spin (canvas-click would spin instead). Press once
      // per recovery attempt; harmless when banner is absent.
      try {
        const { ON_MAIN_RESULT_PHRASES } = await import("../utils/ocr-popup.js");
        const probe = await detectAnyPopup(page, { substateKeywords: [] });
        if (ON_MAIN_RESULT_PHRASES.some((p) => probe.detectedText.includes(p))) {
          console.log(`[force-recover] attempt ${attempt}: FS-completed banner detected — dismissing via Space/Enter`);
          await page.keyboard.press("Space");
          await page.waitForTimeout(800);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(800);
        }
      } catch {}

      // Phase 3: verify clean main state.
      let det: Awaited<ReturnType<typeof detectAnyPopup>>;
      try {
        det = await detectAnyPopup(page, { substateKeywords: SUBSTATE_POPUP_KEYWORDS });
      } catch {
        await page.waitForTimeout(2000);
        continue;
      }
      if (!det.hasPopup) {
        // No popup signals → clean main.
        console.log(`[force-recover] attempt ${attempt}: clean main reached in ${Date.now() - start}ms`);
        return { onMain: true, elapsedMs: Date.now() - start };
      }
      // Popup signals present. Is it a free-spin chain (uncloseable)?
      const isFs = isFreeSpinChainActive(det.matchedKeywords);
      if (isFs) {
        // Reset unchanged-count: FS chains DO progress (we're not stuck, just
        // waiting for the chain to play out).
        unchangedCount = 0;
        prevSignature = "";
        console.log(`[force-recover] attempt ${attempt}: free-spin chain active (matched=[${det.matchedKeywords.join(",")}]) — waiting`);
        await page.waitForTimeout(5000);
        continue;
      }
      // Non-FS popup: check whether we're making progress (signature changes
      // each iteration) or stuck (same signature repeating).
      const signature = [...det.matchedKeywords].sort().join(",");
      // Registry-aware close: a substate modal (buy-feature / autoplay /
      // paytable / settings) won't yield to ESC+corner. Look up its parent's
      // explicit CANCEL/CLOSE control in the registry and click it — ONCE per
      // signature. Never clicks confirm/buy (see tryRegistryCloseSubstate).
      if (!triedRegistryClose.has(signature)) {
        triedRegistryClose.add(signature);
        // 1) Deterministic: keyword → parent → cancel/close (free, instant).
        let closedKey = await this.tryRegistryCloseSubstate(det.matchedKeywords);
        // 2) AI fallback: send screenshot + the registry's safe close controls
        //    and let the AI pick the exact one for the visible popup. Only runs
        //    when the deterministic guess found nothing.
        if (!closedKey) {
          closedKey = await this.aiPickCloseFromRegistry(det.matchedKeywords);
          if (closedKey) console.log(`[force-recover] attempt ${attempt}: AI picked close control ${closedKey} for popup [${signature}]`);
        }
        if (closedKey) {
          console.log(`[force-recover] attempt ${attempt}: clicked close affordance ${closedKey} for popup [${signature}] — re-checking main`);
          await page.waitForTimeout(800);
          continue; // re-loop → Phase 3 re-detects; popup likely gone
        }
      }
      if (signature === prevSignature) {
        unchangedCount++;
        if (unchangedCount >= 6) {
          console.warn(`[force-recover] STUCK on substate popup [${signature}] for ${unchangedCount} consecutive attempts — bailing out (ESC + corner-click can't dismiss this popup; needs an explicit close-X click QA must wire up)`);
          return {
            onMain: false,
            reason: `stuck on popup [${signature}] — dismissPopupsLoop cannot close it (substate popup needs game-specific close affordance)`,
            elapsedMs: Date.now() - start,
          };
        }
      } else {
        unchangedCount = 1;
        prevSignature = signature;
      }
      await page.waitForTimeout(1500);
    }
    return { onMain: false, reason: `timeout after ${Math.round((Date.now() - start) / 1000)}s`, elapsedMs: Date.now() - start };
  }

  private async recoverToMain(): Promise<void> {
    if (!this.session) return;
    const page = this.session.page;
    try {
      const r = await dismissPopupsLoop(page, { maxAttempts: 2 });
      if (r.attempts > 0) console.log(`[recover-main] ocr-dismiss ok=${r.ok} attempts=${r.attempts}`);
    } catch (err) {
      console.warn(`[recover-main] ocr-dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.mouse.click(5, 5);
      await page.waitForTimeout(1500);
    } catch (err) {
      console.warn(`[recover-main] esc+corner failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** AI-vision recovery tier: when keyword + Escape + corner-tap can't clear a
   *  blocker (e.g. a Playtech feature-promo splash whose only dismiss control is
   *  a centered ▶ play button, or a "DON'T SHOW NEXT TIME" dialog), screenshot
   *  the page and let `decidePreGameDismissal` locate the exact dismiss/continue
   *  control, then click it. Loops up to `maxClicks` until the model reports the
   *  play screen is ready. Returns how many real clicks it issued. */
  /** AI-vision readiness classifier — screenshots the page and asks whether it
   *  is genuinely the play screen (reels + spin + balance + bet, no blocking
   *  overlay). Used to disambiguate the "dark overlay persists but OCR is clean"
   *  case: a real game UI with dark corners (decoration) vs an unreadable promo
   *  splash. Returns true/false, or null when the AI call fails. */
  private async aiIsPlayScreenReady(): Promise<boolean | null> {
    if (!this.session) return null;
    const page = this.session.page;
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      const { decidePreGameDismissal } = await import("../../ai/vision.js");
      const os = await import("node:os");
      const pathMod = await import("node:path");
      const { writeFile } = await import("node:fs/promises");
      const buf = await page.screenshot({ type: "png" });
      const shotPath = pathMod.join(os.tmpdir(), `qa-ai-ready-${process.pid}.png`);
      await writeFile(shotPath, buf);
      const d = await decidePreGameDismissal({ screenshotPath: shotPath, viewport: vp, iteration: 1, dismissedSoFar: 0 });
      console.log(`[ensure-main/ai-classify] play_screen_ready=${d.play_screen_ready} blocker=${d.blocker_type} elements=[${(d.visible_elements ?? []).join(",")}]`);
      return d.play_screen_ready === true;
    } catch (err) {
      console.warn(`[ensure-main/ai-classify] failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async aiDismissToMain(maxClicks = 4): Promise<{ clicked: number; ready: boolean }> {
    if (!this.session) return { clicked: 0, ready: false };
    const page = this.session.page;
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const { decidePreGameDismissal } = await import("../../ai/vision.js");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const { writeFile } = await import("node:fs/promises");
    let clicked = 0;
    for (let i = 0; i < maxClicks; i++) {
      let shotPath: string;
      try {
        const buf = await page.screenshot({ type: "png" });
        shotPath = pathMod.join(os.tmpdir(), `qa-ai-dismiss-${process.pid}-${i}.png`);
        await writeFile(shotPath, buf);
      } catch (err) {
        console.warn(`[recover-main/ai] screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      let decision;
      try {
        decision = await decidePreGameDismissal({ screenshotPath: shotPath, viewport: vp, iteration: i + 1, dismissedSoFar: clicked });
      } catch (err) {
        console.warn(`[recover-main/ai] vision call failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      console.log(`[recover-main/ai] iter ${i + 1}: action=${decision.action} blocker=${decision.blocker_type} ready=${decision.play_screen_ready} conf=${decision.confidence?.toFixed?.(2) ?? "?"} (${decision.reason ?? ""})`);
      if (decision.play_screen_ready) return { clicked, ready: true };
      if (decision.action === "done") break;
      if (decision.action === "wait") { await page.waitForTimeout(1500); continue; }
      if (decision.action === "click" && (decision.confidence ?? 0) >= 0.5 && decision.x > 0 && decision.y > 0) {
        await page.mouse.click(decision.x, decision.y).catch(() => undefined);
        clicked++;
        await page.waitForTimeout(1200);
      } else {
        break; // low confidence / no actionable target
      }
    }
    return { clicked, ready: false };
  }

  /**
   * Behavioral probe — click the spinButton at its registered coord, listen
   * 3s for any /gameService response. If a spin response fires → confirmed
   * on the main play screen (game accepted the spin). If not → either we're
   * on a popup that swallowed the click, or the game is frozen.
   *
   * Side effect: consumes one real spin (deducts bet from balance, increments
   * roundId). Caller decides whether the cost is worth the confirmation.
   */
  private async behavioralProbe(): Promise<{ spinFired: boolean; durationMs: number }> {
    const start = Date.now();
    if (!this.session || !this.registry?.spinButton) {
      return { spinFired: false, durationMs: Date.now() - start };
    }
    const page = this.session.page;
    const sb = this.registry.spinButton;
    let fired = false;
    const onResponse = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url())) fired = true;
    };
    page.on("response", onResponse);
    try {
      await page.mouse.click(sb.x, sb.y);
      // Poll for up to 3s with 100ms granularity so we exit as soon as a spin
      // is observed (no need to wait the full 3s when game is responsive).
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !fired) {
        await page.waitForTimeout(100);
      }
    } finally {
      page.off("response", onResponse);
    }
    return { spinFired: fired, durationMs: Date.now() - start };
  }

  /**
   * Resume a previously-registered game — open browser at saved gameUrl,
   * load existing ui-registry.json (no AI discovery). QA can continue
   * verifying / refining without re-running expensive discovery.
   */
  async resume(gameSlug: string): Promise<SessionStatus> {
    if (this.session) throw new Error("Session already active — call stop() first");
    const m = await meta.load(gameSlug);
    if (!m) throw new Error(`No registry for ${gameSlug}`);
    const reg = await uiRegistry.load(gameSlug);
    if (!reg) throw new Error(`No ui-registry.json for ${gameSlug}`);

    // Rename legacy namespace keys (autoplay_popup__* → autoButton__*) so
    // AI translator + tree + executor all see consistent path-style names.
    const renames = migrateLegacyNamespaces(reg);
    const renamedCount = renames.filter((r) => !r.skipped).length;
    if (renamedCount > 0) {
      console.log(`[manual] migrated ${renamedCount} legacy namespace keys on resume: ${renames.filter((r) => !r.skipped).slice(0, 5).map((r) => `${r.old}→${r.new}`).join(", ")}`);
      await uiRegistry.save(gameSlug, reg);
    }

    // Headed by default; QA_HEADLESS=1 to run headless on resume.
    this.session = await openBrowser(process.env.QA_HEADLESS === "1");
    this.gameUrl = m.gameUrl;
    this.gameSlug = gameSlug;
    this.startedAt = new Date().toISOString();
    this.registry = reg;
    this.discoveryAutoAdded = [];
    this.expectedElementKeys = (await resolveExpectedUiElements(gameSlug)).map((e) => e.key);
    this.skippedMainKeys = await this.loadSkippedMainKeys(gameSlug);
    this.lastBalance = null;
    this.attachBalanceTracker();
    this.attachExternalTabTracker();
    this.attachWsCapture();
    // Restore verify state from persisted status field
    this.verifyState = {};
    for (const [k, el] of Object.entries(reg)) {
      if (!el) continue;
      this.verifyState[k] =
        el.status === "verified" ? "confirmed" :
        el.status === "rejected" ? "rejected" : "pending";
    }
    // Load QA's game-spec overrides so the next do_init capture applies
    // them automatically (or the dashboard shows them immediately even
    // before the first network response).
    this.gameSpecOverrideCached = await gameSpecOverride.load(gameSlug).catch(() => null);
    if (this.gameSpecOverrideCached) {
      const overrideKeys = Object.keys(this.gameSpecOverrideCached).filter((k) => k !== "note" && k !== "updatedAt");
      console.log(`[manual] loaded game-spec override on resume: [${overrideKeys.join(", ")}]`);
    }

    // Check for interrupted Auto-Onboard state on disk so the dashboard
    // can offer "Resume Auto-Onboard" instead of starting fresh. Also
    // restore the phases array so the panel renders prior progress.
    const prior = await this.loadOnboardState();
    if (prior) {
      this.autoOnboardPhases = prior.phases;
      this.autoOnboardCurrentPhase = null; // run was interrupted, no live phase
      this.autoOnboardStartedAt = prior.startedAt;
      this.autoOnboardResumeAvailable = true;
      const okCount = prior.phases.filter((p) => p.status === "ok" || p.status === "skip").length;
      console.log(`[manual] resumable Auto-Onboard state detected — ${okCount}/${prior.phases.length} phases were done`);
    }

    await crawl(this.session.page, { gameUrl: m.gameUrl, gameSlug });

    // OCR popup dismissal after resume (server-side state may still carry
    // celebration popup from previous session).
    try {
      await this.session.page.waitForTimeout(2000);
      const r = await dismissPopupsLoop(this.session.page);
      if (r.attempts > 0) console.log(`[manual/ocr] popup dismiss on resume: ok=${r.ok} attempts=${r.attempts} matched=${r.finalDetect.matchedKeywords.join(",")}`);
    } catch (err) {
      console.warn(`[manual/ocr] popup dismiss failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Same autoplay-leakage check as start() — server-side account state
    // commonly persists across browser sessions for slot platforms. Without
    // this, deep-discover sees autoplay-induced spin animations + the explorer
    // tries to interact with a moving target (observed 2026-05-30 on
    // vs20rnriches → explorer found `stop_autoplay_prompt` state instead of
    // autoplay's normal settings popup).
    try {
      const a = await this.stopAutoplayIfActive();
      if (a.wasActive) console.log(`[manual/autoplay-stop] stopped leaked autoplay on resume`);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] failed on resume (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.status();
  }

  /**
   * Load test cases + translated actions from disk for current game.
   * Returns one summary per case: id, name, category, severity, action count,
   * assertion count, and the actions themselves (for inspection). Used by
   * dashboard to render the Test Cases panel.
   */
  async listCases(slugOverride?: string): Promise<{ ok: boolean; cases?: Array<{
    id: string;
    name: string;
    category: string;
    severity: string;
    setupSummary: string;
    setupInstructions: string;
    actionCount: number;
    assertionCount: number;
    actions: unknown[];
    assertions: Array<{ id: string; description: string; check_code: string }>;
    skipReason?: string;
  }>; reason?: string }> {
    // Accept explicit slug so dashboard can list cases without active session
    // (read-only file lookups; Preview still requires active session).
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: `test-cases.json not found for ${slug} — run Generate Cases first` };
    const actionsCache = await loadActionsCache(slug);
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    const out = catalog.cases.map((c) => {
      const translated = actionsCache?.cases[c.id];
      const actions = translated?.actions && reg ? normalizeNestedUiActions(translated.actions, reg) : translated?.actions;
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        severity: c.severity,
        setupSummary: (c.setup_instructions ?? "").slice(0, 200),
        setupInstructions: c.setup_instructions ?? "",
        actionCount: actions?.length ?? 0,
        assertionCount: c.custom_assertions?.length ?? 0,
        actions: actions ?? [],
        assertions: (c.custom_assertions ?? []).map((a) => ({
          id: a.id,
          description: a.description,
          check_code: a.check_code,
        })),
        skipReason: translated?.skipReason,
      };
    });
    return { ok: true, cases: out };
  }

  /**
   * Re-translate a single case: call AI translator with current registry +
   * setup_instructions. Used when initial translation skipped (e.g. missing
   * uiKey at translate time, but QA has since added that element via Discover).
   * Updates test-cases.actions.json on disk and returns new translation.
   */
  /** Add a new test case to the catalog. Add-only flow paired with
   *  deleteCase — no in-place edit. Validates id uniqueness; sets
   *  reasonable defaults for omitted optional fields (severity=minor,
   *  spin_count=1, custom_assertions=[]). Catalog persisted to
   *  test-cases.json. After save the dashboard will need to translate
   *  the case (auto on next "Generate Cases" run or per-case "Re-translate"). */
  async addCase(
    payload: Partial<import("../../ai/test-catalog.js").TestCase> & {
      id: string;
      name: string;
      category: import("../../ai/test-catalog.js").TestCaseCategory;
    },
    slugOverride?: string,
  ): Promise<{ ok: boolean; reason?: string; caseId?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    if (!payload.id?.trim()) return { ok: false, reason: "id required" };
    if (!payload.name?.trim()) return { ok: false, reason: "name required" };
    if (!payload.category) return { ok: false, reason: "category required" };
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found — generate catalog first or run Auto-Onboard" };
    if (catalog.cases.some((c) => c.id === payload.id)) {
      return { ok: false, reason: `case id "${payload.id}" already exists — pick a different id or delete the existing one first` };
    }
    // Build a complete TestCase with sane defaults for unset fields.
    // The TestCase type requires a non-empty `description` and
    // `setup_instructions`; the catalog generator's downstream consumers
    // (action translator, executor) tolerate empty strings but fill
    // smarter defaults later.
    const newCase: import("../../ai/test-catalog.js").TestCase = {
      id: payload.id.trim(),
      name: payload.name.trim(),
      description: (payload.description ?? "").trim(),
      category: payload.category,
      severity: payload.severity ?? "minor",
      setup_instructions: (payload.setup_instructions ?? "").trim(),
      spin_count: typeof payload.spin_count === "number" ? payload.spin_count : 1,
      custom_assertions: payload.custom_assertions ?? [],
      ...(payload.expected_bet !== undefined ? { expected_bet: payload.expected_bet } : {}),
      ...(payload.expected_feature !== undefined ? { expected_feature: payload.expected_feature } : {}),
      ...(payload.allowed_interruptions !== undefined ? { allowed_interruptions: payload.allowed_interruptions } : {}),
      ...(payload.on_feature_triggered !== undefined ? { on_feature_triggered: payload.on_feature_triggered } : {}),
    };
    catalog.cases.push(newCase);
    await saveCatalog(slug, catalog);
    console.log(`[manual/case] ${slug}: ADDED case "${payload.id}" (category=${payload.category}, ${newCase.custom_assertions?.length ?? 0} assertions)`);
    return { ok: true, caseId: newCase.id };
  }

  /** Remove a test case from the catalog + clear its cached translated
   *  actions + persisted run results. Destructive but recoverable via
   *  git (test-cases.json is committed); cached actions/results just
   *  regenerate on next translate / run. */
  async deleteCase(caseId: string, slugOverride?: string): Promise<{ ok: boolean; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const before = catalog.cases.length;
    catalog.cases = catalog.cases.filter((c) => c.id !== caseId);
    if (catalog.cases.length === before) {
      return { ok: false, reason: `case "${caseId}" not in catalog` };
    }
    await saveCatalog(slug, catalog);
    // Also drop the translated-actions cache entry for this case so a
    // future Add of the same id doesn't inherit stale actions.
    try {
      const { loadCache: loadActionsCacheFn, saveCache: saveActionsCacheFn } = await import("../step7-testcase-gen/case-action-translator.js");
      const cache = await loadActionsCacheFn(slug);
      if (cache && cache.cases[caseId]) {
        delete cache.cases[caseId];
        await saveActionsCacheFn(slug, cache);
      }
    } catch { /* non-fatal */ }
    console.log(`[manual/case] ${slug}: DELETED case "${caseId}"`);
    return { ok: true };
  }

  /** Generate a full test case via Claude given QA's natural-language
   *  intent. Returns the proposed case (NOT saved) so the dashboard can
   *  preview before commit via addCase. Prompt includes registry uiKey
   *  summary + game spec + category enum so the AI references real
   *  controls and picks a valid category. */
  async generateCaseWithAi(args: {
    intent: string;
    slugOverride?: string;
  }): Promise<{
    ok: boolean;
    reason?: string;
    case?: import("../../ai/test-catalog.js").TestCase;
  }> {
    const slug = args.slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    if (!args.intent?.trim()) return { ok: false, reason: "intent required (describe the test case in plain language)" };
    const { loadRawCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found — generate base catalog first" };

    // Use current in-memory registry if active session for THIS slug,
    // else load from disk. Falls back gracefully when registry missing.
    const reg = (this.gameSlug === slug && this.registry)
      ? this.registry
      : (await uiRegistry.load(slug)) ?? {};
    const uiKeys = Object.keys(reg);
    const existingIds = catalog.cases.map((c) => c.id);
    const gs = this.gameSpec;
    const specBlock = gs
      ? `betLadder: [${gs.betLadder.join(", ")}]\ndefaultBet: ${gs.defaultBet}\nbetMin: ${gs.betMin}  betMax: ${gs.betMax}`
      : "(game spec unavailable — assume standard slot semantics)";

    const { askClaude, extractJsonFromText } = await import("../../ai/claude.js");
    const prompt = `Generate ONE complete TestCase for a slot-game QA suite.

QA INTENT (plain language):
"""
${args.intent.trim()}
"""

EXISTING CASE IDs (avoid duplicates): [${existingIds.join(", ")}]

REGISTRY UI KEYS (only these are clickable):
${uiKeys.length ? uiKeys.join(", ") : "(no registry — assume spinButton, betPlus, betMinus exist)"}

GAME SPEC:
${specBlock}

ALLOWED CATEGORIES: base_game | bet_variation | bet_level | bet_boundary | autoplay | buy_feature | special_bet | turbo_spin | free_spins | respin | history | options | max_win_cap | ui_consistency | rules_consistency | payout_correctness | wild_substitution | performance | meta | other

ALLOWED SEVERITY: critical | major | minor

SPIN OBJECT SCHEMA (for custom_assertions):
- id: string | betAmount: number | winAmount: number | startingBalance: number|null
- endingBalance: number | isFreeSpin: boolean | freeSpinsRemaining: number|null
- state: string | status: string

OUTPUT REQUIREMENTS (strict JSON only — no markdown fences):
{
  "id": "<kebab-case unique id>",
  "name": "<one-line display name>",
  "description": "<one-paragraph what this test verifies and why>",
  "category": "<one of the allowed categories above>",
  "severity": "<critical|major|minor>",
  "setup_instructions": "<plain-language steps before spin; e.g. 'Set bet to max via betPlus clicks, then click ANTE BET toggle once'>",
  "spin_count": <integer, usually 1-100>,
  "custom_assertions": [
    {
      "id": "<kebab-case>",
      "description": "<one-line English>",
      "check_code": "<single JS expression, === not ==, truthy on PASS>"
    }
  ]
}

RULES
- setup_instructions reference uiKeys from the REGISTRY block when possible.
- check_code is one JS expression (no statements/no return) — wrap multi-step logic in an IIFE.
- For free-spin assertions: filter via collector.spins.filter(s => s.isFreeSpin === true) FIRST.
- spin_count = 0 is valid for pure UI/setup tests; >0 for behavior tests.
- Pick the MOST SPECIFIC category — don't default to "other" unless nothing fits.`;

    let raw: string;
    try {
      raw = await askClaude({
        content: prompt,
        system: "You generate slot-game test cases. Output strict JSON only.",
        label: `case-gen/qa-driven`,
        maxTurns: 1,
      });
    } catch (err) {
      return { ok: false, reason: `AI generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = extractJsonFromText<Partial<import("../../ai/test-catalog.js").TestCase>>(raw);
    if (!parsed || !parsed.id || !parsed.name || !parsed.category) {
      return { ok: false, reason: `AI returned unparseable / incomplete output: ${raw.slice(0, 200)}` };
    }
    return {
      ok: true,
      case: {
        id: parsed.id.trim(),
        name: parsed.name.trim(),
        description: parsed.description?.trim() ?? "",
        category: parsed.category,
        severity: parsed.severity ?? "minor",
        setup_instructions: parsed.setup_instructions?.trim() ?? "",
        spin_count: typeof parsed.spin_count === "number" ? parsed.spin_count : 1,
        custom_assertions: parsed.custom_assertions ?? [],
        ...(parsed.expected_bet !== undefined ? { expected_bet: parsed.expected_bet } : {}),
        ...(parsed.expected_feature !== undefined ? { expected_feature: parsed.expected_feature } : {}),
      },
    };
  }

  /** Append a new custom assertion to a case. QA-driven add-only flow —
   *  the design choice is "add new + delete bad" instead of inline edit
   *  to avoid accidental breakage of working assertions. Returns the
   *  fresh catalog payload so the caller can refresh UI.
   *
   *  Validates:
   *    - case exists in catalog
   *    - assertion.id is non-empty + unique within the case
   *    - check_code is non-empty (parsing as JS is the runner's job;
   *      we trust QA / AI to have produced valid code) */
  async addCaseAssertion(
    caseId: string,
    assertion: { id: string; description: string; check_code: string },
    slugOverride?: string,
  ): Promise<{ ok: boolean; reason?: string; assertions?: NonNullable<import("../../ai/test-catalog.js").TestCase["custom_assertions"]> }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    if (!assertion.id?.trim()) return { ok: false, reason: "assertion.id required" };
    if (!assertion.check_code?.trim()) return { ok: false, reason: "assertion.check_code required" };
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found — generate catalog first" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const existing = tc.custom_assertions ?? [];
    if (existing.some((a) => a.id === assertion.id)) {
      return { ok: false, reason: `assertion id "${assertion.id}" already exists on this case — delete it first or use a different id` };
    }
    const next = [...existing, {
      id: assertion.id.trim(),
      description: (assertion.description ?? "").trim(),
      check_code: assertion.check_code.trim(),
    }];
    tc.custom_assertions = next;
    await saveCatalog(slug, catalog);
    console.log(`[manual/assertion] ${slug}/${caseId}: ADDED assertion "${assertion.id}" (now ${next.length} total)`);
    return { ok: true, assertions: next };
  }

  /** Remove a custom assertion from a case by id. Returns the resulting
   *  list so caller can refresh UI. */
  async deleteCaseAssertion(
    caseId: string,
    assertionId: string,
    slugOverride?: string,
  ): Promise<{ ok: boolean; reason?: string; assertions?: NonNullable<import("../../ai/test-catalog.js").TestCase["custom_assertions"]> }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const existing = tc.custom_assertions ?? [];
    const next = existing.filter((a) => a.id !== assertionId);
    if (next.length === existing.length) {
      return { ok: false, reason: `assertion "${assertionId}" not found on case ${caseId}` };
    }
    tc.custom_assertions = next;
    await saveCatalog(slug, catalog);
    console.log(`[manual/assertion] ${slug}/${caseId}: DELETED assertion "${assertionId}" (now ${next.length} total)`);
    return { ok: true, assertions: next };
  }

  /** Generate a new assertion via Claude given QA's natural-language
   *  intent. Returns the proposed assertion WITHOUT saving — caller
   *  decides whether to call addCaseAssertion next. Builds a minimal
   *  prompt with the spin-object schema + case context so the AI
   *  produces a syntactically valid check_code referencing real fields. */
  async generateAssertionWithAi(args: {
    caseId: string;
    intent: string;
    slugOverride?: string;
  }): Promise<{
    ok: boolean;
    reason?: string;
    assertion?: { id: string; description: string; check_code: string };
  }> {
    const slug = args.slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    if (!args.intent?.trim()) return { ok: false, reason: "intent required (describe the assertion in plain language)" };
    const { loadRawCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === args.caseId);
    if (!tc) return { ok: false, reason: `case ${args.caseId} not in catalog` };

    const { askClaude, extractJsonFromText } = await import("../../ai/claude.js");
    const existingIds = (tc.custom_assertions ?? []).map((a) => a.id);
    const prompt = `Generate ONE custom assertion for a slot-game test case.

CASE CONTEXT
- id: ${tc.id}
- name: ${tc.name}
- category: ${tc.category}
- description: ${tc.description ?? "(none)"}
- setup_instructions: ${tc.setup_instructions ?? "(none)"}
- spin_count: ${tc.spin_count}
- existing assertion ids (avoid duplicates): [${existingIds.join(", ")}]

QA INTENT (what the assertion must check, in plain language):
"""
${args.intent.trim()}
"""

SPIN OBJECT SCHEMA — each entry in collector.spins has these fields:
- id: string (round id)
- betAmount: number (player wager, 0 for free spins)
- winAmount: number (total payout, ≥ 0)
- startingBalance: number | null
- endingBalance: number
- isFreeSpin: boolean
- freeSpinsRemaining: number | null
- state: string ("NORMAL" | "FREE_SPIN" | "BONUS" | ...)
- status: string ("RESOLVED" | "PENDING" | ...)
- timestamp: number (ms epoch)

Also available in scope: \`warnings\` (string[]).

OUTPUT REQUIREMENTS (strict JSON, no markdown fences):
{
  "id": "<kebab-case slug, unique within case>",
  "description": "<one-line English description>",
  "check_code": "<single JS expression that evaluates truthy when assertion PASSES>"
}

CHECK_CODE RULES
- Single expression (no statements, no \`return\`, no semicolons). For multi-step logic use IIFE: (() => { ... return X })()
- Use === not == ; handle null/undefined explicitly.
- For FS-specific assertions, filter first: collector.spins.filter(s => s.isFreeSpin === true).every(s => ...)
- Reference only fields listed in the schema above. Don't invent fields.`;

    let raw: string;
    try {
      raw = await askClaude({
        content: prompt,
        system: "You generate custom assertions for slot-game test cases. Output strict JSON only.",
        label: `assertion-gen/${args.caseId.slice(0, 30)}`,
        maxTurns: 1,
      });
    } catch (err) {
      return { ok: false, reason: `AI generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = extractJsonFromText<{ id?: string; description?: string; check_code?: string }>(raw);
    if (!parsed || !parsed.id || !parsed.check_code) {
      return { ok: false, reason: `AI returned unparseable output: ${raw.slice(0, 200)}` };
    }
    return {
      ok: true,
      assertion: {
        id: parsed.id.trim(),
        description: (parsed.description ?? "").trim(),
        check_code: parsed.check_code.trim(),
      },
    };
  }

  /** Delete a game's RUN EVIDENCE from disk: case-evidence/ (videos,
   *  screenshots, OCR crops, network logs, persisted results) + case-history/
   *  (run history feeding the flaky-score badges). LEARNED KNOWLEDGE is
   *  untouched (registry, test-cases, payout-model, parser-overlay, …) —
   *  evidence is regenerated by simply re-running cases. Works without an
   *  active browser session (pure disk op). Returns freed bytes. */
  async clearCaseEvidence(slugOverride?: string): Promise<{ ok: boolean; freedBytes?: number; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const { rm, readdir, stat } = await import("node:fs/promises");
    const targets = [
      path.join(dirForGame(slug), "case-evidence"),
      path.join(dirForGame(slug), "case-history"),
    ];
    const dirSize = async (dir: string): Promise<number> => {
      let total = 0;
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) total += await dirSize(p);
          else total += (await stat(p).catch(() => null))?.size ?? 0;
        }
      } catch { /* dir absent */ }
      return total;
    };
    let freedBytes = 0;
    for (const t of targets) {
      freedBytes += await dirSize(t);
      await rm(t, { recursive: true, force: true }).catch(() => {});
    }
    console.log(`[manual/clear-evidence] ${slug}: removed case-evidence + case-history (${(freedBytes / 1024 / 1024).toFixed(1)} MB freed)`);
    return { ok: true, freedBytes };
  }

  /** Re-sync ONE case's persisted assertions with the current template
   *  library (template fixes don't reach already-generated catalogs — see
   *  resyncAssertionsWithTemplates). No AI call; saves test-cases.json only
   *  when something actually changed. */
  async resyncCaseAssertions(caseId: string, slugOverride?: string): Promise<{
    ok: boolean;
    updated?: Array<{ id: string; templateId: string }>;
    ambiguous?: Array<{ id: string; templateIds: string[] }>;
    reason?: string;
  }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    if (!tc.custom_assertions || tc.custom_assertions.length === 0) {
      return { ok: true, updated: [], ambiguous: [] };
    }
    const { resyncAssertionsWithTemplates } = await import("../../ai/assertion-templates.js");
    const r = resyncAssertionsWithTemplates(tc.custom_assertions);
    if (r.updated.length > 0) {
      tc.custom_assertions = r.assertions;
      await saveCatalog(slug, catalog);
      console.log(`[manual/case] ${slug}/${caseId}: re-synced ${r.updated.length} assertion(s) from templates: ${r.updated.map((u) => `${u.id}←${u.templateId}`).join(", ")}`);
    }
    if (r.ambiguous.length > 0) {
      console.warn(`[manual/case] ${slug}/${caseId}: ${r.ambiguous.length} assertion(s) matched multiple templates — skipped: ${r.ambiguous.map((a) => a.id).join(", ")}`);
    }
    return { ok: true, updated: r.updated, ambiguous: r.ambiguous };
  }

  /**
   * Revise ONE case's custom_assertions per the admin OC-level assertion note
   * (AI). No-op (no AI cost) when the OC has no assertion note for this case.
   * Persists to test-cases.json via the RAW catalog (never writes built-ins).
   * Returns whether the list changed so callers can log/refresh.
   */
  async reviseCaseAssertions(caseId: string, slug: string, ocOverride?: string): Promise<{
    ok: boolean;
    changed?: boolean;
    aiCalled?: boolean;
    error?: string;
    reason?: string;
    /** The resulting assertion list (revised or unchanged) — callers with a
     *  stale in-memory catalog use this to keep the translate context in sync. */
    assertions?: Array<{ id: string; description: string; check_code: string }>;
  }> {
    const { deriveOcKey, resolveAssertionNote } = await import("../registry/oc-prompt-notes.js");
    let oc = ocOverride;
    if (oc === undefined) {
      const m = await meta.load(slug).catch(() => null);
      oc = deriveOcKey(m?.gameUrl);
    }
    const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
    const catalog = await loadRawCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };

    const currentAssertions = (tc.custom_assertions ?? []).map((a) => ({ id: a.id, description: a.description, check_code: a.check_code }));
    const note = await resolveAssertionNote(oc, tc.category, tc.id);
    if (!note) return { ok: true, changed: false, aiCalled: false, assertions: currentAssertions };

    const gs = this.gameSpec;
    const gameSpecBlock = gs
      ? `betLadder: [${gs.betLadder.join(", ")}]\ndefaultBet: ${gs.defaultBet}  betMin: ${gs.betMin}  betMax: ${gs.betMax}`
      : undefined;

    const { reviseAssertionsWithNote } = await import("../step7-testcase-gen/assertion-note-reviser.js");
    const res = await reviseAssertionsWithNote({
      caseId: tc.id,
      caseName: tc.name,
      category: tc.category,
      note,
      currentAssertions,
      gameSpecBlock,
    });
    if (res.error) {
      console.warn(`[manual/case] ${slug}/${caseId}: assertion revise skipped — ${res.error}`);
      return { ok: true, changed: false, aiCalled: res.aiCalled, error: res.error, assertions: currentAssertions };
    }
    // Only persist when the list actually differs.
    const before = JSON.stringify(currentAssertions);
    const after = JSON.stringify(res.assertions);
    if (before === after) return { ok: true, changed: false, aiCalled: res.aiCalled, assertions: res.assertions };
    tc.custom_assertions = res.assertions;
    await saveCatalog(slug, catalog);
    console.log(`[manual/case] ${slug}/${caseId}: revised ${res.assertions.length} assertion(s) from admin note`);
    return { ok: true, changed: true, aiCalled: res.aiCalled, assertions: res.assertions };
  }

  async retranslateCase(caseId: string, slugOverride?: string): Promise<{ ok: boolean; actions?: unknown[]; skipReason?: string; reason?: string; aiCalled?: boolean; resynced?: number; assertionsRevised?: boolean }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    // Re-translate = bring the WHOLE case up to current system knowledge:
    // 1) re-sync template-derived assertions with the current template
    //    library (free, persisted to test-cases.json), THEN
    // 2) re-translate setup → actions (AI call) — the translator sees the
    //    UPDATED assertions as context.
    const sync = await this.resyncCaseAssertions(caseId, slug);
    const resynced = sync.ok ? (sync.updated?.length ?? 0) : 0;

    // Resolve admin OC-level notes for this case (empty when none).
    const { deriveOcKey, resolveTranslateNote } = await import("../registry/oc-prompt-notes.js");
    const m = await meta.load(slug).catch(() => null);
    const oc = deriveOcKey(m?.gameUrl);

    // Revise assertions per the admin assertion-note (AI, persisted) BEFORE we
    // load the catalog case for translation, so the translator sees the updated
    // assertions and actions/assertions stay consistent.
    const revise = await this.reviseCaseAssertions(caseId, slug, oc);
    const assertionsRevised = revise.ok ? !!revise.changed : false;

    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };

    // Use current in-memory registry if active session for THIS slug, else load from disk.
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available" };

    const promptNote = await resolveTranslateNote(oc, tc.category, tc.id);

    const translated = await translateCase({
      caseId: tc.id,
      caseName: tc.name,
      category: tc.category,
      setup: tc.setup_instructions ?? "",
      uiMap: reg,
      gameSpec: this.gameSpec ? {
        betLadder: this.gameSpec.betLadder,
        defaultBet: this.gameSpec.defaultBet,
        betMin: this.gameSpec.betMin,
        betMax: this.gameSpec.betMax,
      } : undefined,
      expectedBet: tc.expected_bet,
      spinCount: tc.spin_count,
      customAssertions: tc.custom_assertions,
      promptNote,
    });

    // Persist updated cache — strip aiCalled (in-call signal, not part of cache schema)
    const { aiCalled, ...persistable } = translated;
    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };
    cache.cases[caseId] = persistable;
    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);

    return { ok: true, actions: translated.actions, skipReason: translated.skipReason, aiCalled, resynced, assertionsRevised };
  }

  /**
   * #6 — Apply the reusable standard test-case template set to this game and
   * rebind setup→actions against the game's registry. Lets a tester copy a
   * base set of cases onto any game from the dashboard instead of AI-generating
   * per game. merge (default) keeps existing AI/manual cases; replace swaps the
   * catalog's cases for the template set.
   */
  async applyTemplates(
    slugOverride?: string,
    mode: "merge" | "replace" = "merge",
  ): Promise<{ ok: boolean; applied?: string[]; skipped?: Array<{ id: string; reason: string }>; bound?: number; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const { applyTemplateSet } = await import("../step7-testcase-gen/case-templates.js");
    const result = await applyTemplateSet(slug, { mode });

    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) {
      return {
        ok: true,
        applied: result.applied.map((c) => c.id),
        skipped: result.skipped,
        bound: 0,
        reason: "cases written but no registry — run discovery, then retranslate to bind actions",
      };
    }
    const { translateAllCases } = await import("../step7-testcase-gen/case-action-translator.js");
    const cache = await translateAllCases(slug, result.applied, reg);
    const bound = result.applied.filter((c) => cache.cases[c.id] && !cache.cases[c.id]!.skipReason).length;
    return { ok: true, applied: result.applied.map((c) => c.id), skipped: result.skipped, bound };
  }

  /**
   * Return the cached translated actions for a case so the dashboard editor
   * can render them. Returns null actions when the case isn't in the cache
   * yet (translation never ran or was reset). Caller decides UX.
   */
  async getCaseActions(caseId: string, slugOverride?: string): Promise<{
    ok: boolean;
    caseId: string;
    actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[] | null;
    skipReason?: string;
    /** All uiKeys currently in the game's registry (so editor can validate
     *  click.uiKey + offer autocomplete). */
    availableUiKeys: string[];
    reason?: string;
  }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, caseId, actions: null, availableUiKeys: [], reason: "no active session or override" };
    const cache = await loadActionsCache(slug);
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    const availableUiKeys = reg ? Object.keys(reg) : [];
    if (!cache || !cache.cases[caseId]) {
      return { ok: true, caseId, actions: null, availableUiKeys, reason: "case not in actions cache (run translate first)" };
    }
    const entry = cache.cases[caseId];
    const actions = reg ? normalizeNestedUiActions(entry.actions, reg) : entry.actions;
    return {
      ok: true,
      caseId,
      actions,
      skipReason: entry.skipReason,
      availableUiKeys,
    };
  }

  /**
   * Persist QA-edited actions for a case. Validates that each click action's
   * uiKey exists in the current registry; rejects the save if any is missing
   * (so we don't corrupt the cache with broken references). Bypasses AI —
   * QA's edit is final.
   */
  async saveCaseActions(
    caseId: string,
    actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[],
    slugOverride?: string,
  ): Promise<{ ok: boolean; reason?: string; invalidUiKeys?: string[] }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available — can't validate uiKeys" };

    // Validate shape + uiKey references.
    if (!Array.isArray(actions)) return { ok: false, reason: "actions must be an array" };
    const invalidUiKeys: string[] = [];
    for (const a of actions) {
      if (!a || typeof a !== "object" || typeof (a as { kind: unknown }).kind !== "string") {
        return { ok: false, reason: "each action must be an object with a 'kind' field" };
      }
      if ((a as { kind: string }).kind === "click" || (a as { kind: string }).kind === "hold") {
        const uiKey = (a as { uiKey?: unknown }).uiKey;
        if (typeof uiKey !== "string" || uiKey.length === 0) {
          return { ok: false, reason: `${(a as { kind: string }).kind} action requires a non-empty uiKey` };
        }
        if (!reg[uiKey]) invalidUiKeys.push(uiKey);
      }
      if ((a as { kind: string }).kind === "wait_ms") {
        const ms = (a as { ms?: unknown }).ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          return { ok: false, reason: "wait_ms requires a non-negative number 'ms'" };
        }
      }
    }
    if (invalidUiKeys.length > 0) {
      return {
        ok: false,
        reason: `uiKey(s) missing from registry: ${invalidUiKeys.join(", ")}`,
        invalidUiKeys,
      };
    }

    // Load + update cache. Bypass AI; this is a human edit.
    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };
    cache.cases[caseId] = { caseId, actions };
    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);
    console.log(`[manual/save-actions] ${caseId}: ${actions.length} action(s) saved by QA edit`);
    return { ok: true };
  }

  /** Execute ONE translated action against the live browser so QA can verify
   *  action behavior without running the whole testcase. Mirrors the
   *  dashboard's element-level [Test] button, but routes through the case
   *  action runtime (set_bet_to_value, dropdown bet selection, waits, etc.).
   *  This is intentionally stateful: the action may change bet, open/close
   *  popups, start autoplay, or spin if the selected action is a spin. */
  async previewCaseAction(args: {
    caseId: string;
    actionIndex?: number;
    action?: import("../step7-testcase-gen/case-action-translator.js").CaseAction;
    ensureMain?: boolean;
  }): Promise<{
    ok: boolean;
    caseId: string;
    actionIndex?: number;
    action?: unknown;
    durationMs?: number;
    reason?: string;
  }> {
    if (!this.session || !this.gameSlug || !this.registry) {
      return { ok: false, caseId: args.caseId, reason: "no active session" };
    }
    if (this.previewCaseInProgress) {
      return { ok: false, caseId: args.caseId, reason: "another case/action preview is already running on this session — please wait" };
    }
    const actionsCache = await loadActionsCache(this.gameSlug);
    const translated = actionsCache?.cases[args.caseId];
    if (!translated && !args.action) {
      return { ok: false, caseId: args.caseId, reason: "no translated actions for this case — run translate first" };
    }
    const idx = typeof args.actionIndex === "number" ? args.actionIndex : undefined;
    const normalizedActions = translated ? normalizeNestedUiActions(translated.actions, this.registry) : undefined;
    const action = args.action ?? (idx !== undefined ? normalizedActions?.[idx] : undefined);
    if (!action) {
      return { ok: false, caseId: args.caseId, actionIndex: idx, reason: `action index ${idx ?? "(missing)"} not found` };
    }

    this.previewCaseInProgress = true;
    this.previewCaseId = `${args.caseId}#action${idx ?? "custom"}`;
    const start = Date.now();
    try {
      if (args.ensureMain === true) {
        const w = await this.waitForMainScreen({ maxWaitMs: Number(process.env.QA_ACTION_PREFLIGHT_MAX_WAIT_MS ?? 30_000) });
        if (!w.onMain) {
          return {
            ok: false,
            caseId: args.caseId,
            actionIndex: idx,
            action,
            durationMs: Date.now() - start,
            reason: `not on main before action after ${(w.elapsedMs / 1000).toFixed(0)}s — ${w.reason ?? "could not reach main"}`,
          };
        }
      }
      const parser = await createParserForGame(this.gameSlug);
      const loadedPayoutModel = await payoutModel.load(this.gameSlug).catch(() => null);
      await executeAction(action, {
        page: this.session.page,
        uiMap: this.registry,
        parser,
        priorBalance: this.lastBalance,
        liveBalance: () => this.lastBalance,
        gameSlug: this.gameSlug,
        payoutModel: loadedPayoutModel,
        subscribeWsFrames: (cb: (f: { url: string; sent: boolean; payload: string }) => void) => this.subscribeWsFrames(cb),
        isOnMainScreen: async () => {
          const r = await this.ensureMainScreen({ probe: false, autoRecover: false, aiDismiss: false });
          return r.onMain;
        },
      });
      return {
        ok: true,
        caseId: args.caseId,
        actionIndex: idx,
        action,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        caseId: args.caseId,
        actionIndex: idx,
        action,
        durationMs: Date.now() - start,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.previewCaseInProgress = false;
      this.previewCaseId = null;
      this.previewCaseLastFinishedId = args.caseId;
      this.previewCaseLastFinishedAt = new Date().toISOString();
    }
  }

  /**
   * Batch re-translate all cases that are currently skipped (empty actions or
   * have skipReason). Useful after QA has discovered + verified more UI
   * elements — many cases that referenced previously-missing uiKeys can now
   * succeed. Cost = ~$0.02 × N skipped cases.
   */
  async retranslateAllSkipped(opts: { mode?: "skipped" | "all"; slugOverride?: string } = {}): Promise<{ ok: boolean; total?: number; succeeded?: number; stillSkipped?: number; reason?: string }> {
    const mode = opts.mode ?? "skipped";
    const slug = opts.slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    // Re-sync ALL cases' template-derived assertions first (one load+save) so
    // batch re-translate also adopts template fixes — same contract as the
    // per-case button.
    try {
      const { loadRawCatalog, saveCatalog } = await import("../step7-testcase-gen/ai-catalog.js");
      const raw = await loadRawCatalog(slug);
      if (raw) {
        const { resyncAssertionsWithTemplates } = await import("../../ai/assertion-templates.js");
        let totalSynced = 0;
        for (const c of raw.cases) {
          if (!c.custom_assertions?.length) continue;
          const r = resyncAssertionsWithTemplates(c.custom_assertions);
          if (r.updated.length > 0) {
            c.custom_assertions = r.assertions;
            totalSynced += r.updated.length;
          }
        }
        if (totalSynced > 0) {
          await saveCatalog(slug, raw);
          console.log(`[manual/retranslate-all] ${slug}: re-synced ${totalSynced} assertion(s) from templates across the catalog`);
        }
      }
    } catch (err) {
      console.warn(`[manual/retranslate-all] assertion resync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available" };

    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };

    // mode=skipped → only cases with no actions or with skipReason
    // mode=all → ALL cases (force re-translate even runnable ones)
    const candidates = mode === "all"
      ? catalog.cases
      : catalog.cases.filter((c) => {
          const t = cache.cases[c.id];
          return !t || t.actions.length === 0 || t.skipReason;
        });

    // Resolve OC once; admin override notes are looked up per-case below.
    const { deriveOcKey, resolveTranslateNote } = await import("../registry/oc-prompt-notes.js");
    const m = await meta.load(slug).catch(() => null);
    const oc = deriveOcKey(m?.gameUrl);

    let succeeded = 0;
    let stillSkipped = 0;
    console.log(`[manual/retranslate-all] ${candidates.length} candidates`);

    // Phase 1 — revise assertions per the admin note. MUST stay sequential:
    // reviseCaseAssertions loads + saves the WHOLE catalog per case, so running
    // these concurrently would let the writes clobber each other (lost
    // revisions). This is a no-op / instant when the OC has no assertion note
    // (the common case), so it rarely costs an AI call here. Keep each case's
    // in-memory copy in sync so the translator below sees the updated assertions.
    for (const c of candidates) {
      const revise = await this.reviseCaseAssertions(c.id, slug, oc);
      if (revise.assertions) c.custom_assertions = revise.assertions;
    }

    // Phase 2 — translate setup→actions CONCURRENTLY (bounded pool). translateCase
    // is a pure AI call (no disk writes); each result lands in cache.cases[c.id]
    // under a distinct key and is persisted once after the pool drains, so this is
    // race-free. This is the dominant per-case cost and where the ~5× speedup lives.
    const CONCURRENCY = 5;
    let nextIdx = 0;
    const translateOne = async (c: (typeof candidates)[number]): Promise<void> => {
      const promptNote = await resolveTranslateNote(oc, c.category, c.id);
      const translated = await translateCase({
        caseId: c.id,
        caseName: c.name,
        category: c.category,
        setup: c.setup_instructions ?? "",
        uiMap: reg,
        gameSpec: this.gameSpec ? {
          betLadder: this.gameSpec.betLadder,
          defaultBet: this.gameSpec.defaultBet,
          betMin: this.gameSpec.betMin,
          betMax: this.gameSpec.betMax,
        } : undefined,
        expectedBet: c.expected_bet,
        spinCount: c.spin_count,
        customAssertions: c.custom_assertions,
        promptNote,
      });
      const { aiCalled: _ac, ...persistable } = translated;
      cache.cases[c.id] = persistable;
      if (translated.skipReason || translated.actions.length === 0) {
        stillSkipped++;
        console.log(`[manual/retranslate-all] ${c.id} still skipped: ${translated.skipReason ?? "no actions"}`);
      } else {
        succeeded++;
        console.log(`[manual/retranslate-all] ${c.id}${translated.aiCalled ? "" : " (no AI, empty setup)"} → ${translated.actions.length} actions`);
      }
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = nextIdx++;
        if (i >= candidates.length) return;
        const c = candidates[i]!;
        try {
          await translateOne(c);
        } catch (err) {
          stillSkipped++;
          console.warn(`[manual/retranslate-all] ${c.id} translate error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
    );

    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);
    return { ok: true, total: candidates.length, succeeded, stillSkipped };
  }

  /**
   * Background wrapper around retranslateAllSkipped (see SessionStatus docs).
   * The batch does N AI calls and routinely runs for minutes — far past the
   * proxy's ~60s cut — so the route must NOT await it. Kick it off, track state
   * on the session, and return immediately; the client polls /status
   * (retranslateAllInProgress → retranslateAllLastFinishedAt + LastResult) to
   * learn the outcome. A mutex (retranslateAllInProgress) blocks stacked runs
   * that would otherwise pile AI batches on top of each other.
   */
  startRetranslateAll(opts: { mode?: "skipped" | "all"; slugOverride?: string } = {}): { ok: boolean; started?: boolean; reason?: string } {
    if (this.retranslateAllInProgress) {
      return { ok: false, reason: "another retranslate-all is already running on this session (HTTP 409)" };
    }
    const slug = opts.slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    this.retranslateAllInProgress = true;
    this.retranslateAllStartedAt = new Date().toISOString();
    this.retranslateAllLastResult = null;
    // Fire-and-forget — Node keeps running this after the HTTP socket closes.
    void this.retranslateAllSkipped(opts)
      .then((r) => { this.retranslateAllLastResult = r; })
      .catch((err) => {
        this.retranslateAllLastResult = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        console.warn(`[manual/retranslate-all] background run failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.retranslateAllInProgress = false;
        this.retranslateAllLastFinishedAt = new Date().toISOString();
      });
    return { ok: true, started: true };
  }

  /**
   * Preview a single test case: execute its translated actions against the
   * Playwright browser (clicks at verified registry coords). User watches
   * Chrome window to confirm steps work, dashboard receives per-action trace.
   */
  async previewCase(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    // Concurrency guard — see previewCaseInProgress field comment for why
    // this matters (proxy 504 + dashboard retry / Run-All loop firing next
    // case while server still on previous one → listener cross-talk).
    if (this.previewCaseInProgress) {
      return { ok: false, reason: "another previewCase is already running on this session — please wait for it to complete (HTTP 409)" };
    }
    this.previewCaseInProgress = true;
    this.previewCaseId = caseId;
    try {
      return await this.previewCaseInner(caseId, opts);
    } finally {
      this.previewCaseInProgress = false;
      this.previewCaseId = null;
      this.previewCaseLastFinishedId = caseId;
      this.previewCaseLastFinishedAt = new Date().toISOString();
    }
  }

  private async previewCaseInner(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const catalog = await loadAiCatalog(this.gameSlug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const actionsCache = await loadActionsCache(this.gameSlug);
    const translated = actionsCache?.cases[caseId];
    if (!translated) return { ok: false, reason: "no translated actions for this case — run qa:cold to translate first" };

    // Pre-flight: every case must start on the MAIN game screen. Uses a
    // POLLING wait (not a one-shot check) so a leftover free-spin chain from a
    // PREVIOUS case (shared session state) is WAITED OUT — ensureMainScreen
    // flags FS-active + skips dismiss, and we poll until the chain finishes.
    // Dismissable popups (celebration / buy / paytable) are auto-recovered each
    // poll. Skip entirely when the caller already ensured main (dashboard
    // run-all loop does its own inter-case wait) via { ensureMain: false }.
    const PREFLIGHT_MAX_WAIT_MS = Number(process.env.QA_CASE_PREFLIGHT_MAX_WAIT_MS ?? 90_000);
    if (opts.ensureMain !== false) {
      const w = await this.waitForMainScreen({ maxWaitMs: PREFLIGHT_MAX_WAIT_MS });
      if (!w.onMain) {
        const reason = `not on main before case after ${(w.elapsedMs / 1000).toFixed(0)}s — ${w.reason ?? "could not reach main"}`;
        console.warn(`[preview-case] ${caseId} SKIP — ${reason}`);
        return {
          ok: true,
          result: {
            caseId: tc.id,
            name: tc.name,
            category: tc.category,
            severity: tc.severity,
            status: "skip",
            skipReason: reason,
            actionsExecuted: 0,
            assertions: [],
            spin: null,
            durationMs: 0,
          },
        };
      }
      if (w.recoveredCount > 0) console.log(`[preview-case] ${caseId} reached main before run (${w.polls} polls, ${w.recoveredCount} recoveries, ${(w.elapsedMs / 1000).toFixed(0)}s)`);
    }

    // Factory auto-loads parser kind + bet multiplier from registry. No more
    // ad-hoc setBetMultiplier injection — Phase 7.1B consolidation.
    const parser = await createParserForGame(this.gameSlug);

    // Auto-inject default allowed_interruptions for multi-spin cases (Part B
    // of state-machine runner overhaul). Slot games can randomly trigger
    // free spins / big wins / bonuses on ANY spin — treating that as a
    // failure-by-default is wrong. Any case that fires ≥2 spins should
    // tolerate these expected variations unless the catalog explicitly opts
    // out by setting `allowed_interruptions: []`.
    const spinActionCount = translated.actions.filter((a) => a.kind === "spin").length;
    // Includes the dismissable popup states (autoplay / paytable / history /
    // settings / buy-feature) — each has a dismiss handler, so a STRAY popup
    // during a generic spin run is auto-dismissed and tolerated instead of
    // failing the State signal as an "unexpected non-MAIN transition".
    const DEFAULT_INTERRUPTIONS = [
      "FREE_SPIN_TRIGGERED",
      "BIG_WIN_POPUP",
      "BONUS_POPUP",
      "AUTOPLAY_POPUP",
      "PAYTABLE_POPUP",
      "HISTORY_POPUP",
      "SETTINGS_POPUP",
      "BUY_FEATURE_POPUP",
    ];
    let resolvedInterruptions = tc.allowed_interruptions;
    if (resolvedInterruptions === undefined && spinActionCount >= 2) {
      resolvedInterruptions = DEFAULT_INTERRUPTIONS;
      console.log(`[case-runner] auto-injected allowed_interruptions=${JSON.stringify(DEFAULT_INTERRUPTIONS)} for multi-spin case "${tc.id}" (${spinActionCount} spins)`);
    }

    const caseInput = {
      id: tc.id,
      name: tc.name,
      category: tc.category,
      severity: tc.severity,
      custom_assertions: tc.custom_assertions,
      minimum_evidence: tc.minimum_evidence,
      allowed_interruptions: resolvedInterruptions,
      on_feature_triggered: tc.on_feature_triggered,
      retry_policy: tc.retry_policy,
      actions: translated.actions,
      skipReason: translated.skipReason,
    };
    // Load the self-calibrated payout model (PP wlc_v games). Null/untrusted →
    // payoutModelCheck is a no-op, so cases run identically on uncalibrated games.
    const loadedPayoutModel = await payoutModel.load(this.gameSlug).catch(() => null);
    const ctx = {
      page: this.session.page,
      uiMap: this.registry,
      parser,
      priorBalance: this.lastBalance,
      // Live read so a multi-attempt retry loop sees the current balance, not
      // the snapshot taken when previewCase was first entered. The executor
      // uses this to seed balanceBefore for the first spin of each attempt.
      liveBalance: () => this.lastBalance,
      gameSlug: this.gameSlug,
      payoutModel: loadedPayoutModel,
      // WS-protocol games (Playtech socket.io): the executor reads spin frames
      // from the session-level capture (attached at start, catches the socket
      // opened at page load) instead of a too-late case-local listener.
      subscribeWsFrames: (cb: (f: { url: string; sent: boolean; payload: string }) => void) => this.subscribeWsFrames(cb),
      isOnMainScreen: async () => {
        const r = await this.ensureMainScreen({ probe: false, autoRecover: false, aiDismiss: false });
        return r.onMain;
      },
    };

    // Retry loop policy (forced): run exactly once — no retry on failure.
    //   - First attempt always runs; result is recorded as-is (pass or fail)
    // This intentionally ignores per-case retry_policy/env so behavior stays
    // deterministic in QA runs.
    const { runWithRetry } = await import("../step8-run-scenarios/case-retry-loop.js");
    const policy = {
      maxRetries: 0,
      retryWhen: [],
      retryOnFailStatus: false,
    };
    // Re-ensure main between attempts (a failed run may have left a popup /
    // mid-feature state). The first attempt relies on the pre-flight above.
    let firstRun = true;
    const executeOnce = async (): Promise<CaseResult> => {
      if (!firstRun && opts.ensureMain !== false) {
        // A failed attempt may have left a popup OR triggered a free-spin chain
        // — poll-wait for main (FS-aware) before re-running.
        const w = await this.waitForMainScreen({ maxWaitMs: PREFLIGHT_MAX_WAIT_MS });
        if (!w.onMain) console.warn(`[preview-case] ${caseId} retry: still off-main after wait — running anyway`);
      }
      firstRun = false;
      return executeCase(ctx, caseInput);
    };
    const loop = await runWithRetry(executeOnce, policy);
    const result = loop.finalResult;
    if (loop.attempts > 1) {
      const history = loop.attemptHistory.map((a) => `#${a.attempt}=${a.outcome ?? a.status}`).join(", ");
      const recovered = result.status === "pass" && loop.attemptHistory[0]?.status === "fail";
      console.log(`[preview-case] ${caseId} ran ${loop.attempts} attempts: ${history}${recovered ? " → recovered (pass after retry)" : ""}`);
      result.warnings = [
        ...(result.warnings ?? []),
        `re-run ${loop.attempts - 1}× (first failed): ${history}`,
      ];
    }
    return { ok: true, result };
  }

  /**
   * Read-only: load the stored payout-model.json so the dashboard can show it
   * (human-readable table + raw JSON). No active session required — accepts a
   * slug override for inspecting any registered game.
   */
  async getPayoutModel(
    slugOverride?: string,
  ): Promise<{ ok: boolean; model?: import("../registry/types.js").PayoutModel; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const model = await payoutModel.load(slug).catch(() => null);
    if (!model) return { ok: false, reason: `payout-model.json not found for ${slug} — run Calibrate Payout first` };
    return { ok: true, model };
  }

  /**
   * Calibrate the per-game payout model (Layer 2 of payout verification).
   * Spins live at >= 2 bet levels, captures the server's per-combo win
   * breakdown (PP `wlc_v`) tagged with the ACTUAL coin from each response, then
   * derives + self-validates a PayoutModel (deterministic fit, AI assist only if
   * needed). Stores it to registry/payout-model.json. The model is only
   * `trusted` if it reproduces 100% of observed combos across >= 2 coin levels
   * AND agrees with the paytable — otherwise verification stays a no-op.
   *
   * Runs as its OWN flow (NOT through previewCase) so the retry loop / AI review
   * never interferes with capture.
   */
  async calibratePayoutModel(
    opts: { spinsPerLevel?: number } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    trusted?: boolean;
    coinLevels?: number[];
    combosTotal?: number;
    combosMatched?: number;
    paytableAgreement?: boolean;
    symbolsModeled?: number;
    notes?: string[];
  }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const page = this.session.page;

    // Provider gate. The payout model is derived from Pragmatic `wlc_v`
    // winning-line combos, and the side-channel below captures them with the
    // HARDCODED `pragmaticProvider` (URL pattern + parseBody). Other providers
    // either don't expose wlc_v (ThreeOaks) or don't even spin over HTTP
    // (Playtech = WebSocket), so the run would fire ~50 spins and ALWAYS report
    // "0 spin responses" — falsely blaming autoplay/spin coords. Skip up front
    // with the real reason. Pragmatic + Generic (PP-clone JSON served from the
    // same endpoints) are the only formats the side-channel can read.
    const pc = await providerCache.load(this.gameSlug).catch(() => null);
    const provider = pc?.provider;
    if (provider && provider !== "Pragmatic" && provider !== "Generic") {
      const wire = provider === "Playtech" ? "WebSocket frames" : "a non-Pragmatic HTTP format";
      console.warn(`[calibrate-payout] ${this.gameSlug}: provider=${provider} — payout-model calibration skipped (wlc_v combo model is Pragmatic-only; spins use ${wire}).`);
      return {
        ok: false,
        reason: `payout-model calibration not applicable to provider "${provider}" — the model is derived from Pragmatic \`wlc_v\` combos, which this game does not expose (spins use ${wire}). This is NOT an autoplay/spin-coords problem; the game spins fine. Skipped without running spins.`,
      };
    }

    // Target rounds PER bet level. When the registry exposes the autoplay UI
    // we run this as ONE native autoplay batch per level (default ~100 rounds)
    // — far faster wall-clock than per-click spins and yields more winning
    // combos → a better-trusted model. Falls back to discrete spins (8–60)
    // when autoplay UI is absent.
    const targetSpins = Math.max(20, Math.min(1000, opts.spinsPerLevel ?? 100));
    const K = Math.max(8, Math.min(60, opts.spinsPerLevel ?? 25));

    // Pre-flight registry check. Calibration spins 25-50 times — clicking
    // a missing coord just throws immediately, but the historic error
    // message ("no winning combos captured") was misleading because the
    // outer code only checked combo count, not WHY no spins ran. Verify
    // the elements we depend on are present + verified, fail fast with
    // a clear reason if not. QA sees this directly in the phase note
    // instead of guessing.
    const required = ["spinButton"] as const;
    const missing: string[] = [];
    const unverified: string[] = [];
    for (const k of required) {
      const el = this.registry[k];
      if (!el) { missing.push(k); continue; }
      if (el.verifiedBy !== "QA" && el.verifiedBy !== "probe") unverified.push(k);
    }
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `calibration cannot run — registry missing required elements: ${missing.join(", ")}. Run Deep Discover first, or add the entries manually via the dashboard's [Add Element] / [Pick] flow.`,
      };
    }
    if (unverified.length > 0) {
      console.warn(`[calibrate-payout] ${this.gameSlug}: required elements unverified (${unverified.join(", ")}) — proceeding anyway, but coords may be wrong`);
    }
    const betMinus = this.registry["betMinus"];
    const betPlus = this.registry["betPlus"];

    // Pre-flight main-state guard. Calibration assumes we're on the base game
    // screen before firing the first set_bet/spin actions. If a popup/overlay
    // is still open from prior phases, spin clicks can be ignored and we end
    // up with "no spin response captured" even though coords are correct.
    const mainPre = await this.waitForMainScreen({ maxWaitMs: 20_000 });
    if (!mainPre.onMain) {
      const rec = await this.forceRecoverToMain({ maxWaitMs: 90_000 });
      if (!rec.onMain) {
        return {
          ok: false,
          reason: `calibration preflight failed: game not on main screen (${rec.reason ?? mainPre.reason ?? "unknown"}). Close popup/overlay and retry Auto-Onboard.`,
        };
      }
    }
    // Bet ladder check — set_bet_to_min uses betControls.minBetClicks
    // (default 20) which usually reaches min without needing gameSpec.
    // But the SECOND coin level uses set_bet_to_value(higherBet) which
    // needs a valid ladder. Warn loudly when missing; we still proceed
    // with the single-level path (K spins at min) which gives partial
    // calibration data.
    const hasLadder = (this.gameSpec?.betLadder?.length ?? 0) > 1;
    if (!hasLadder) {
      console.warn(`[calibrate-payout] ${this.gameSlug}: gameSpec.betLadder missing or has ≤1 entry — running 1-level calibration only (less accurate). Make sure the game's do_init API has been captured (open the game URL fresh in session, observe network).`);
    }

    // Side-channel capture: parse wlc_v + actual coin `c` from EVERY spin
    // response (initial + cascade frames) — independent of executeCase's own
    // dedup listener, and robust to set_bet not landing an exact coin.
    const combos: CalibrationCombo[] = [];
    // Phase 3 — raw {request,response} pairs for the spec-learner. Captured
    // from the SAME spins (no extra cost), BEFORE the FS-skip gate so tumble /
    // free-spin frames are included (the replay-gate dedups them itself).
    const learnerSamples: ReplaySample[] = [];
    let fsFramesSkipped = 0;
    let spinRespsSeen = 0; // PP spin responses the side-channel actually parsed (diagnostic)
    const onResp = async (res: import("playwright").Response) => {
      try {
        const url = res.url();
        // Use the PROVIDER's URL pattern, NOT a hardcoded /gameService|doSpin/
        // regex. PP spin endpoints vary: `/gs2c/ge/…`, `…playGame`, `…doGame`,
        // `…gameService`, `…doSpin`. The old hardcoded regex only matched the
        // last two, so games served from `/gs2c/ge/…` (e.g. vs20fruitsw) had
        // EVERY response dropped here → 0 combos captured even though spins
        // fired fine. (Same lesson the main case-executor listener already
        // learned — see its "hardcoded /gameService|doSpin/ dropped every
        // response" note.)
        if (!pragmaticProvider.urlPattern.test(url)) return;
        if (pragmaticProvider.skipUrl?.(url)) return;
        if (res.request().method() !== "POST") return;
        const body = await res.text();
        const parsed = pragmaticProvider.parseBody(body);
        if (!parsed) return;
        // Capture the raw pair for the spec-learner (bounded). Includes FS /
        // tumble frames on purpose — the gate's dedup needs them.
        if (learnerSamples.length < 400) {
          learnerSamples.push({ request: res.request().postData() ?? null, response: body, url });
        }
        // Skip FREE-SPIN / bonus frames. With native autoplay over ~100 rounds
        // (below) the run WILL trigger free spins; FS frames have bet=0 and
        // different combo economics (retrigger awards, multipliers) so their
        // wins would skew the per-symbol BASE rate the model derives. Discrete
        // 25-spin runs rarely hit FS so this gate was previously unnecessary.
        const resp = pragmaticProvider.parseResponse(parsed as Record<string, unknown>);
        if (resp.isFreeSpin === true || (resp.freeSpinsRemaining ?? 0) > 0) { fsFramesSkipped++; return; }
        const coin = Number((parsed as Record<string, unknown>)["c"]);
        if (!Number.isFinite(coin) || coin <= 0) return;
        spinRespsSeen++;
        for (const wc of parseWlcV(parsed as Record<string, unknown>)) {
          combos.push({ ...wc, coin });
        }
      } catch {
        /* ignore individual response parse errors */
      }
    };
    page.on("response", onResp);

    // Hoist these out of the try block so the post-executeCase
    // diagnostics (combos === 0 disambiguation) can reference them
    // when reporting why calibration didn't capture any spins.
    // Pick the SECOND coin level. Prefer the registry's real bet chips
    // (`<parent>__bet-<n>` / `__betAmount-<n>`) over the computed betLadder:
    //   - chips are values the UI actually exposes → set_bet_to_value lands via
    //     a single direct chip click (no 30-click OCR ladder traversal), and
    //   - chips are BASE-mode bets, whereas betLadder is coinValues × ALL
    //     bls levels — which for ante games includes ante-multiplier rungs
    //     (e.g. bls=[1,1.25,1.5,1.9] → 6.25). With ante OFF (as calibration
    //     requires) those rungs are UNREACHABLE, so targeting one just makes
    //     the OCR loop spin 30 clicks and settle on the wrong bet.
    // Median chip gives a mid-volatility level distinct from min. Fall back to
    // the betLadder median only when no chips are registered.
    const chipValues = [...new Set(
      Object.keys(this.registry)
        .map((k) => /__bet(?:Amount)?-(\d+(?:\.\d+)?)$/.exec(k)?.[1])
        .filter((v): v is string => v != null)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    )].sort((a, b) => a - b);
    const ladder = this.gameSpec?.betLadder ?? [];
    let higherBet: number | null = null;
    if (chipValues.length > 1) {
      higherBet = chipValues[Math.floor(chipValues.length / 2)]!;
      console.log(`[calibrate-payout] ${this.gameSlug}: level-2 bet=${higherBet} from registry chips [${chipValues.join(", ")}] (base-mode, UI-reachable)`);
    } else if (ladder.length > 1) {
      const higherIdx = Math.min(Math.floor(ladder.length / 2) || 1, ladder.length - 1);
      higherBet = ladder[higherIdx]!;
      console.warn(`[calibrate-payout] ${this.gameSlug}: no bet chips in registry — falling back to betLadder median=${higherBet} (may be an ante rung if game has ante; ensure ante is OFF)`);
    }
    // Per-level spin generator: native autoplay batch when the autoplay UI is
    // registered (one click-to-start → ~targetSpins rounds), else fall back to
    // K discrete spins. The wlc_v side-channel above captures combos either way.
    const autoBatch = buildAutoplayBatch(this.registry, {
      targetSpins,
      reason: "payout calibration: autoplay batch",
    });
    const discreteBatch = (): import("../step7-testcase-gen/case-action-translator.js").CaseAction[] =>
      Array.from({ length: K }, () => [{ kind: "spin" as const }, { kind: "wait_ms" as const, ms: 2500 }]).flat();
    // Level-1 uses the native autoplay batch (high volume → more winning combos)
    // when the UI exposes it. Level-2 ALWAYS uses discrete spins: re-opening the
    // autoplay panel for a 2nd batch is fragile — if level-1 autoplay hasn't
    // fully wound down, the autoButton click STOPS it (toggle) instead of
    // opening the panel, so level-2 never spins (observed: 0 doSpin, balance
    // frozen). Discrete spinButton clicks have no toggle/panel dependency, and
    // level-2 only needs a few combos to establish the 2nd coin level.
    const level1Batch = (): import("../step7-testcase-gen/case-action-translator.js").CaseAction[] =>
      autoBatch ? autoBatch.actions.map((a) => ({ ...a })) : discreteBatch();
    const spinMode = autoBatch ? `L1 native autoplay tile=${autoBatch.tile} + L2 ${K} discrete` : `${K} discrete spins/level`;

    const actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[] = [];
    // Force ante OFF first. Ante ON (PP `sInfo=an`) inflates the wager AND
    // shifts the bet ladder, so set_bet_to_min / the bet chips no longer land
    // on the base values they were discovered at — the second-level chip click
    // then silently fails to change the coin, leaving BOTH levels at the same
    // coin (one distinct coin → model can never be `trusted`, needs >=2).
    // No-op at runtime when the game has no anteButton.
    if (this.registry.anteButton) {
      actions.push({ kind: "ensure_ante_off", reason: "calibration: base wager, stable bet ladder for 2 coin levels" });
      actions.push({ kind: "wait_ms", ms: 500 });
    }
    if (betMinus) {
      actions.push({ kind: "set_bet_to_min" });
      actions.push({ kind: "wait_ms", ms: 800 });
    } else {
      console.warn(`[calibrate-payout] ${this.gameSlug}: betMinus not in registry — skipping set_bet_to_min and using current bet for level-1 spins`);
    }
    actions.push(...level1Batch());
    if (higherBet != null && betMinus && betPlus) {
      // STOP leftover autoplay before touching the bet UI. Waiting it out has
      // failed twice in production:
      //   - the end-of-FS CELEBRATION pauses autoplay >10s → quiet-waits exit
      //     while ~59 rounds are still pending behind the popup, and
      //   - a 100-spin batch outlives any reasonable wait cap, then overlaps
      //     the whole level-2 phase (set_bet swallowed, coin never changes).
      // Deterministic instead: dismiss the celebration first (a PAUSED
      // autoplay emits no spins, so the stop action can't see it), then
      // actively STOP whatever resumes (autoButton = stop control while
      // running; clicked only when spins are observed arriving).
      actions.push({
        kind: "wait_until_state",
        state: "MAIN",
        maxMs: 60_000,
        reason: "dismiss end-of-feature celebration (a paused autoplay emits no spins)",
      });
      actions.push({ kind: "stop_autoplay_if_running", reason: "stop leftover level-1 autoplay before changing bet" });
      actions.push({
        kind: "wait_until_state",
        state: "MAIN",
        maxMs: 20_000,
        reason: "ensure main screen before bet UI",
      });
      actions.push({ kind: "set_bet_to_value", value: higherBet, reason: "calibration: second coin level" });
      actions.push({ kind: "wait_ms", ms: 800 });
      actions.push(...discreteBatch()); // discrete (not autoplay) — see level1Batch note
    } else if (higherBet != null) {
      console.warn(`[calibrate-payout] ${this.gameSlug}: second-level calibration skipped (needs both betMinus + betPlus in registry)`);
    }
    // Leave the session IDLE: an autoplay batch that survived to the end of
    // the action list keeps spinning AFTER the case returns (listeners
    // detached → invisible), burning balance and polluting the next phase.
    actions.push({
      kind: "wait_until_state",
      state: "MAIN",
      maxMs: 30_000,
      reason: "dismiss any trailing celebration before final autoplay stop",
    });
    actions.push({ kind: "stop_autoplay_if_running", reason: "leave the session idle — no leftover autoplay after calibration" });

    let caseResult: Awaited<ReturnType<typeof executeCase>> | null = null;
    try {

      const parser = await createParserForGame(this.gameSlug);
      const ctx = {
        page,
        uiMap: this.registry,
        parser,
        priorBalance: this.lastBalance,
        liveBalance: () => this.lastBalance,
        gameSlug: this.gameSlug,
        payoutModel: null,
        subscribeWsFrames: (cb: (f: { url: string; sent: boolean; payload: string }) => void) => this.subscribeWsFrames(cb),
      };
      console.log(`[calibrate-payout] ${this.gameSlug}: capturing combos via ${spinMode} × ${higherBet != null ? 2 : 1} level(s)…`);
      // Capture executeCase result so we can distinguish "spins ran but
      // no wins" from "spins never fired" — the former is a volatility
      // issue (genuine), the latter is a setup issue (wrong reason).
      caseResult = await executeCase(ctx, {
        id: "payout-calibration",
        name: "Payout model calibration",
        category: "payout_correctness",
        severity: "minor",
        actions,
        allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP", "BONUS_POPUP"],
        on_feature_triggered: "handle_and_continue",
      });
    } finally {
      page.off("response", onResp);
    }

    const distinctCoins = [...new Set(combos.map((c) => c.coin))];
    const cr = caseResult; // null when executeCase threw (rare — caught by outer)
    console.log(`[calibrate-payout] ${this.gameSlug}: case status=${cr?.status ?? "errored"} actionsExecuted=${cr?.actionsExecuted ?? 0}/${actions.length} spinResponsesSeen=${spinRespsSeen} captured=${combos.length} base combos across coins [${distinctCoins.join(", ")}] (skipped ${fsFramesSkipped} free-spin/bonus frame(s))`);
    if (combos.length > 0 && distinctCoins.length < 2 && higherBet != null) {
      console.warn(`[calibrate-payout] ${this.gameSlug}: only ${distinctCoins.length} distinct coin level captured (level-2 set_bet_to_value=${higherBet} did NOT change the coin — chip click likely cancelled on close, or bet UI didn't commit). Model will derive but stay UNTRUSTED (needs >=2 coin levels). Check the bet-chip close behaviour for this game.`);
    }
    if (combos.length === 0) {
      // Disambiguate root cause:
      //   - executeCase fail with skipReason → bet/spin setup broke
      //   - actionsExecuted ≈ 0 → never reached spin actions
      //   - actionsExecuted ≈ planned → spins ran but no wins (volatility)
      if (cr?.status === "fail" && cr.skipReason) {
        return {
          ok: false,
          reason: `calibration setup failed before any spin landed: ${cr.skipReason}. Check registry (spinButton/betMinus coords + verified) and the game canvas state.`,
        };
      }
      const executed = cr?.actionsExecuted ?? 0;
      if (executed < Math.min(5, actions.length)) {
        return {
          ok: false,
          reason: `calibration aborted after only ${executed}/${actions.length} actions — spins never reliably fired. Check the game is on the MAIN screen (not stuck on a popup) and that spinButton coord is correct.`,
        };
      }
      // Spins fired but no winning combos. Distinguish two sub-cases with the
      // side-channel diagnostic counter:
      if (spinRespsSeen === 0) {
        return {
          ok: false,
          reason: `executed ${executed}/${actions.length} actions but the side-channel captured 0 spin responses — autoplay/spin likely didn't fire, or the spin endpoint URL wasn't recognized. Verify the autoplay UI (autoButton/tile/start) coords + that the game actually spun.`,
        };
      }
      return {
        ok: false,
        reason: `saw ${spinRespsSeen} spin response(s) but none carried a winning combo (wlc_v) — genuine volatility/no-win run. Re-run (more spins) or pick a higher-volatility bet level.`,
      };
    }

    const paytableData = await paytableStore.load(this.gameSlug).catch(() => null);
    const mech = await gameMechanics.load(this.gameSlug).catch(() => null);
    const model = await derivePayoutModel({
      combos,
      paytable: paytableData,
      mechanic: mech?.mechanic ?? "unknown",
    });
    await payoutModel.save(this.gameSlug, model);
    console.log(`[calibrate-payout] ${this.gameSlug}: model trusted=${model.trusted} reproduced=${model.calibration.combosMatched}/${model.calibration.combosTotal} coins=${model.calibration.coinLevels.length} paytableAgreement=${model.calibration.paytableAgreement}`);

    // Phase 3 — learn the per-game parser-overlay from the captured samples.
    // Only meaningful when a provider spec exists (SpecDrivenParser path); the
    // legacy hardcoded parser already populates winBreakdown, so skip. The
    // detector proposes winItemization; the replay-gate validates it on these
    // real samples before `trusted` is set. Non-fatal: a failure here must not
    // break calibration (payout-model is already saved above).
    try {
      const baseSpec = await tryLoadProviderSpec("pragmatic");
      if (baseSpec && learnerSamples.length > 0) {
        // Deterministic detector → gate; AI tail (Phase 5) only fires when the
        // deterministic path can't reconcile despite enough wins. The gate
        // re-validates the AI's pick, so trust never rests on the model.
        const learned = await learnParserOverlayWithAi(baseSpec, learnerSamples, {
          minWinningRounds: 5,
          aiPropose: aiProposeWinItemization,
        });
        const overlay = {
          ...learned.overlay,
          validation: { ...learned.overlay.validation, validatedAt: new Date().toISOString() },
        };
        const overlayFile = path.join(dirForGame(this.gameSlug), "parser-overlay.json");
        await writeFile(overlayFile, JSON.stringify(overlay, null, 2) + "\n", "utf8");
        console.log(
          `[calibrate-payout] ${this.gameSlug}: parser-overlay → winItemization=${overlay.winItemization?.value} trusted=${overlay.winItemization?.trusted} ` +
          `(gate: ${learned.gate.itemization.winningRounds} win round(s), reconciled=${learned.gate.itemization.reconciled})` +
          `${learned.aiUsed ? ` — AI tail used (${learned.aiReasoning ?? ""})` : ""}` +
          `${learned.needsAi ? " — still unrecognized (manual review)" : ""}${learned.needMoreSamples ? " — needMoreSamples" : ""}`,
        );
      } else if (learnerSamples.length > 0) {
        // No provider spec on disk → the spec-driven ITEMIZATION learner can't
        // run (the legacy parser itemizes natively anyway). But FS credit
        // timing only needs A parser — learn it from the game's ACTUAL parser
        // so deferred-credit games get verified instead of INCONCLUSIVE.
        const parser = await createParserForGame(this.gameSlug);
        const t = detectFsCreditTiming(parser, learnerSamples);
        if (t.value != null) {
          const overlay = {
            schemaVersion: 1 as const,
            basedOnProvider: "(legacy parser — no provider spec)",
            // NOTE: no winItemization aspect — absent means "not overridden",
            // the runtime treats native itemization as verified.
            fsCreditTiming: { value: t.value, trusted: t.trusted },
            validation: { validatedAt: new Date().toISOString(), samplesReplayed: learnerSamples.length },
          };
          const overlayFile = path.join(dirForGame(this.gameSlug), "parser-overlay.json");
          await writeFile(overlayFile, JSON.stringify(overlay, null, 2) + "\n", "utf8");
          console.log(`[calibrate-payout] ${this.gameSlug}: parser-overlay → fsCreditTiming=${t.value} trusted=${t.trusted} (${t.reason})`);
        } else {
          console.log(`[calibrate-payout] ${this.gameSlug}: fsCreditTiming not learned — ${t.reason}`);
        }
      }
    } catch (err) {
      console.warn(`[calibrate-payout] ${this.gameSlug}: parser-overlay learn failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Surface WHY the model can't be trusted when only one coin level was
    // captured (level-2 didn't change the coin / was skipped) — QA previously
    // only saw `trusted=false` with no cause. Fail-loud, no silent 1-coin runs.
    const extraNotes: string[] = [];
    if (distinctCoins.length < 2) {
      extraNotes.push(
        higherBet == null
          ? `⚠ single coin level (${distinctCoins.join(", ") || "?"}): level-2 was SKIPPED — no bet chips in registry and no usable betLadder in gameSpec`
          : `⚠ single coin level (${distinctCoins.join(", ") || "?"}): level-2 ran but the coin never changed — set_bet_to_value(${higherBet}) did not land (check the chip-click verify warnings in the log). Model stays UNTRUSTED (needs ≥2 coin levels).`,
      );
    }

    return {
      ok: true,
      trusted: model.trusted,
      coinLevels: model.calibration.coinLevels,
      combosTotal: model.calibration.combosTotal,
      combosMatched: model.calibration.combosMatched,
      paytableAgreement: model.calibration.paytableAgreement,
      symbolsModeled: Object.keys(model.symbolCurves).length,
      notes: [...(model.notes ?? []), ...extraNotes],
    };
  }

  /**
   * Ship C — auto-mode preview. Run case → if outcome ∈ {FAIL_LOW,
   * INCONCLUSIVE} → heuristic-first AI Review. If heuristic ≥ 0.85 +
   * patch exists → auto-apply + rerun once. Skips AI fallback (avoids
   * cost) — if heuristic can't decide, just return the original result.
   *
   * Cap: 1 review + 1 patch + 1 rerun. NO further AI fallback or loop.
   * Loop variant: call autoRerunWithPatches() explicitly (user button).
   */
  async previewCaseAuto(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string; autoActions?: string[] }> {
    // Hold the mutex for the WHOLE auto-flow (initial run + heuristic review +
    // patch apply + rerun). Inner calls go through previewCaseInner to avoid
    // recursive lock acquisition. Without this, the rerun at line 3215 could
    // race with a concurrent /preview-case HTTP request triggered by client
    // retry after a proxy 504 timeout — see previewCaseInProgress field comment.
    if (this.previewCaseInProgress) {
      return { ok: false, reason: "another previewCase is already running on this session — please wait for it to complete (HTTP 409)" };
    }
    this.previewCaseInProgress = true;
    this.previewCaseId = caseId;
    try {
      return await this.previewCaseAutoInner(caseId, opts);
    } finally {
      this.previewCaseInProgress = false;
      this.previewCaseId = null;
      this.previewCaseLastFinishedId = caseId;
      this.previewCaseLastFinishedAt = new Date().toISOString();
    }
  }

  private async previewCaseAutoInner(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string; autoActions?: string[] }> {
    const initial = await this.previewCaseInner(caseId, opts);
    if (!initial.ok || !initial.result) return initial;

    const outcome = initial.result.outcome;
    const eligible = outcome === "FAIL_LOW" || outcome === "INCONCLUSIVE";
    if (!eligible) return initial;

    const autoLog: string[] = [`outcome=${outcome ?? initial.result.status} → auto-review triggered`];

    try {
      // Heuristic-only review (dryRun=true → no AI cost)
      const reviewResult = await this.reviewFailure(caseId, undefined, true, initial.result);
      if (!reviewResult.ok || !reviewResult.review) {
        autoLog.push("heuristic couldn't classify → giving up auto-mode");
        return { ...initial, autoActions: autoLog };
      }
      const review = reviewResult.review;
      autoLog.push(`heuristic: ${review.classification} (${(review.confidence * 100).toFixed(0)}%)`);

      if (review.confidence < 0.85 || !review.suggestedPatch) {
        autoLog.push("confidence < 0.85 or no patch → manual approval needed");
        return { ...initial, autoActions: autoLog };
      }

      // Auto-apply (gated by validator's 3 layers)
      const applied = await this.applyReviewPatch(caseId, undefined, review.suggestedPatch, review);
      if (!applied.ok) {
        autoLog.push(`auto-apply blocked: ${applied.reason}`);
        return { ...initial, autoActions: autoLog };
      }
      autoLog.push(`patch applied: ${review.suggestedPatch.file} (audit: ${applied.auditLogPath?.split("/").pop()})`);

      // One rerun (no further loop here — loop variant is autoRerunWithPatches).
      // previewCaseInner: bypass the outer mutex (we already hold it).
      const rerun = await this.previewCaseInner(caseId);
      if (!rerun.ok || !rerun.result) {
        autoLog.push(`rerun failed: ${rerun.reason}`);
        return { ...rerun, autoActions: autoLog };
      }
      autoLog.push(`rerun outcome: ${rerun.result.outcome ?? rerun.result.status}`);
      return { ok: true, result: rerun.result, autoActions: autoLog };
    } catch (err) {
      autoLog.push(`auto-mode error: ${err instanceof Error ? err.message : String(err)}`);
      return { ...initial, autoActions: autoLog };
    }
  }

  /**
   * Gap C — return historical stats (passRate, flakyScore, recent outcomes)
   * for a case so dashboard can show flakiness indicator. No-op if history
   * log doesn't exist (returns zeroes).
   */
  async caseStats(
    caseId: string,
    slugOverride?: string,
  ): Promise<{ ok: boolean; stats?: import("../step8-run-scenarios/history/index.js").CaseStats; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { loadHistory, computeStats } = await import("../step8-run-scenarios/history/index.js");
    const history = await loadHistory(slug, caseId);
    return { ok: true, stats: computeStats(history) };
  }

  /**
   * Phase 7.5 — AI review a failed case. Loads last run result + compiles
   * knowledge → builds Evidence → calls classifier (heuristic-first, AI
   * fallback). Returns the classification + optional suggested patch.
   */
  async reviewFailure(
    caseId: string,
    slugOverride?: string,
    dryRun = false,
    /** Real CaseResult from the most recent run — dashboard passes via
     *  __caseResults[caseId]. When omitted, falls back to synthesized stub
     *  (legacy behavior). */
    realResult?: import("../step8-run-scenarios/case-executor.js").CaseResult,
  ): Promise<{ ok: boolean; review?: import("../step12-failure-review/index.js").ReviewResult; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const actionsCache = await loadActionsCache(slug);
    const translated = actionsCache?.cases[caseId];

    const { compileKnowledge } = await import("../knowledge/compiler.js");
    const knowledge = await compileKnowledge(slug);
    if (knowledge.errors.length > 0) {
      return { ok: false, reason: `compiled-knowledge has errors: ${knowledge.errors.join("; ")}` };
    }

    // Use real result from dashboard if provided; else stub (back-compat).
    const caseResult = realResult ?? {
      caseId: tc.id,
      name: tc.name,
      category: tc.category,
      severity: tc.severity as "critical" | "major" | "minor",
      status: "fail" as const,
      actionsExecuted: translated?.actions.length ?? 0,
      assertions: [],
      spin: null,
      durationMs: 0,
      warnings: [],
    };

    const { buildEvidence, classifyFailure } = await import("../step12-failure-review/index.js");
    const evidence = buildEvidence({
      result: caseResult,
      knowledge,
      actionPlan: translated?.actions ?? [],
    });
    const review = await classifyFailure(evidence, { dryRun });
    if (!review) return { ok: false, reason: "heuristic could not classify; AI dryRun blocked" };
    return { ok: true, review };
  }

  /**
   * Phase 7.6 — validate + apply a SuggestedPatch produced by reviewFailure.
   * Writes to registry config file + appends audit log under patches/.
   */
  async applyReviewPatch(
    caseId: string,
    slugOverride: string | undefined,
    patch: import("../step12-failure-review/index.js").SuggestedPatch,
    review: import("../step12-failure-review/index.js").ReviewResult,
  ): Promise<{ ok: boolean; auditLogPath?: string; reason?: string; validation?: import("../step13-patch-apply/index.js").ValidationOutcome }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { validatePatch, applyPatch } = await import("../step13-patch-apply/index.js");
    const validation = await validatePatch(slug, patch);
    if (!validation.ok) {
      return { ok: false, reason: `patch failed validation: ${validation.errors.join("; ")}`, validation };
    }
    const applied = await applyPatch({ gameSlug: slug, caseId, review, patch, validation, dryRun: null });
    if (!applied.ok) {
      return { ok: false, reason: `apply failed: ${applied.errors.join("; ")}`, validation };
    }
    // Reload registry so subsequent runs see the patch
    const refreshed = await uiRegistry.load(slug);
    if (refreshed) this.registry = refreshed;
    return { ok: true, auditLogPath: applied.auditLogPath, validation };
  }

  /**
   * Phase 8 item 3 — Auto-rerun loop. Apply patch → rerun case → if still
   * fail → AI re-review → apply next patch → loop max 3 times. Returns
   * RerunResult with status ∈ {"pass", "fail", "escalated"} + log array
   * for dashboard display.
   */
  async autoRerunWithPatches(
    caseId: string,
    slugOverride: string | undefined,
    initialPatch: import("../step12-failure-review/index.js").SuggestedPatch,
    initialReview: import("../step12-failure-review/index.js").ReviewResult,
  ): Promise<import("../step13-patch-apply/types.js").RerunResult> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) {
      return { status: "escalated", attemptsUsed: 0, patchesApplied: 0, log: ["gameSlug required"] };
    }
    const { rerunWithPatches } = await import("../step13-patch-apply/rerun-orchestrator.js");
    return rerunWithPatches({
      caseId,
      gameSlug: slug,
      initialPatch,
      initialReview,
      callbacks: {
        applyPatch: async (patch, review) => {
          const r = await this.applyReviewPatch(caseId, slug, patch, review);
          return { ok: r.ok, reason: r.reason };
        },
        rerunCase: async () => {
          const r = await this.previewCase(caseId);
          return {
            ok: r.ok,
            result: r.result ? {
              status: r.result.status,
              outcome: r.result.outcome,
            } : undefined,
            reason: r.reason,
          };
        },
        reReview: async () => {
          const r = await this.reviewFailure(caseId, slug, false);
          return { ok: r.ok, review: r.review, reason: r.reason };
        },
      },
    });
  }

  /**
   * Attach a page-level response listener that watches for `balance=N` in any
   * game-service response (doInit, doSpin, reloadBalance, etc.) and updates
   * `lastBalance`. Called once at session start; persists across reloads
   * because the BrowserContext is shared. Fail-safe: errors swallowed.
   */
  /** Session-level external-tab tracker — window.open tabs (e.g. game
   *  history) land here so manual flows (Test click on externalPage elements)
   *  can route to them, mirroring the case-executor's per-case tracking.
   *  Closed tabs are pruned lazily by the consumers (isClosed checks). */
  private attachExternalTabTracker(): void {
    if (!this.session) return;
    this.externalTabs = [];
    this.session.page.context().on("page", (p) => {
      this.externalTabs.push(p);
      console.log(`[manual] external tab opened — ${this.externalTabs.filter((t) => !t.isClosed()).length} open`);
    });
  }

  // WebSocket frame fan-out. WS-protocol providers (Playtech GPAS socket.io,
  // etc.) open their game socket at PAGE LOAD — long before a case run attaches
  // its own listener — and Playwright's page.on("websocket") never replays an
  // already-open socket. So we attach ONCE at session start (before the game's
  // socket opens) and fan every frame out to whatever case is currently
  // subscribed. Each frame is normalized out of its socket.io/engine.io
  // envelope to the inner JSON so the parser sees clean payloads.
  private wsSubscribers = new Set<(f: { url: string; sent: boolean; payload: string }) => void>();

  /** Subscribe to live WS frames for the duration of a case. Returns an
   *  unsubscribe fn. Frames are already envelope-stripped to inner JSON. */
  subscribeWsFrames(cb: (f: { url: string; sent: boolean; payload: string }) => void): () => void {
    this.wsSubscribers.add(cb);
    return () => { this.wsSubscribers.delete(cb); };
  }

  /** Strip the socket.io / engine.io transport envelope so the parser sees the
   *  inner JSON. Handles socket.io 0.x (`5:::{json}`) and engine.io/socket.io
   *  v1+ (`42[json]` / `4{json}`). Returns the raw frame unchanged when there's
   *  no recognizable envelope (heartbeats etc. → parser rejects them cheaply). */
  private static normalizeWsFrame(raw: string): string {
    // socket.io 0.x: <type>:<id>:<endpoint>:<data> — data is JSON for events.
    const v0 = raw.match(/^\d+:[^:]*:[^:]*:(.+)$/s);
    if (v0 && v0[1] && (v0[1].startsWith("{") || v0[1].startsWith("["))) return v0[1];
    // engine.io / socket.io v1+: leading packet digits then a JSON body.
    const v1 = raw.match(/^\d+(\[[\s\S]*\]|\{[\s\S]*\})$/);
    if (v1 && v1[1]) return v1[1];
    return raw;
  }

  private attachWsCapture(): void {
    if (!this.session) return;
    const fanOut = (url: string, sent: boolean, payload: unknown): void => {
      if (this.wsSubscribers.size === 0) return;
      const raw = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
      if (!raw) return;
      const normalized = ManualSessionManager.normalizeWsFrame(raw);
      for (const cb of this.wsSubscribers) {
        try { cb({ url, sent, payload: normalized }); } catch { /* subscriber error must not break capture */ }
      }
    };
    this.session.page.on("websocket", (ws) => {
      const url = ws.url();
      console.log(`[manual/ws] socket opened: ${url}`);
      ws.on("framesent", (e) => fanOut(url, true, e.payload));
      ws.on("framereceived", (e) => fanOut(url, false, e.payload));
    });
  }

  private attachBalanceTracker(): void {
    if (!this.session) return;
    this.session.page.on("response", async (res) => {
      try {
        const url = res.url();
        // AUTHORITATIVE GAME IDENTITY: Pragmatic serves the game client + assets
        // from `…/games/<provider>/<gameCode>/…` (e.g. /games/vs/vs20fruitsw/).
        // The slug we onboard under is derived from the LAUNCH URL PATH — but a
        // demo token can open a LOBBY that resumes a DIFFERENT game, so the path
        // ("vs243fortune") and the actually-loaded game ("vs20fruitsw") diverge.
        // Onboarding then writes the wrong game's data under the wrong label.
        // Detect the mismatch from the asset URL and flag it loudly (reuses the
        // gameError banner so the dashboard blocks wasted automation).
        const codeMatch = url.match(/\/games\/[a-z0-9_]+\/(vs[a-z0-9]+)\//i);
        if (codeMatch && this.gameSlug && /^vs[a-z0-9]+$/i.test(this.gameSlug)) {
          const loaded = codeMatch[1]!.toLowerCase();
          if (loaded !== this.gameSlug.toLowerCase() && (this.gameError?.site !== "game-mismatch")) {
            console.warn(`[game-identity] ⚠ launch slug='${this.gameSlug}' but platform loaded game assets for '${loaded}' — wrong game / lobby resume`);
            this.gameError = {
              site: "game-mismatch",
              matchedKeywords: [loaded],
              detectedText: `This session is labeled "${this.gameSlug}" but the platform actually loaded a DIFFERENT game: "${loaded}". The launch URL/token resolves to "${loaded}" (or opened a lobby that resumed it). Re-launch with the correct URL for "${this.gameSlug}", or start a fresh session for "${loaded}".`,
              detectedAt: new Date().toISOString(),
            };
          }
        }
        // PP game service + reload-balance endpoints both carry balance fields.
        if (!/gameService|reloadBalance|gs2c/i.test(url)) return;
        const body = await res.text().catch(() => "");
        if (!body) return;
        // Prefer balance_cash if present (more authoritative on PP) else fall back to balance
        const cashMatch = body.match(/(?:^|&)balance_cash=([\d.]+)/);
        const balMatch = body.match(/(?:^|&)balance=([\d.]+)/);
        const captured = cashMatch ? Number(cashMatch[1]) : balMatch ? Number(balMatch[1]) : null;
        const previous = this.lastBalance;
        if (captured !== null && Number.isFinite(captured)) {
          if (this.lastBalance !== captured) {
            console.log(`[manual/balance] ${this.lastBalance ?? "—"} → ${captured} (from ${new URL(url).pathname})`);
          }
          this.lastBalance = captured;
        }
        // Capture game spec from doInit (or first doSpin) — bet ladder etc.
        if (!this.gameSpec) this.tryCaptureGameSpec(body);

        // Derive game-mechanics on first spin pair (where balance actually
        // dropped). Only run once per game slug — once saved, subsequent
        // sessions load from registry. Detect from request fields + observed
        // balance delta + response win value.
        if (
          this.gameSlug &&
          captured !== null &&
          previous !== null &&
          previous > captured &&    // balance dropped → this was a real bet
          !this.gameMechanicsCached
        ) {
          await this.tryDeriveGameMechanics(res, body, previous, captured);
        }
      } catch {
        // ignore
      }
    });
  }

  /**
   * On observing a real bet deduction, derive { mechanic, betMultiplier }
   * from the request fields + balance delta, save to registry, and inject
   * into the active parser (case-executor reads from registry at start, but
   * we update mid-session for newly-detected games).
   */
  private async tryDeriveGameMechanics(
    res: import("playwright").Response,
    body: string,
    prevBalance: number,
    newBalance: number,
  ): Promise<void> {
    if (!this.gameSlug) return;
    // If registry already has mechanics, mark cached + skip.
    if (this.gameMechanicsCached === undefined) {
      const existing = await gameMechanics.load(this.gameSlug);
      if (existing) {
        this.gameMechanicsCached = existing;
        return;
      }
    }
    if (this.gameMechanicsCached) return;

    const rawReq = res.request().postData();
    if (!rawReq) return;
    // Only derive from real spin requests. Other gameService actions
    // (doCollect/reloadBalance/etc.) can move balance and poison the
    // inferred multiplier if treated as stake deductions.
    if (!/(?:^|&)action=doSpin(?:&|$)/i.test(rawReq)) return;
    const parsedReq = pragmaticProvider.parseBody(rawReq);
    if (!parsedReq) return;
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // Prefer balanceBefore (`bb`) from THIS response over tracker's previous
    // value. Listener ordering can interleave unrelated balance updates
    // between spins; `bb` is the authoritative before-balance for the same
    // doSpin response.
    const bbMatch = body.match(/(?:^|&)bb=([\d.]+)/);
    const bbFromResp = bbMatch ? Number(bbMatch[1]) : NaN;
    const effectiveBefore = Number.isFinite(bbFromResp) && bbFromResp > 0
      ? bbFromResp
      : prevBalance;

    // Pull win from response body (PP `tw` field). Default to 0 if absent.
    const twMatch = body.match(/(?:^|&)tw=([\d.]+)/);
    const win = twMatch ? Number(twMatch[1]) : 0;

    // Derive ONLY from a LOSING spin (no win). On a losing spin the balance
    // drop IS the stake exactly — there is no win term that could desync. On
    // tumble/cascade games a WINNING frame reports `tw` (running win) BEFORE
    // it's credited to balance, so deducted = stake + uncredited-win → a garbage
    // multiplier (the vs20fruitsw=41 / vswaysrsm=47 bug) that then mis-stamps
    // bet on every spin. Losing spins dominate real slot play; we don't cache
    // on skip, so this simply retries on the next spin until a clean loss lands.
    // Works for every mechanic — lines/ways/cluster/ante all bill the full stake
    // on a losing spin.
    if (!Number.isFinite(win) || win > 0) return;

    // Outlier guard: if observed deduction is wildly larger than the request's
    // nominal stake (`c*bl` or `c*l`), this sample is likely polluted by a
    // stale balance delta. Skip derive and wait for the next clean spin.
    const c = num(parsedReq["c"]);
    const bl = num(parsedReq["bl"]);
    const l = num(parsedReq["l"]);
    const reqStake = c > 0 ? (bl > 0 ? c * bl : l > 0 ? c * l : 0) : 0;
    const observedDeduct = effectiveBefore - newBalance + (Number.isFinite(win) ? win : 0);
    if (reqStake > 0 && observedDeduct > reqStake * 5) {
      console.warn(
        `[manual/game-mechanics] skip noisy sample for ${this.gameSlug}: `
        + `observedDeduct=${observedDeduct.toFixed(3)} vs reqStake≈${reqStake.toFixed(3)} `
        + `(c=${c}, bl=${bl}, l=${l})`,
      );
      return;
    }

    const derived = deriveGameMechanics({
      parsedRequest: parsedReq,
      balanceBefore: effectiveBefore,
      balanceAfter: newBalance,
      win,
      rawRequest: rawReq,
    });
    if (!derived) return;
    this.gameMechanicsCached = derived;
    await gameMechanics.save(this.gameSlug, derived);
    console.log(`[manual/game-mechanics] derived for ${this.gameSlug}: mechanic=${derived.mechanic} betMultiplier=${derived.betMultiplier} (l=${derived.waysOrLines}, c=${derived.evidence?.coin}, deducted=${derived.evidence?.deductedFromBalance})`);
  }

  private tryCaptureGameSpec(body: string): void {
    const scMatch = body.match(/(?:^|&)sc=([\d.,]+)/);
    const lMatch = body.match(/(?:^|&)l=(\d+)/);
    const defcMatch = body.match(/(?:^|&)defc=([\d.]+)/);
    const blsMatch = body.match(/(?:^|&)bls=([\d.,]+)/);
    // PP do_init also carries `defbl` (default bet level, 1-indexed into bls).
    // Without applying it, defaultBet only reflects coin×lines and ignores
    // the Ante Bet / Bonus Bet multiplier the server actually bills, so
    // catalog "default-bet-equals-X" assertions diverge from real spins
    // (e.g. UI 7 vs API 13.30 for 1.9× ante).
    const defblMatch = body.match(/(?:^|&)defbl=(\d+)/);
    const minMatch = body.match(/(?:^|&)total_bet_min=([\d.]+)/);
    const maxMatch = body.match(/(?:^|&)total_bet_max=([\d.]+)/);
    if (!scMatch || !lMatch) return;
    const coinValues = scMatch[1]!.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const lines = Number(lMatch[1]);
    const defaultCoin = defcMatch ? Number(defcMatch[1]) : coinValues[0]!;
    const betLevels = blsMatch ? blsMatch[1]!.split(",").map(Number).filter(Number.isFinite) : [];
    const defaultBetLevelIdx = defblMatch ? Math.max(1, Number(defblMatch[1])) - 1 : 0;
    const defaultBetLevel = betLevels.length > 0 ? (betLevels[defaultBetLevelIdx] ?? betLevels[0] ?? 1) : 1;
    // PP `bls` field has TWO different semantics across games:
    //   (A) "Lines selector" — bls values are SELECTABLE LINE COUNTS
    //       (often includes `l` itself). Total bet = coin × bls_active.
    //       Example: l=20, bls=[20,25] → player picks 20 or 25 lines →
    //       bet = coin × selected_lines. Real ladder min = coin × min(bls).
    //   (B) "Bet level multiplier" — bls values are MULTIPLIERS applied
    //       on top of coin × lines. Total bet = coin × lines × bls_active.
    //       Example: l=1024, bls=[1, 1.25, 1.5, 1.9] (ante multipliers).
    // Detect: if `lines` appears in `bls`, treat as semantic (A); else (B).
    // Misclassification → ladder/min/max off by a factor of `lines`.
    const blsIncludesLines = betLevels.includes(lines);
    const blsSemantic: "lines-selector" | "multiplier" = blsIncludesLines ? "lines-selector" : "multiplier";
    const baseFactor = (lvl: number): number => blsSemantic === "lines-selector" ? lvl : lines * lvl;
    const computedMin = coinValues[0]! * baseFactor(betLevels[0] ?? 1);
    const computedMax = coinValues[coinValues.length - 1]! * baseFactor(betLevels[betLevels.length - 1] ?? 1);
    const rawMin = minMatch ? Number(minMatch[1]) : NaN;
    const rawMax = maxMatch ? Number(maxMatch[1]) : NaN;
    // Trust server field only when within [0.5×, 2×] of computed ladder.
    // Outside that band the field is likely UNRELATED to per-spin bet:
    //   - too small (rawMin < 0.5×computed): server's `total_bet_min` is
    //     echoing min COIN value (0.01) instead of min total bet (0.2).
    //   - too large (rawMax > 2×computed): server's `total_bet_max` is
    //     likely a session/table/payout cap (e.g. 5000), not per-spin max.
    // In either direction-mismatch case, fall back to ladder-computed
    // which matches UI + paytable.
    const inBand = (raw: number, computed: number): boolean =>
      Number.isFinite(raw) && raw >= computed * 0.5 && raw <= computed * 2;
    const betMin = inBand(rawMin, computedMin) ? rawMin : computedMin;
    const betMax = inBand(rawMax, computedMax) ? rawMax : computedMax;
    if (Number.isFinite(rawMin) && rawMin !== betMin) {
      console.warn(`[manual/spec] total_bet_min=${rawMin} outside plausibility band (computed=${computedMin}) — likely mis-named "min coin". Using computed.`);
    }
    if (Number.isFinite(rawMax) && rawMax !== betMax) {
      console.warn(`[manual/spec] total_bet_max=${rawMax} outside plausibility band (computed=${computedMax}) — likely a session/table/payout cap, not per-spin max. Using computed.`);
    }
    if (blsSemantic === "lines-selector") {
      console.log(`[manual/spec] bls=[${betLevels.join(",")}] includes l=${lines} → treating as line-count selector (bet = coin × bls_active)`);
    }
    // betLadder: every achievable coin×lines×level. Sorted + deduped so the
    // translator can compute step distance for set_bet_to_value. Round to 2
    // decimals to avoid floating-noise duplicates (e.g. 13.3 vs 13.299...).
    const ladderSet = new Set<number>();
    const levelsForLadder = betLevels.length > 0 ? betLevels : [1];
    for (const c of coinValues) {
      for (const lvl of levelsForLadder) {
        // baseFactor() returns either `lvl` (lines-selector semantic) or
        // `lines * lvl` (multiplier semantic) — keeps ladder math
        // consistent with betMin/betMax computed above.
        ladderSet.add(Math.round(c * baseFactor(lvl) * 100) / 100);
      }
    }
    const betLadder = Array.from(ladderSet).sort((a, b) => a - b);
    const raw = {
      coinValues,
      lines,
      defaultCoin,
      betLevels,
      betMin,
      betMax,
      defaultBet: Math.round(defaultCoin * baseFactor(defaultBetLevel) * 100) / 100,
      betLadder,
    };
    this.gameSpecRaw = raw;
    // Apply QA override on top — override fields win, others fall through.
    this.gameSpec = applyOverride(raw, this.gameSpecOverrideCached);
    if (this.gameSpecOverrideCached) {
      const overrideKeys = Object.keys(this.gameSpecOverrideCached).filter((k) => k !== "note" && k !== "updatedAt");
      console.log(`[manual/spec] captured + override applied — overridden fields: [${overrideKeys.join(", ")}]`);
    }
    console.log(`[manual/spec] captured: ladder=${this.gameSpec.betLadder.slice(0, 5).join(",")}…(${this.gameSpec.betLadder.length}) default=${this.gameSpec.defaultBet} (coin=${defaultCoin}×lines=${lines}×bl=${defaultBetLevel}) min=${this.gameSpec.betMin} max=${this.gameSpec.betMax}`);
  }

  /** Update the QA override file + recompute `this.gameSpec` so subsequent
   *  catalog gen / translator calls see the new values. Pass `null` to
   *  CLEAR all overrides (resets effective spec back to raw captured). */
  async setGameSpecOverride(patch: GameSpecOverride | null): Promise<{ ok: boolean; effective: typeof this.gameSpec; reason?: string }> {
    if (!this.gameSlug) return { ok: false, effective: null, reason: "no active session" };
    try {
      if (patch === null) {
        // Erase override → effective reverts to raw.
        this.gameSpecOverrideCached = null;
        await gameSpecOverride.save(this.gameSlug, {});
      } else {
        // Merge with prior override so partial PATCH updates work.
        const merged: GameSpecOverride = {
          ...(this.gameSpecOverrideCached ?? {}),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        // Strip null/undefined fields — those signal "clear this override".
        for (const k of Object.keys(merged) as Array<keyof GameSpecOverride>) {
          if (merged[k] == null) delete merged[k];
        }
        this.gameSpecOverrideCached = merged;
        await gameSpecOverride.save(this.gameSlug, merged);
      }
      // Recompute effective spec if raw is available.
      if (this.gameSpecRaw) {
        this.gameSpec = applyOverride(this.gameSpecRaw, this.gameSpecOverrideCached);
      }
      console.log(`[manual/spec] override updated → effective: min=${this.gameSpec?.betMin} max=${this.gameSpec?.betMax} default=${this.gameSpec?.defaultBet}`);
      return { ok: true, effective: this.gameSpec };
    } catch (err) {
      return { ok: false, effective: this.gameSpec, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Hybrid wait between batch cases. Combines:
   *   1. Fixed minimum delay (animation start has time to begin)
   *   2. Pixel-diff loop: crop around spinButton baseline vs live every 500ms.
   *      When N consecutive samples match baseline (within threshold) → settled.
   *   3. Hard cap (default 45s) for safety (free spins / cascade chain).
   *
   * Returns settled=true when stable confirmed, false if cap reached.
   */
  async waitForStable(opts: {
    uiKey?: string;
    minDelayMs?: number;
    maxMs?: number;
    pollMs?: number;
    stableSamples?: number;
    diffThreshold?: number;
  } = {}): Promise<{ ok: boolean; settled: boolean; durationMs: number; samples: number; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, settled: false, durationMs: 0, samples: 0, reason: "no active session" };
    const uiKey = opts.uiKey ?? "spinButton";
    const el = this.registry[uiKey];
    if (!el?.baselineScreenshot) {
      // No baseline to diff against → fall back to fixed wait
      const fallback = opts.minDelayMs ?? 3000;
      await this.session.page.waitForTimeout(fallback);
      return { ok: true, settled: true, durationMs: fallback, samples: 0, reason: "no baseline; used fixed delay" };
    }
    const baselinePath = path.join(dirForGame(this.gameSlug), "baselines", el.baselineScreenshot);
    let baseline: Buffer;
    try {
      baseline = await readFile(baselinePath);
    } catch {
      const fallback = opts.minDelayMs ?? 3000;
      await this.session.page.waitForTimeout(fallback);
      return { ok: true, settled: true, durationMs: fallback, samples: 0, reason: "baseline unreadable; used fixed delay" };
    }

    const minDelay = opts.minDelayMs ?? 1500;
    const maxMs = opts.maxMs ?? 45_000;
    const pollMs = opts.pollMs ?? 500;
    const stableSamples = opts.stableSamples ?? 2;
    const diffThreshold = opts.diffThreshold ?? 0.05;

    const start = Date.now();
    await this.session.page.waitForTimeout(minDelay);

    const region = regionAround(el.x, el.y, 80, 80);
    let consecutiveStable = 0;
    let samples = 0;
    while (Date.now() - start < maxMs) {
      try {
        const { ratio, changed } = await diffVsBaseline(this.session.page, baseline, region, {
          pixelThreshold: 0.1,
          changeThreshold: diffThreshold,
        });
        samples++;
        if (!changed) consecutiveStable++;
        else consecutiveStable = 0;
        if (consecutiveStable >= stableSamples) {
          return { ok: true, settled: true, durationMs: Date.now() - start, samples };
        }
        void ratio;
      } catch {
        // Diff failure (size mismatch, etc.) — keep polling
      }
      await this.session.page.waitForTimeout(pollMs);
    }
    return { ok: true, settled: false, durationMs: Date.now() - start, samples, reason: `timed out after ${maxMs}ms` };
  }

  async stop(): Promise<void> {
    if (this.session) {
      await closeBrowser(this.session);
    }
    this.session = null;
    this.gameSlug = null;
    this.gameUrl = null;
    this.startedAt = null;
    this.registry = null;
    this.verifyState = {};
    this.lastBalance = null;
    this.owner = null;
  }
}

export const manualSession = new ManualSessionManager();

export type RegisteredGame = {
  gameSlug: string;
  gameUrl: string;
  baseGameSlug?: string;
  currency?: string | null;
  language?: string | null;
  clonedFromSlug?: string;
  /** Friendly game name from provider-cache (e.g. "Mahjong Wins 2"). Matches
   *  the name shown in RUN SUMMARY. Undefined when provider-cache missing. */
  gameName?: string;
  /** Provider label from provider-cache (e.g. "Pragmatic" / "Generic"). */
  provider?: string;
  /** Operator code (OC) derived from the launch URL. Groups admin prompt notes. */
  operator?: string;
  createdAt: string;
  lastValidatedAt?: string;
  elementCount: number;
  verifiedCount: number;
  pendingCount: number;
  rejectedCount: number;
};

/**
 * Update gameUrl in _meta.json without touching the registry. Use case: token
 * in URL expired → change token, registry (UI coords + sub-states) still valid.
 * If session is currently active on this slug, also navigates the browser to
 * the new URL.
 */
export async function updateGameUrl(gameSlug: string, newUrl: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    new URL(newUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  const identity = deriveGameRecordIdentity(newUrl);
  if (identity.recordSlug !== gameSlug) {
    return {
      ok: false,
      reason: `URL belongs to record "${identity.recordSlug}" (${identity.currency ?? "no currency"}/${identity.language ?? "no language"}), not "${gameSlug}". Start it as a new session/record instead of overwriting this one.`,
    };
  }
  const m = await meta.load(gameSlug);
  if (!m) return { ok: false, reason: `No registry for ${gameSlug}` };
  await meta.save(gameSlug, {
    ...m,
    gameUrl: newUrl,
    baseGameSlug: identity.baseGameSlug,
    currency: identity.currency,
    language: identity.language,
    recordSlug: identity.recordSlug,
  });

  // If active session targets this slug, navigate page to new URL so QA can
  // verify the existing registry still maps correctly under the new token.
  if (manualSession.status().active && manualSession.status().gameSlug === gameSlug) {
    await manualSession.navigateTo(newUrl);
  }
  return { ok: true };
}

/**
 * Delete a game and ALL related fixtures: registry folder, pre-game record,
 * provider spec, recorded scenarios, and statistical debug dumps. Stops the
 * active session first if it targets this slug. Irreversible.
 */
export async function deleteGame(gameSlug: string): Promise<{ ok: boolean; removed: string[]; reason?: string }> {
  // Path-traversal guard — slug must be a plain folder name. Dots ARE allowed
  // here (a legacy bad slug like "gpasclient.html" could get registered before
  // deriveSlug was hardened, and the user must still be able to delete it), but
  // path traversal and separators are hard-blocked, and an all-dots / empty
  // slug is rejected so we never target the games root or a parent dir.
  const slugIsSafe =
    /^[a-zA-Z0-9_.-]+$/.test(gameSlug)
    && !gameSlug.includes("..")
    && !/^[.]+$/.test(gameSlug)
    && /[a-zA-Z0-9]/.test(gameSlug);
  if (!slugIsSafe) {
    return { ok: false, removed: [], reason: `invalid slug "${gameSlug}"` };
  }
  // If the active session is on this game, stop it first so the browser +
  // file handles are released before we delete.
  if (manualSession.status().active && manualSession.status().gameSlug === gameSlug) {
    await manualSession.stop().catch(() => {});
  }

  const removed: string[] = [];
  const rmPath = async (p: string) => {
    try {
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // ignore — path may not exist
    }
  };

  // 1. Main registry folder (registry + case-evidence + history + debug-*).
  await rmPath(dirForGame(gameSlug));
  // 2. Single-file per-slug fixtures.
  await rmPath(path.join("fixtures", "pre-game", `${gameSlug}.json`));
  // 3. Per-slug folders elsewhere.
  await rmPath(path.join("fixtures", "specs", gameSlug));
  await rmPath(path.join("fixtures", "scenarios", gameSlug));
  // Visual case-action replay recordings (one folder per case under
  // this slug). Cleaned together so re-adding the same slug doesn't
  // inherit stale baseline screenshots that would fail pixel-diff.
  await rmPath(path.join("fixtures", "case-actions", gameSlug));
  // 4. Timestamped statistical debug dumps: `<slug>-<ISO>-debug`.
  try {
    const statDir = path.join("fixtures", "statistical");
    const entries = await readdir(statDir);
    for (const e of entries) {
      if (e === gameSlug || e.startsWith(`${gameSlug}-`)) {
        await rmPath(path.join(statDir, e));
      }
    }
  } catch {
    // statistical dir may not exist
  }

  if (removed.length === 0) {
    return { ok: false, removed, reason: `nothing found for "${gameSlug}"` };
  }
  return { ok: true, removed };
}

/**
 * List all games that have a registry on disk. Used by dashboard to show
 * "previously registered" games so QA can resume without re-discovery.
 */
export async function listRegisteredGames(): Promise<RegisteredGame[]> {
  const registryRoot = "fixtures/registry";
  let dirs: string[] = [];
  try {
    dirs = await readdir(registryRoot);
  } catch {
    return [];
  }
  const out: RegisteredGame[] = [];
  for (const slug of dirs) {
    try {
      const m = await meta.load(slug);
      const reg = await uiRegistry.load(slug);
      if (!m || !reg) continue;
      let verified = 0, pending = 0, rejected = 0;
      for (const el of Object.values(reg)) {
        if (!el) continue;
        const s = el.status ?? "pending";
        if (s === "verified") verified++;
        else if (s === "rejected") rejected++;
        else pending++;
      }
      // Friendly name + provider from provider-cache (same source as RUN
      // SUMMARY). Missing cache → leave undefined; dashboard falls back to slug.
      const pc = await providerCache.load(slug).catch(() => null);
      const { deriveOcKey } = await import("../registry/oc-prompt-notes.js");
      out.push({
        gameSlug: slug,
        gameUrl: m.gameUrl,
        baseGameSlug: m.baseGameSlug,
        currency: m.currency,
        language: m.language,
        clonedFromSlug: m.clonedFromSlug,
        gameName: pc?.gameName,
        provider: pc?.provider,
        operator: deriveOcKey(m.gameUrl),
        createdAt: m.createdAt,
        lastValidatedAt: m.lastValidatedAt,
        elementCount: Object.keys(reg).length,
        verifiedCount: verified,
        pendingCount: pending,
        rejectedCount: rejected,
      });
    } catch {
      // skip games with corrupt registry
    }
  }
  // Most recent first
  out.sort((a, b) => (b.lastValidatedAt ?? b.createdAt).localeCompare(a.lastValidatedAt ?? a.createdAt));
  return out;
}
