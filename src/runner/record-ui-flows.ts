/**
 * Phase 2.5 — Record UI Flows.
 *
 * Sau khi Generate sinh catalog + hybrid spec, identify các case `replay_or_vision`
 * (buy_feature, special_bet, ...). Mỗi case có instruction list LLM cần thực hiện.
 * Phase này:
 *   1. Mở browser (1 lần)
 *   2. Pre-game ready (1 lần — reuse pre-game recording nếu có)
 *   3. Với mỗi case chưa có recording:
 *      - executeCaseActionLLM(instructions) → click + record
 *      - Reload page reset state cho case kế (vì action có side-effect)
 *   4. Close browser
 *
 * Output: fixtures/case-actions/{slug}/{caseId}/recording.json + baseline.png
 *
 * Lần đầu chạy: tốn ~$0.10-0.30 per case (one-time, không lặp lại).
 * Run test sau đó: replay deterministic, $0.
 */

import { chromium, type Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strategyFor, type AvailableScenario, type MockStrategy } from "../ai/hybrid-case-mapper.js";
import type { TestCase, TestCaseCatalog } from "../ai/test-catalog.js";
import { listScenarios, loadScenario } from "./scenario.js";
import { preGameWithReplayOrVision } from "./pre-game-replay.js";
import { decidePreGameDismissal } from "../ai/vision.js";
import { getScreenshotStore } from "./screenshot-store.js";
import {
  caseBaselinePath,
  loadCaseRecording,
  saveCaseRecording,
  type CaseRecording,
  executeCaseActionLLM,
} from "./case-action.js";
import { tryParseBody, scoreSpinShape, shouldSkipUrl } from "./spin-detect.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VIEWPORT = { width: 1440, height: 900 };

export type RecordUiFlowsOpts = {
  slug: string;
  gameUrl: string;
  /** Force re-record dù file đã có. Default false. */
  overwrite?: boolean;
  /** Headless mode. Default false (visual debug — UI flow recording cần nhìn). */
  headless?: boolean;
  /** Skip pre-game (assume page đã ready). Default false. */
  skipPreGame?: boolean;
};

export type RecordUiFlowsResult = {
  totalCases: number;
  recorded: string[];
  skipped: { caseId: string; reason: string }[];
  failed: { caseId: string; reason: string }[];
  durationMs: number;
};

/**
 * Identify replay_or_vision cases từ catalog + scenarios available.
 * Returns array of { case, strategy } cho mỗi case cần record.
 */
function collectReplayCases(catalog: TestCaseCatalog, slug: string): Array<{
  testCase: TestCase;
  strategy: Extract<MockStrategy, { type: "replay_or_vision" }>;
}> {
  // Load scenarios (catalog driver)
  const names = listScenarios(slug);
  const availableScenarios: AvailableScenario[] = names.map((name) => {
    try {
      return { name, label: name, scenario: loadScenario(slug, name) };
    } catch {
      return null;
    }
  }).filter((x): x is AvailableScenario => x !== null);

  const out: Array<{ testCase: TestCase; strategy: Extract<MockStrategy, { type: "replay_or_vision" }> }> = [];
  for (const tc of catalog.cases) {
    const strategy = strategyFor(tc, availableScenarios, { slug });
    if (strategy.type === "replay_or_vision") {
      out.push({ testCase: tc, strategy });
    }
  }
  return out;
}

