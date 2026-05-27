/**
 * Case action recorder + replay — extend pre-game-replay pattern sang test
 * case flow (vd buy_feature: click Buy → confirm; special_bet: click Ante toggle).
 *
 * Workflow:
 *   1st run (LLM-driven):
 *     - executeInstructionsLLM(page, instructions[]) chạy từng step
 *     - Mỗi step: askClaude với screenshot → return {x,y,done}
 *     - Capture click coord + final screenshot vào fixtures/case-actions/{slug}/{caseId}/
 *
 *   2nd+ run (replay):
 *     - replayCaseAction(page, slug, caseId) load click sequence
 *     - Re-fire clicks deterministic
 *     - Pixel diff final screenshot vs baseline → ok/fail
 *     - On fail → caller fallback LLM + auto-heal (re-capture)
 *
 * File layout: fixtures/case-actions/{slug}/{caseId}/
 *   ├─ recording.json   (clicks + checkpoints + meta)
 *   └─ baseline.png     (final screen state — for pixel diff)
 */

import type { Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { askClaude } from "../ai/claude.js";
import { transcribePlayScreenValues } from "../ai/vision.js";
import { applyMask, loadMaskRegions } from "./region-snapshot.js";

const RECORDINGS_DIR = "fixtures/case-actions";

const BET_CASE_EXPECTED: Record<string, number> = {
  "bet-min-total": 0.2,
  "bet-low-tier": 1,
  "bet-mid-tier": 50,
  "bet-high-tier": 500,
  "bet-max-total": 1000,
  "bet-level-min": 4,
  "bet-level-max": 40,
};

function isBetCase(caseId: string): boolean {
  return /^bet-/i.test(caseId);
}

function isBottomBarMaskRegion(r: { y: number; height: number; label?: string }): boolean {
  if (String(r.label ?? "").toLowerCase() === "bottom_bar") return true;
  return r.y >= 700 || r.y + r.height >= 840;
}

function inferExpectedBetFromInstructions(caseId: string, instructions: string[]): number | null {
  const fromMap = BET_CASE_EXPECTED[caseId];
  if (typeof fromMap === "number") return fromMap;

  const text = instructions.join(" ");
  const patterns = [
    /(?:bet\s+display\s+reads?|verify\s+the\s+bet\s+display\s+reads?)\s*['\"]?\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\(\s*~?\$\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

function inferBetTolerance(expected: number): number {
  return Math.max(0.06, expected * 0.005);
}

function buildSpecialBetRecoveryInstructions(expected: number): string[] {
  return [
    "Open the Special Bets panel or toggle on the main game screen.",
    `Select the special bet option priced exactly ${expected}.`,
    "Verify Special Bets mode is ON/active and the chosen option is highlighted.",
    "Close any open panel and keep the game on the main play screen.",
  ];
}

function shouldTrySpecialBetSemantic(args: {
  caseId: string;
  instructions: string[];
  expected: number;
}): boolean {
  if (args.expected >= 500) return true;
  const text = `${args.caseId} ${args.instructions.join(" ")}`.toLowerCase();
  return /special\s*bet|ante\s*bet|super\s*spin|double\s*chance/.test(text);
}

function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced?.[1]?.trim() ?? trimmed;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return src.slice(start, end + 1);
}

async function semanticVerifySpecialBetSelection(args: {
  screenshotBase64: string;
  expected: number;
}): Promise<{ ok: boolean; reason: string; actual: number | null }> {
  try {
    const raw = await askClaude({
      system: "You inspect slot game screenshots and return compact JSON.",
      content: [
        {
          type: "text",
          text:
            `Check whether SPECIAL BET mode appears selected/active in this slot screenshot.\n` +
            `Target amount is ${args.expected}.\n` +
            `Return JSON only:\n` +
            `{"special_mode_active": boolean, "detected_amount": number|null, "evidence": string}`,
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: args.screenshotBase64 },
        },
      ],
      label: "case-action/special-bet-semantic",
      maxTurns: 1,
      timeoutMs: Number(process.env.QA_CASE_ACTION_SPECIAL_VERIFY_TIMEOUT_MS ?? 25_000),
    });
    const obj = extractFirstJsonObject(raw);
    if (!obj) {
      return { ok: false, reason: "special_semantic_no_json", actual: null };
    }
    const parsed = JSON.parse(obj) as {
      special_mode_active?: unknown;
      detected_amount?: unknown;
      evidence?: unknown;
    };
    const active = Boolean(parsed.special_mode_active);
    const actual =
      typeof parsed.detected_amount === "number" && Number.isFinite(parsed.detected_amount)
        ? parsed.detected_amount
        : null;
    const tol = inferBetTolerance(args.expected);
    const amountOk = actual != null ? Math.abs(actual - args.expected) <= tol : false;
    if (active && amountOk) {
      return {
        ok: true,
        reason: `special_semantic_ok expected=${args.expected} actual=${actual} tol=${tol}`,
        actual,
      };
    }
    const evidence =
      typeof parsed.evidence === "string" && parsed.evidence.trim()
        ? parsed.evidence.trim().slice(0, 140)
        : "insufficient evidence";
    return {
      ok: false,
      reason: `special_semantic_mismatch expected=${args.expected} actual=${actual ?? "null"} active=${active} evidence=${evidence}`,
      actual,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `special_semantic_error: ${(err as Error).message}`,
      actual: null,
    };
  }
}

async function semanticVerifyBetDisplay(args: {
  page: Page;
  slug: string;
  caseId: string;
  instructions: string[];
}): Promise<{ ok: boolean; reason: string; expected: number | null; actual: number | null }> {
  const expected = inferExpectedBetFromInstructions(args.caseId, args.instructions);
  if (expected == null) {
    return {
      ok: true,
      reason: "semantic_verify_skipped_no_expected_bet",
      expected: null,
      actual: null,
    };
  }

  try {
    const outDir = caseRecordingDir(args.slug, args.caseId);
    mkdirSync(outDir, { recursive: true });
    const screenshotPath = join(outDir, "semantic-bet-check.png");
    const png = await args.page.screenshot({ type: "png" });
    writeFileSync(screenshotPath, png);

    const screen = await transcribePlayScreenValues({ screenshotPath });
    const actual = typeof screen?.bet === "number" && Number.isFinite(screen.bet) ? screen.bet : null;
    if (actual == null) {
      if (shouldTrySpecialBetSemantic({ caseId: args.caseId, instructions: args.instructions, expected })) {
        const special = await semanticVerifySpecialBetSelection({
          screenshotBase64: png.toString("base64"),
          expected,
        });
        if (special.ok) {
          return {
            ok: true,
            reason: `${special.reason}; base_semantic_bet_unreadable`,
            expected,
            actual: special.actual,
          };
        }
      }
      return {
        ok: false,
        reason: `semantic_verify_no_ui_bet (expected=${expected})`,
        expected,
        actual: null,
      };
    }
    const tol = inferBetTolerance(expected);
    const delta = Math.abs(actual - expected);
    if (delta > tol && shouldTrySpecialBetSemantic({ caseId: args.caseId, instructions: args.instructions, expected })) {
      const special = await semanticVerifySpecialBetSelection({
        screenshotBase64: png.toString("base64"),
        expected,
      });
      if (special.ok) {
        return {
          ok: true,
          reason: `${special.reason}; base_semantic_actual=${actual}`,
          expected,
          actual: special.actual,
        };
      }
      return {
        ok: false,
        reason:
          `semantic_verify_bet_mismatch expected=${expected} actual=${actual} tol=${tol}; ` +
          special.reason,
        expected,
        actual,
      };
    }
    return {
      ok: delta <= tol,
      reason:
        delta <= tol
          ? `semantic_verify_ok expected=${expected} actual=${actual} tol=${tol}`
          : `semantic_verify_bet_mismatch expected=${expected} actual=${actual} tol=${tol}`,
      expected,
      actual,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `semantic_verify_error: ${(err as Error).message}`,
      expected,
      actual: null,
    };
  }
}

export type CaseClick = {
  x: number;
  y: number;
  /** Delay (ms) since previous click. First click = ms since action start. */
  delay_ms: number;
  /** Short label cho debug — vd "ante bet toggle", "confirm buy". */
  reason: string;
  /** Optional step index (mapped 1:1 với instructions). */
  step?: number;
};

export type CaseRecording = {
  slug: string;
  case_id: string;
  recorded_at: string;
  /** Original instruction list (free-form English/Vietnamese — fed to LLM). */
  instructions: string[];
  /** Per-click sequence. */
  clicks: CaseClick[];
  /** Final screen baseline cho pixel diff verify (PNG full viewport). */
  baseline_png: string; // path relative to repo root
  /** Pixel diff threshold ratio. Default 0.05 (5% — looser than pre-game 2%
   *  because case state có thể có balance/timer drift). */
  max_diff_ratio: number;
  viewport: { width: number; height: number };
};

export function caseRecordingDir(slug: string, caseId: string): string {
  return join(RECORDINGS_DIR, slug, caseId);
}
export function caseRecordingPath(slug: string, caseId: string): string {
  return join(caseRecordingDir(slug, caseId), "recording.json");
}
export function caseBaselinePath(slug: string, caseId: string): string {
  return join(caseRecordingDir(slug, caseId), "baseline.png");
}

export function loadCaseRecording(slug: string, caseId: string): CaseRecording | null {
  const path = caseRecordingPath(slug, caseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CaseRecording;
  } catch (err) {
    console.warn(`[case-action] load failed ${path}:`, (err as Error).message);
    return null;
  }
}

export function saveCaseRecording(rec: CaseRecording): string {
  const path = caseRecordingPath(rec.slug, rec.case_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rec, null, 2));
  return path;
}

// ============================================================================
// LLM step decision — find click target on current screen given instruction
// ============================================================================

const STEP_DECISION_SCHEMA = `Output JSON only, no prose:
{
  "x": <integer 0..viewport.width>,
  "y": <integer 0..viewport.height>,
  "done": <boolean — true nếu instruction đã hoàn thành chỉ qua observation, false nếu cần click tiếp>,
  "reason": "<2-10 từ mô tả element cần click>"
}`;

async function decideClickForInstruction(args: {
  screenshotBase64: string;
  instruction: string;
  stepIdx: number;
  totalSteps: number;
  viewport: { width: number; height: number };
}): Promise<{ x: number; y: number; done: boolean; reason: string }> {
  const prompt = `You are guiding a Playwright test of a slot game canvas.

Step ${args.stepIdx + 1}/${args.totalSteps}: "${args.instruction}"

Viewport: ${args.viewport.width}×${args.viewport.height} pixels.

Look at the screenshot. Decide:
  1. If a click is needed to complete this step → return x,y of the element to click + done=false
  2. If the step is ALREADY visible/completed on screen (vd toggle already on) → return x=0,y=0,done=true

${STEP_DECISION_SCHEMA}`;

  const raw = await askClaude({
    system: "You guide canvas slot game tests by returning click coordinates as JSON.",
    content: [
      { type: "text", text: prompt },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: args.screenshotBase64 },
      },
    ],
    label: `case-action step ${args.stepIdx + 1}`,
  });
  // Naive extract — find first {...} block
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`case-action: LLM did not return JSON. Raw: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]) as { x?: number; y?: number; done?: boolean; reason?: string };
  return {
    x: Math.round(Number(parsed.x ?? 0)),
    y: Math.round(Number(parsed.y ?? 0)),
    done: Boolean(parsed.done),
    reason: String(parsed.reason ?? args.instruction).slice(0, 100),
  };
}

// ============================================================================
// LLM-driven execution (1st run) — record clicks + baseline
// ============================================================================

export type ExecuteCaseActionResult = {
  ok: boolean;
  clicks: CaseClick[];
  reason: string;
};

async function persistCaseRecording(
  page: Page,
  opts: { slug: string; caseId: string; instructions: string[]; viewport: { width: number; height: number } },
  clicks: CaseClick[],
): Promise<void> {
  const baselineBuf = await page.screenshot({ type: "png" });
  const baselineFile = caseBaselinePath(opts.slug, opts.caseId);
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, baselineBuf);
  const rec: CaseRecording = {
    slug: opts.slug,
    case_id: opts.caseId,
    recorded_at: new Date().toISOString(),
    instructions: opts.instructions,
    clicks,
    baseline_png: baselineFile,
    max_diff_ratio: 0.05,
    viewport: opts.viewport,
  };
  saveCaseRecording(rec);
  console.log(
    `[case-action] ★ Recorded ${clicks.length} click(s) + baseline → ${caseRecordingPath(opts.slug, opts.caseId)}`,
  );
}

export async function executeCaseActionLLM(
  page: Page,
  opts: {
    slug: string;
    caseId: string;
    instructions: string[];
    viewport: { width: number; height: number };
    /** Wait ms after each click before next step. Default 1500ms. */
    postClickWaitMs?: number;
    /** Save recording after success. Default true. */
    saveAfter?: boolean;
  },
): Promise<ExecuteCaseActionResult> {
  const postClickWait = opts.postClickWaitMs ?? 1500;
  const clicks: CaseClick[] = [];
  const tStart = Date.now();
  let lastClickTime = tStart;

  for (let i = 0; i < opts.instructions.length; i++) {
    const instruction = opts.instructions[i]!;
    // Snapshot before decision
    const shot = await page.screenshot({ type: "png" });
    const decision = await decideClickForInstruction({
      screenshotBase64: shot.toString("base64"),
      instruction,
      stepIdx: i,
      totalSteps: opts.instructions.length,
      viewport: opts.viewport,
    });
    console.log(
      `[case-action] step ${i + 1}/${opts.instructions.length}: "${instruction}" → ${decision.done ? "ALREADY-DONE" : `click (${decision.x},${decision.y})`} — ${decision.reason}`,
    );
    if (decision.done) continue;
    if (decision.x <= 0 || decision.y <= 0) {
      return {
        ok: false,
        clicks,
        reason: `step ${i + 1}: LLM returned invalid coord (${decision.x},${decision.y})`,
      };
    }
    try {
      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(80);
      await page.mouse.click(decision.x, decision.y);
      clicks.push({
        x: decision.x,
        y: decision.y,
        delay_ms: Date.now() - lastClickTime,
        reason: decision.reason,
        step: i,
      });
      lastClickTime = Date.now();
      await page.waitForTimeout(postClickWait);
    } catch (err) {
      return {
        ok: false,
        clicks,
        reason: `step ${i + 1} click failed: ${(err as Error).message}`,
      };
    }
  }

  if (opts.saveAfter !== false) {
    await persistCaseRecording(page, opts, clicks);
  }

  return { ok: true, clicks, reason: "llm_executed" };
}

// ============================================================================
// Deterministic replay (subsequent runs) — re-fire clicks + pixel diff
// ============================================================================

export type ReplayCaseResult = {
  ok: boolean;
  clicksFired: number;
  verifyDiffRatio: number | null;
  reason: string;
};

export async function replayCaseAction(
  page: Page,
  opts: { slug: string; caseId: string; skipVerify?: boolean },
): Promise<ReplayCaseResult> {
  const rec = loadCaseRecording(opts.slug, opts.caseId);
  if (!rec) {
    return { ok: false, clicksFired: 0, verifyDiffRatio: null, reason: "no_recording" };
  }
  console.log(
    `[case-action-replay] ${opts.slug}/${opts.caseId}: ${rec.clicks.length} click(s) (recorded ${rec.recorded_at})`,
  );
  let fired = 0;
  for (const click of rec.clicks) {
    if (fired > 0 && click.delay_ms > 0) {
      await page.waitForTimeout(Math.min(click.delay_ms, 10_000));
    }
    try {
      await page.mouse.move(click.x, click.y);
      await page.waitForTimeout(80);
      await page.mouse.click(click.x, click.y);
      fired++;
      console.log(
        `[case-action-replay] click ${fired}/${rec.clicks.length} @ (${click.x},${click.y}) — ${click.reason}`,
      );
    } catch (err) {
      return {
        ok: false,
        clicksFired: fired,
        verifyDiffRatio: null,
        reason: `click_failed: ${(err as Error).message}`,
      };
    }
    await page.waitForTimeout(1000);
  }

  if (opts.skipVerify) {
    return { ok: true, clicksFired: fired, verifyDiffRatio: null, reason: "skipped_verify" };
  }
  if (!existsSync(rec.baseline_png)) {
    return {
      ok: false,
      clicksFired: fired,
      verifyDiffRatio: null,
      reason: `baseline_missing: ${rec.baseline_png}`,
    };
  }
  // Final state pixel diff
  await page.waitForTimeout(500); // let animations settle
  const actualBuf = await page.screenshot({ type: "png" });
  const actual = PNG.sync.read(actualBuf);
  const baseline = PNG.sync.read(readFileSync(rec.baseline_png));
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      ok: false,
      clicksFired: fired,
      verifyDiffRatio: null,
      reason: `viewport_size_mismatch: actual=${actual.width}x${actual.height} baseline=${baseline.width}x${baseline.height}`,
    };
  }
  // Apply mask cho cả 2 — loại volatile area (reels random / balance/win text).
  // Baseline = full viewport screenshot → mask coord absolute viewport space.
  const fullMask = loadMaskRegions(opts.slug);
  // Bet cases must validate bottom display; do not mask bottom bar or replay can false-pass.
  const mask = isBetCase(opts.caseId)
    ? fullMask.filter((r) => !isBottomBarMaskRegion(r))
    : fullMask;
  if (mask.length > 0) {
    applyMask(actual, mask);
    applyMask(baseline, mask);
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const diffPixels = pixelmatch(
    actual.data,
    baseline.data,
    diff.data,
    actual.width,
    actual.height,
    { threshold: 0.15 }, // looser per-pixel threshold (canvas anti-alias variance)
  );
  // Exclude masked area khỏi denominator.
  let maskedArea = 0;
  for (const r of mask) {
    const w = Math.max(0, Math.min(actual.width, Math.floor(r.x + r.width)) - Math.max(0, Math.floor(r.x)));
    const h = Math.max(0, Math.min(actual.height, Math.floor(r.y + r.height)) - Math.max(0, Math.floor(r.y)));
    maskedArea += w * h;
  }
  const effectivePixels = Math.max(1, actual.width * actual.height - maskedArea);
  const ratio = diffPixels / effectivePixels;
  const ok = ratio <= rec.max_diff_ratio;
  return {
    ok,
    clicksFired: fired,
    verifyDiffRatio: ratio,
    reason: ok
      ? "verified"
      : `pixel_diff: ${(ratio * 100).toFixed(2)}% > max=${(rec.max_diff_ratio * 100).toFixed(2)}%`,
  };
}

/**
 * Combined helper — try replay first, fall back to LLM execution + auto-heal.
 * Returns true on success regardless of path.
 */
export async function runCaseActionWithReplayOrVision(
  page: Page,
  opts: {
    slug: string;
    caseId: string;
    instructions: string[];
    viewport: { width: number; height: number };
  },
): Promise<{ source: "replay" | "vision" | "failed"; reason: string }> {
  const semanticEnabled = process.env.QA_CASE_ACTION_SEMANTIC_VERIFY !== "0";
  const needBetSemantic = semanticEnabled && isBetCase(opts.caseId);
  const expectedBet = needBetSemantic
    ? inferExpectedBetFromInstructions(opts.caseId, opts.instructions)
    : null;
  const canUseSpecialRecovery =
    expectedBet != null &&
    expectedBet >= 500 &&
    shouldTrySpecialBetSemantic({
      caseId: opts.caseId,
      instructions: opts.instructions,
      expected: expectedBet,
    });
  const specialRecoveryInstructions =
    canUseSpecialRecovery && expectedBet != null
      ? buildSpecialBetRecoveryInstructions(expectedBet)
      : opts.instructions;

  const replay = await replayCaseAction(page, { slug: opts.slug, caseId: opts.caseId });
  let replaySemanticFailedReason: string | null = null;
  if (replay.ok) {
    if (needBetSemantic) {
      const sem = await semanticVerifyBetDisplay({
        page,
        slug: opts.slug,
        caseId: opts.caseId,
        instructions: opts.instructions,
      });
      if (!sem.ok) {
        replaySemanticFailedReason = sem.reason;
        console.log(
          `[case-action] replay semantic check failed (${sem.reason}) — falling back to LLM execution`,
        );
      } else {
        return { source: "replay", reason: `${replay.reason}; ${sem.reason}` };
      }
    } else {
      return { source: "replay", reason: replay.reason };
    }
  }
  const replayFallbackReason = replay.ok
    ? `semantic_mismatch: ${replaySemanticFailedReason}`
    : replay.reason;
  console.log(`[case-action] replay failed (${replayFallbackReason}) — falling back to LLM execution`);

  if (needBetSemantic) {
    const maxAttempts = Math.max(1, Number(process.env.QA_CASE_ACTION_BET_VISION_RETRIES ?? 3));
    let lastReason = "vision_unknown";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log(`[case-action] retrying bet setup via vision (attempt ${attempt}/${maxAttempts})`);
      }
      const instructionsForAttempt =
        canUseSpecialRecovery && attempt > 1 ? specialRecoveryInstructions : opts.instructions;
      const vision = await executeCaseActionLLM(page, {
        slug: opts.slug,
        caseId: opts.caseId,
        instructions: instructionsForAttempt,
        viewport: opts.viewport,
        saveAfter: false,
      });
      if (!vision.ok) {
        lastReason = vision.reason;
        continue;
      }
      const sem = await semanticVerifyBetDisplay({
        page,
        slug: opts.slug,
        caseId: opts.caseId,
        instructions: opts.instructions,
      });
      if (sem.ok) {
        await persistCaseRecording(page, opts, vision.clicks);
        return {
          source: "vision",
          reason: `${vision.reason}; ${sem.reason}; attempt=${attempt}/${maxAttempts}`,
        };
      }
      lastReason = `vision_done_but_${sem.reason}`;
    }
    return { source: "failed", reason: lastReason };
  }

  const vision = await executeCaseActionLLM(page, {
    slug: opts.slug,
    caseId: opts.caseId,
    instructions: opts.instructions,
    viewport: opts.viewport,
    saveAfter: true,
  });
  if (vision.ok) {
    return { source: "vision", reason: vision.reason };
  }
  return { source: "failed", reason: vision.reason };
}
