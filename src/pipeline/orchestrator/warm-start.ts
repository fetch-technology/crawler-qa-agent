import path from "node:path";
import { openBrowser, closeBrowser } from "./browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { validateRegistry } from "../step2-5-validate-registry/validator.js";
import { initPreGame } from "../step3-smoke/pregame-init.js";
import { startCapture } from "../step3-capture-network/recorder.js";
import "../step6-build-model/index.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import {
  ApiResponseShapeRule,
  FinancialRule,
  RuleEngine,
} from "../step9-verify/index.js";
import { loadAiCatalog } from "../step7-testcase-gen/ai-catalog.js";
import { runMassiveSpins } from "../step8-run-scenarios/runner.js";
import { detectCascade } from "../step8-run-scenarios/detect-cascade.js";
import { aggregate } from "../step10-statistical/aggregator.js";
import { generateReport } from "../step11-report/index.js";
import { apiMapping } from "../registry/api-mapping.js";
import { parserCache } from "../registry/parser-cache.js";
import { providerCache } from "../registry/provider-cache.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta, touchValidated } from "../registry/meta.js";
import { recovery } from "./recovery.js";
import type { PipelineOptions, PipelineResult } from "./types.js";

export async function warmStart(opts: PipelineOptions): Promise<PipelineResult> {
  if (!opts.gameSlug) throw new Error("warmStart requires gameSlug");
  const slug = opts.gameSlug;

  const m = await meta.load(slug);
  const url = opts.url ?? m?.gameUrl;
  if (!url) throw new Error(`No gameUrl in registry for ${slug} and none provided`);

  // Headless by default; set QA_HEADLESS=0 to see the browser for debugging.
  const session = await openBrowser(process.env.QA_HEADLESS !== "0");
  try {
    const crawlResult = await crawl(session.page, { gameUrl: url, gameSlug: slug });

    // Pre-game init (Tier 4 #14) — REPLAY recorded clicks if available,
    // skipping ~30s of vision iteration. Falls through to fresh dismiss if
    // recording missing / baseline drifted.
    const pregame = await initPreGame(session.page, slug);
    console.log(
      `[pregame] mode=${pregame.mode} clicks=${pregame.clicks} ms=${pregame.durationMs}${pregame.reason ? ` reason="${pregame.reason}"` : ""}`,
    );

    const uiMap = await uiRegistry.load(slug);
    const validation = await validateRegistry(session.page, uiMap, { gameSlug: slug });
    if (!validation.ok) {
      await closeBrowser(session);
      return recovery(slug, validation.invalidEntries, opts);
    }
    await touchValidated(slug);

    const provider = await providerCache.load(slug);
    const parser = await createParserForGame(slug);
    const api = await apiMapping.load(slug);

    // Load AI-generated catalog (cached from cold-start) and wire custom
    // assertions so warm-start verifies the SAME invariants cold-start does.
    // Without this, generated test-cases.json exists but is never evaluated.
    const aiCatalog = await loadAiCatalog(slug);
    // Rules for the massive-spin sampling loop. Only PER-SPIN invariant
    // rules apply — rules that need playthrough context (FreeSpinNoDeduct,
    // StateTransition, CustomAssertion) belong to case-runner, not to
    // statistical sampling.
    //
    // Why FreeSpinNoDeductRule is excluded:
    //   simulate.ts fires THE SAME captured template doSpin N times. Each
    //   replay deducts coin (real `c=` in request body). Server, tracking
    //   session state independently, may RESPOND with `fs>0` (free spin
    //   counter) — but balance is still deducted because the request asked
    //   for a bet. In production a real free-spin chain uses different
    //   request shape (or auto-play server-side) with no deduction. Running
    //   FreeSpinNoDeductRule against simulate output → 100% false-positive
    //   "free spin deducted bet" on every fs>0 sample. Verified empirically:
    //   spin-051-response shows fs=1, balance dropped 0.50 (= bet).
    //
    // Why StateTransitionRule is excluded:
    //   massive-spin samples are independent replays — there's no "chain"
    //   to transition through. Each sample's state is determined by server's
    //   response in isolation. NORMAL→FREE_SPIN→NORMAL across consecutive
    //   replays isn't a "transition" in the playthrough sense, just random
    //   sampling of states.
    const ruleSet: import("../step9-verify/rule.js").Rule[] = [
      new FinancialRule(),
      new ApiResponseShapeRule(),
    ];
    if (aiCatalog && aiCatalog.cases.length > 0) {
      console.log(`[step9/catalog] ${aiCatalog.cases.length} catalog cases loaded → applied only via case-runner, NOT against massive-spin samples`);
    } else {
      console.log(`[step9/catalog] no test-cases.json found`);
    }
    const engine = new RuleEngine(ruleSet);

    // Execute each AI catalog case as a scenario (Tier-3 feature).
    let caseRun: import("../step8-run-scenarios/case-runner.js").CaseRunSummary | undefined;
    if (
      process.env.QA_RUN_CASES !== "0" &&
      aiCatalog &&
      aiCatalog.cases.length > 0 &&
      uiMap
    ) {
      const { runAllCases } = await import("../step8-run-scenarios/case-runner.js");
      try {
        caseRun = await runAllCases(
          { page: session.page, gameSlug: slug, uiMap, parser },
          aiCatalog.cases as import("../step8-run-scenarios/case-runner.js").CatalogCase[],
        );
        console.log(
          `[warm/cases] ${caseRun.passed} pass / ${caseRun.failed} fail / ${caseRun.skipped} skip in ${(caseRun.totalDurationMs / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.warn(
          `[warm/cases] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Cascade detection: no fresh rounds in warm-start path. detectCascade
    // falls back to loading the pipeline-captured network.jsonl from registry
    // so it stays accurate even when provider-cache.json is mis-classified
    // (e.g. vswaysmahwin2 saved as "Generic" but emits na=c cascade tails).
    const cascade = detectCascade(null, provider?.provider ?? null, { slug });
    if (cascade) console.log(`[step8] cascade game detected → simulate will fetch doCollect tails`);
    const massive = await runMassiveSpins(
      {
        gameSlug: slug,
        page: session.page,
        uiMap: uiMap ?? undefined,
        capture: startCapture(session.page),
        api: api ?? undefined,
        parser,
        cascade,
      },
      { count: opts.spinCount ?? 100, mode: opts.spinMode },
    );

    let prevBalance: number | null = null;
    let prevState: import("../step6-build-model/normalized.js").SpinState | null = null;
    massive.spins.forEach((spin, roundIndex) => {
      engine.evaluate(spin, {
        previousBalance: prevBalance,
        previousState: prevState,
        roundIndex,
      });
      prevBalance = spin.balanceAfter;
      prevState = spin.state;
    });

    const stats = aggregate(massive.spins);

    const outDir =
      opts.outDir ??
      path.join("fixtures", "test-runs", new Date().toISOString().replace(/[:.]/g, "-"));

    const report = await generateReport(
      {
        crawl: {
          ...crawlResult,
          provider: provider?.provider ?? crawlResult.provider,
        },
        rules: engine.summary(),
        massive,
        stats,
        caseRun,
      },
      { outDir, generatePdf: opts.generatePdf },
    );

    return { mode: "warm", gameSlug: slug, report };
  } finally {
    await closeBrowser(session);
  }
}