export async function recordUiFlows(opts: RecordUiFlowsOpts): Promise<RecordUiFlowsResult> {
  const t0 = Date.now();
  const catalogPath = join("fixtures/specs", opts.slug, `${opts.slug}.test-cases.json`);
  if (!existsSync(catalogPath)) {
    throw new Error(`Catalog not found: ${catalogPath}. Run Generate phase trước.`);
  }
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as TestCaseCatalog;
  const cases = collectReplayCases(catalog, opts.slug);

  console.log("================================================================");
  console.log(` PHASE 2.5: Record UI Flows — ${opts.slug}`);
  console.log(` Catalog cases: ${catalog.total_cases} total, ${cases.length} replay_or_vision`);
  console.log("================================================================");

  if (cases.length === 0) {
    console.log("[record-ui-flows] No replay_or_vision cases — skipping phase.");
    return { totalCases: 0, recorded: [], skipped: [], failed: [], durationMs: Date.now() - t0 };
  }

  // Filter cases already recorded (unless overwrite)
  const queue: Array<{ testCase: TestCase; strategy: Extract<MockStrategy, { type: "replay_or_vision" }> }> = [];
  const skipped: { caseId: string; reason: string }[] = [];
  for (const c of cases) {
    if (!opts.overwrite && loadCaseRecording(opts.slug, c.testCase.id)) {
      skipped.push({ caseId: c.testCase.id, reason: "recording_exists" });
      console.log(`[record-ui-flows] SKIP ${c.testCase.id} — already recorded`);
    } else {
      queue.push(c);
    }
  }

  if (queue.length === 0) {
    console.log(`[record-ui-flows] All ${cases.length} case(s) already recorded — skipping browser launch.`);
    return {
      totalCases: cases.length,
      recorded: [],
      skipped,
      failed: [],
      durationMs: Date.now() - t0,
    };
  }

  console.log(`[record-ui-flows] Recording ${queue.length} case(s)...`);

  const browser = await chromium.launch({
    headless: opts.headless ?? false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const recorded: string[] = [];
  const failed: { caseId: string; reason: string }[] = [];

  try {
    for (const { testCase, strategy } of queue) {
      console.log(`\n[record-ui-flows] === ${testCase.id} ===`);
      console.log(`  Category: ${testCase.category} | Severity: ${testCase.severity}`);
      console.log(`  Instructions:`);
      strategy.instructions.forEach((i, idx) => console.log(`    ${idx + 1}. ${i}`));

      const page: Page = await context.newPage();
      try {
        const tracker = attachSpinTracker(page);
        await page.goto(opts.gameUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2_000);

        if (!opts.skipPreGame) {
          const ready = await preGameWithReplayOrVision(page, {
            slug: opts.slug,
            viewport: VIEWPORT,
            label: `pregame-record-${testCase.id}`,
          });
          if (!ready.ready) {
            failed.push({ caseId: testCase.id, reason: `pre-game failed: ${ready.source}` });
            console.warn(`  ✗ pre-game không ready (${ready.source}) — skip case`);
            await page.close();
            continue;
          }
          if (testCase.category === "buy_feature" && isBuyFeaturePreconditionBroken(ready.details)) {
            const drained = await ensureBuyFeatureBaseState(page, {
              label: `buy-drain-${testCase.id}`,
              maxLoops: 16,
            });
            if (!drained.ok) {
              failed.push({ caseId: testCase.id, reason: drained.reason });
              console.warn(`  ✗ ${drained.reason} — skip recording để tránh baseline sai`);
              await page.close();
              continue;
            }
            console.log(`  [record-buy] ${drained.reason}`);
          }
        }

        const beforeCount = tracker.count();
        const result = await executeCaseActionLLM(page, {
          slug: opts.slug,
          caseId: testCase.id,
          instructions: strategy.instructions,
          viewport: VIEWPORT,
          saveAfter: false,
        });

        if (result.ok) {
          if (testCase.category === "buy_feature") {
            const quality = validateBuyFeatureRecording(result.clicks);
            if (!quality.ok) {
              failed.push({ caseId: testCase.id, reason: quality.reason });
              console.warn(`  ✗ ${quality.reason}`);
              continue;
            }
          }

          const settle = await waitForSpinSettlement(page, tracker, beforeCount, {
            startTimeoutMs: 20_000,
            quietMs: 4_000,
            maxTotalMs: 180_000,
          });
          console.log(
            `  [record-wait] ${settle.reason} (newSpinResponses=${settle.newResponses}, waitedMs=${settle.waitedMs})`,
          );

          const baselineBuf = await page.screenshot({ type: "png" });
          const baselineFile = caseBaselinePath(opts.slug, testCase.id);
          mkdirSync(dirname(baselineFile), { recursive: true });
          writeFileSync(baselineFile, baselineBuf);
          const rec: CaseRecording = {
            slug: opts.slug,
            case_id: testCase.id,
            recorded_at: new Date().toISOString(),
            instructions: strategy.instructions,
            clicks: result.clicks,
            baseline_png: baselineFile,
            max_diff_ratio: 0.05,
            viewport: VIEWPORT,
          };
          saveCaseRecording(rec);

          recorded.push(testCase.id);
          console.log(`  ✓ recorded ${result.clicks.length} click(s)`);
        } else {
          failed.push({ caseId: testCase.id, reason: result.reason });
          console.warn(`  ✗ failed: ${result.reason}`);
        }
      } catch (err) {
        failed.push({ caseId: testCase.id, reason: (err as Error).message });
        console.warn(`  ✗ exception: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const durationMs = Date.now() - t0;
  console.log("\n================================================================");
  console.log(` PHASE 2.5 DONE — ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Recorded: ${recorded.length}  |  Skipped: ${skipped.length}  |  Failed: ${failed.length}`);
  console.log("================================================================");

  return {
    totalCases: cases.length,
    recorded,
    skipped,
    failed,
    durationMs,
  };
}

type SpinTracker = {
  count: () => number;
  lastSeenAt: () => number;
};

function attachSpinTracker(page: Page): SpinTracker {
  let seen = 0;
  let lastAt = Date.now();
  page.on("response", async (resp) => {
    try {
      const req = resp.request();
      const method = req.method();
      const url = resp.url();
      if (method !== "POST" && method !== "GET") return;
      if (shouldSkipUrl(url)) return;
      const body = await resp.text();
      if (!body) return;
      const parsed = tryParseBody(body);
      if (!parsed) return;
      if (scoreSpinShape(parsed) < 5) return;
      seen++;
      lastAt = Date.now();
    } catch {
      // Ignore response parsing errors during tracking.
    }
  });
  return {
    count: () => seen,
    lastSeenAt: () => lastAt,
  };
}

async function waitForSpinSettlement(
  page: Page,
  tracker: SpinTracker,
  beforeCount: number,
  opts: { startTimeoutMs: number; quietMs: number; maxTotalMs: number },
): Promise<{ reason: string; newResponses: number; waitedMs: number }> {
  const t0 = Date.now();
  const startDeadline = t0 + opts.startTimeoutMs;
  const hardDeadline = t0 + opts.maxTotalMs;

  while (Date.now() < startDeadline) {
    if (tracker.count() > beforeCount) break;
    await page.waitForTimeout(300);
  }

  while (Date.now() < hardDeadline) {
    const newResponses = tracker.count() - beforeCount;
    if (newResponses > 0 && Date.now() - tracker.lastSeenAt() >= opts.quietMs) {
      return { reason: "settled", newResponses, waitedMs: Date.now() - t0 };
    }
    await page.waitForTimeout(400);
  }

  return {
    reason: tracker.count() > beforeCount ? "timeout_after_activity" : "no_spin_activity",
    newResponses: Math.max(0, tracker.count() - beforeCount),
    waitedMs: Date.now() - t0,
  };
}

function isBuyFeaturePreconditionBroken(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const visible = (details as { lastVisibleElements?: unknown }).lastVisibleElements;
  if (!Array.isArray(visible)) return false;
  const set = new Set(visible.map((v) => String(v).toLowerCase()));
  return set.has("free_spins_counter") || set.has("free_spin_counter") || set.has("bonus_active");
}

function validateBuyFeatureRecording(clicks: Array<{ reason?: string }>): { ok: boolean; reason: string } {
  if (clicks.length < 2) {
    return { ok: false, reason: `buy_feature recording rejected: too few clicks (${clicks.length})` };
  }
  const reasons = clicks.map((c) => String(c.reason ?? "").toLowerCase()).join(" | ");
  const hasBuy = reasons.includes("buy");
  const hasConfirm = reasons.includes("confirm") || reasons.includes("yes");
  if (!hasBuy || !hasConfirm) {
    return {
      ok: false,
      reason: `buy_feature recording rejected: missing buy/confirm intent in click reasons (reasons=${reasons || "n/a"})`,
    };
  }
  return { ok: true, reason: "ok" };
}

async function ensureBuyFeatureBaseState(
  page: Page,
  opts: { label: string; maxLoops: number },
): Promise<{ ok: boolean; reason: string }> {
  const store = getScreenshotStore();
  for (let i = 0; i < opts.maxLoops; i++) {
    const shot = await store.take(page, `${opts.label}-${String(i).padStart(2, "0")}`);
    const decision = await decidePreGameDismissal({
      screenshotPath: shot,
      viewport: VIEWPORT,
      iteration: i,
      dismissedSoFar: 0,
    });
    const active = new Set((decision.visible_elements ?? []).map((v) => String(v).toLowerCase()));
    const inFreeSpin = active.has("free_spins_counter") || active.has("free_spin_counter") || /free\s*spin/i.test(decision.reason);
    if (!inFreeSpin) {
      return { ok: true, reason: `returned to base state after ${i} loop(s)` };
    }

    // During active free spins, click the main spin/continue button to advance chain.
    if (decision.spin_button_bbox) {
      const cx = Math.round(decision.spin_button_bbox.x + decision.spin_button_bbox.w / 2);
      const cy = Math.round(decision.spin_button_bbox.y + decision.spin_button_bbox.h / 2);
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(80);
      await page.mouse.click(cx, cy);
    }
    await page.waitForTimeout(2_500);
  }
  return { ok: false, reason: `buy_feature precondition failed: free spins remained active after ${opts.maxLoops} drain loops` };
}

// ===== CLI entry =====
async function main() {
  const args = process.argv.slice(2);
  const slug = args[0];
  if (!slug) {
    console.error("Usage: tsx src/runner/record-ui-flows.ts <slug> [--overwrite] [--headless]");
    console.error("  Requires GAME_URL env var.");
    process.exit(1);
  }
  const gameUrl = process.env.GAME_URL;
  if (!gameUrl) {
    console.error("GAME_URL env var required (full URL with token).");
    process.exit(1);
  }
  const overwrite = args.includes("--overwrite");
  const headless = args.includes("--headless");
  try {
    const result = await recordUiFlows({ slug, gameUrl, overwrite, headless });
    console.log("\nResult:", JSON.stringify(result, null, 2));
    if (result.failed.length > 0) process.exit(1);
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
