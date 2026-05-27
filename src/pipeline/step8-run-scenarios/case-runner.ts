// Case runner — orchestrates all AI-catalog cases:
//   1. Load test-cases.json + test-cases.actions.json (translation cache)
//   2. For each case: reset state → execute → record result
//   3. Aggregate pass/fail/skip summary
//
// Calling once per orchestrator run. Cases run sequentially (concurrency 1)
// because they share the same browser session and need clean state.

import type { Page } from "playwright";
import { initPreGame } from "../step3-smoke/pregame-init.js";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { UiRegistry } from "../registry/types.js";
import { executeCase, type CaseResult } from "./case-executor.js";
import {
  translateAllCases,
  type CaseActionsCache,
} from "../step7-testcase-gen/case-action-translator.js";

export type CaseRunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  cases: CaseResult[];
};

export type CaseRunnerContext = {
  page: Page;
  gameSlug: string;
  uiMap: UiRegistry;
  parser: BaseParser;
  /** Reload + pregame replay between cases for clean state. Default true. */
  resetBetweenCases?: boolean;
};

export type CatalogCase = {
  id: string;
  name: string;
  category: string;
  severity: "critical" | "major" | "minor";
  setup_instructions?: string;
  custom_assertions?: Array<{ id: string; description: string; check_code: string }>;
};

export async function runAllCases(
  ctx: CaseRunnerContext,
  cases: CatalogCase[],
): Promise<CaseRunSummary> {
  const startAll = Date.now();
  const results: CaseResult[] = [];

  // Translate all cases ahead of time (AI calls cached per case).
  const cache = await translateAllCases(ctx.gameSlug, cases, ctx.uiMap);

  // Attach a balance tracker once so we can pass priorBalance to each case.
  // Listens for any response containing balance / balance_cash (PP doInit,
  // doSpin, reloadBalance). Used to fill spin.balanceBefore when null.
  let lastBalance: number | null = null;
  ctx.page.on("response", async (res) => {
    try {
      const url = res.url();
      if (!/gameService|reloadBalance|gs2c/i.test(url)) return;
      const body = await res.text().catch(() => "");
      if (!body) return;
      const cashMatch = body.match(/(?:^|&)balance_cash=([\d.]+)/);
      const balMatch = body.match(/(?:^|&)balance=([\d.]+)/);
      const captured = cashMatch ? Number(cashMatch[1]) : balMatch ? Number(balMatch[1]) : null;
      if (captured !== null && Number.isFinite(captured)) {
        lastBalance = captured;
      }
    } catch {
      // ignore
    }
  });

  const resetBetween = ctx.resetBetweenCases !== false;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const translated = cache.cases[c.id];
    if (!translated) {
      results.push(skipResult(c, "translation missing"));
      continue;
    }

    // Reset to clean state between cases (after the first).
    if (i > 0 && resetBetween) {
      try {
        await ctx.page.reload({ waitUntil: "load" });
        await initPreGame(ctx.page, ctx.gameSlug);
        // Settle: game assets load + spin button becomes interactive. Skip
        // this and clicks may hit a non-ready spin button → no server call.
        await ctx.page.waitForTimeout(3000);
      } catch (err) {
        // Reset failure isn't fatal — case may still run from current state.
        console.warn(`[case-runner] reset failed for case ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result = await executeCase(
      {
        page: ctx.page,
        uiMap: ctx.uiMap,
        parser: ctx.parser,
        priorBalance: lastBalance,
      },
      {
        id: c.id,
        name: c.name,
        category: c.category,
        severity: c.severity,
        custom_assertions: c.custom_assertions,
        actions: translated.actions,
        skipReason: translated.skipReason,
      },
    );
    results.push(result);
    console.log(
      `[case-runner] ${i + 1}/${cases.length} ${c.id} → ${result.status}${result.skipReason ? ` (${result.skipReason})` : ""}`,
    );
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  return {
    total: cases.length,
    passed,
    failed,
    skipped,
    totalDurationMs: Date.now() - startAll,
    cases: results,
  };
}

function skipResult(c: CatalogCase, reason: string): CaseResult {
  return {
    caseId: c.id,
    name: c.name,
    category: c.category,
    severity: c.severity,
    status: "skip",
    skipReason: reason,
    actionsExecuted: 0,
    assertions: [],
    spin: null,
    durationMs: 0,
  };
}

export { type CaseActionsCache };
