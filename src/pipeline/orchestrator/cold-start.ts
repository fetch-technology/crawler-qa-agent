import path from "node:path";
import { openBrowser, closeBrowser } from "./browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { discoverUi } from "../step2-detect-ui/resolver.js";
import { captureBaselines } from "../step2-detect-ui/baseline-capture.js";
import { initPreGame } from "../step3-smoke/pregame-init.js";
import { discoverSubScreens } from "../step2-detect-ui/sub-screen-discover.js";
import { exploreUiGraph } from "../step2-detect-ui/graph-explorer.js";
import { uiGraphStore } from "../registry/ui-graph-store.js";
import { runSmokeSpins } from "../step3-smoke/smoke-spin.js";
import { startCapture } from "../step3-capture-network/recorder.js";
import { persistRounds } from "../step3-capture-network/storage.js";
import { dirForGame } from "../registry/paths.js";
import { discoverFeatures } from "../step4-feature-discovery/index.js";
import { extractRules } from "../step4-feature-discovery/extract-rules.js";
import { scoreCandidates } from "../step5-spin-api-detect/score.js";
import {
  rankWithAi,
  AI_FALLBACK_HEURISTIC_THRESHOLD,
} from "../step5-spin-api-detect/ai-rank.js";
import "../step6-build-model/index.js";
import { pickParser } from "../step6-build-model/registry.js";
import { generateTestcases, toYaml } from "../step7-testcase-gen/index.js";
import { generateAiCatalog } from "../step7-testcase-gen/ai-catalog.js";
import {
  ApiResponseShapeRule,
  FinancialRule,
  RuleEngine,
} from "../step9-verify/index.js";
import { verifyHistory, type HistoryVerifyResult } from "../step9-verify/history-verifier.js";
import { verifyUi, type UiVerifyResult } from "../step9-verify/ui-verifier.js";
import { runMassiveSpins } from "../step8-run-scenarios/runner.js";
import { detectCascade } from "../step8-run-scenarios/detect-cascade.js";
import { phaseStart, phaseEnd } from "../step8-run-scenarios/event-emitter.js";
import { aggregate } from "../step10-statistical/aggregator.js";
import { dedupByRoundId } from "../step10-statistical/dedup.js";
import { extractScenarios } from "../step10-statistical/scenario-extractor.js";
import { runPreflight, formatPreflightResult } from "../step6-build-model/preflight.js";
import { buildExecutionStrategy } from "../step6-build-model/execution-strategy.js";
import { generateReport } from "../step11-report/index.js";
import { apiMapping } from "../registry/api-mapping.js";
import { initMeta } from "../registry/meta.js";
import { parserCache } from "../registry/parser-cache.js";
import { providerCache } from "../registry/provider-cache.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { testcases as testcasesStore } from "../registry/testcases.js";
import { uiRegistry } from "../registry/ui-registry.js";
import type { PipelineOptions, PipelineResult } from "./types.js";

export async function coldStart(opts: PipelineOptions): Promise<PipelineResult> {
  if (!opts.url) throw new Error("coldStart requires opts.url");
  // Headless by default; set QA_HEADLESS=0 to see the browser for debugging.
  const session = await openBrowser(process.env.QA_HEADLESS !== "0");
  try {
    // Step 1 — Crawl
    const crawlResult = await crawl(session.page, { gameUrl: opts.url, gameSlug: opts.gameSlug });
    const slug = crawlResult.gameSlug;
    await initMeta(slug, opts.url);
    await providerCache.save(slug, {
      provider: crawlResult.provider,
      gameName: crawlResult.gameName,
      platform: crawlResult.platform,
      iframeCount: crawlResult.iframeCount,
      canvasCount: crawlResult.canvasCount,
      detectedAt: new Date().toISOString(),
    });

    // Step 1b — Pre-game init (Tier 4 #14): dismiss intro popups, RECORD click
    // sequence + final baseline so warm-start can replay deterministically.
    const pregame = await initPreGame(session.page, slug);
    console.log(
      `[pregame] mode=${pregame.mode} clicks=${pregame.clicks} ms=${pregame.durationMs}${pregame.reason ? ` reason="${pregame.reason}"` : ""}`,
    );

    // Step 2 — Detect UI + capture baselines (used by validate-registry).
    // If registry already exists AND is substantially human-verified (from
    // manual-verify dashboard), SKIP AI discovery entirely. Trusts human work.
    const { isHumanVerified } = await import("../registry/hierarchy.js");
    const existingUi = await uiRegistry.load(slug);
    let uiMap: import("../registry/types.js").UiRegistry;
    if (isHumanVerified(existingUi)) {
      console.log(`[step2] using human-verified registry (${Object.keys(existingUi!).length} elements) — skipping AI discovery`);
      uiMap = existingUi!;
    } else {
      const { uiMap: discoveredUi } = await discoverUi(session.page, { slug });
      uiMap = await captureBaselines(session.page, slug, discoveredUi);
      await uiRegistry.save(slug, uiMap);
    }

    // Step 2b — UI graph exploration: recursively walk all clickable UI states
    // (BFS frontier, DFS within), AI-vision each NEW state once, build full
    // navigation graph. Replaces old hard-coded sub-screen-discover.
    // QA_GRAPH_DISCOVERY=0 → fall back to hard-coded popup discovery for speed.
    // QA_GRAPH_DISCOVERY=legacy → old hard-coded behavior.
    // Also auto-skip if registry is human-verified AND has nested sub-state
    // entries (sign that manual discovery covered the graph).
    const hasNestedVerified = Object.entries(uiMap).some(
      ([k, el]) => k.includes("__") && el?.verifiedBy === "QA",
    );
    if (hasNestedVerified) {
      console.log("[step2/graph] human-verified nested entries found — skipping AI graph exploration");
    } else if (process.env.QA_GRAPH_DISCOVERY === "0") {
      console.log("[step2/graph] skipped via QA_GRAPH_DISCOVERY=0");
    } else if (process.env.QA_GRAPH_DISCOVERY === "legacy") {
      try {
        const { updated, results } = await discoverSubScreens(session.page, slug, uiMap);
        uiMap = updated;
        await uiRegistry.save(slug, uiMap);
        const opened = results.filter((r) => r.popupDetected).length;
        const extra = results.reduce((n, r) => n + Object.keys(r.discovered).length, 0);
        console.log(
          `[step2/sub-screens] explored ${results.length} popups (${opened} opened), +${extra} elements`,
        );
      } catch (err) {
        console.warn(
          `[step2/sub-screens] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      try {
        const exploreResult = await exploreUiGraph(session.page, slug, uiMap, {
          maxDepth: Number(process.env.QA_GRAPH_MAX_DEPTH ?? 3),
          maxAiCalls: Number(process.env.QA_GRAPH_MAX_AI_CALLS ?? 20),
          maxStates: Number(process.env.QA_GRAPH_MAX_STATES ?? 15),
        });
        uiMap = exploreResult.registry;
        await uiRegistry.save(slug, uiMap);
        await uiGraphStore.save(slug, exploreResult.graph);
        const g = exploreResult.graph;
        console.log(
          `[step2/graph] discovered ${g.exploration.statesDiscovered} states, ${g.exploration.transitionsRecorded} transitions, used ${g.exploration.aiCallsUsed} AI calls in ${g.exploration.elapsedMs}ms`,
        );
        if (exploreResult.warnings.length > 0) {
          console.warn(
            `[step2/graph] ${exploreResult.warnings.length} warnings: ${exploreResult.warnings.slice(0, 3).join("; ")}`,
          );
        }
      } catch (err) {
        console.warn(
          `[step2/graph] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 3 — Capture Network (drive with smoke spins)
    const smoke = await runSmokeSpins(session.page, uiMap, { spins: 5 });
    const capture = startCapture(session.page);
    await runSmokeSpins(session.page, uiMap, { spins: 10 });
    const rounds = capture.stop();

    // Persist for inspection / future warm-start use.
    await persistRounds(path.join(dirForGame(slug), "network"), rounds);

    // Step 5 — API Detection (heuristic + AI fallback for unknown providers)
    const candidates = scoreCandidates(rounds);
    let top = candidates[0];
    if (
      (!top || top.score < AI_FALLBACK_HEURISTIC_THRESHOLD) &&
      process.env.QA_AI_API_FALLBACK !== "0"
    ) {
      console.log(
        `[step5/ai-rank] heuristic top score ${top?.score ?? 0} below ${AI_FALLBACK_HEURISTIC_THRESHOLD} → invoking AI fallback`,
      );
      const ai = await rankWithAi({
        gameSlug: slug,
        provider: crawlResult.provider,
        rounds,
        topHeuristicCandidates: candidates,
      });
      if (ai.ok) {
        const url = ai.hints.spin_endpoint.url_pattern;
        const method = ai.hints.spin_endpoint.method as "GET" | "POST";
        console.log(
          `[step5/ai-rank] AI picked ${method} ${url} (confidence ${ai.hints.confidence})`,
        );
        top = {
          url,
          method,
          score: 10,
          reasons: [`AI fallback (${ai.hints.reasoning.slice(0, 100)})`],
        };
      } else {
        console.warn(`[step5/ai-rank] failed: ${ai.reason}`);
      }
    }
    if (top) {
      await apiMapping.save(slug, { spinApi: { url: top.url, method: top.method } });
    }

    // Step 6 — Build Game Model (parser + state machine; feature-registry filled after step4)
    const parser = pickParser(crawlResult.provider);
    await parserCache.save(slug, { parser: parser.kind, version: 1 });

    // Decode captured spins for gameplay-feature detection.
    // CRITICAL: pair each spin response with the request that produced it
    // (matched by URL + closest preceding request in same round). Provider
    // parsers compute `bet` from REQUEST fields (c × l, etc.) — without
    // pairing, every decoded sample has bet=0 (preflight then flags
    // "wallet-snapshot mistaken as spin").
    const decoded: import("../step6-build-model/normalized.js").NormalizedSpinResult[] = [];
    for (const round of rounds) {
      for (const res of round.responses) {
        if (!res.body) continue;
        if (!parser.canParseResponse(res.body, res.url)) continue;
        try {
          if (parser.parseSpinPair) {
            // Find the most recent request to the same URL in this round.
            // PP fires each doSpin as its own request; same URL on responses.
            const reqMatch = [...round.requests]
              .reverse()
              .find((r) => r.url === res.url && r.body);
            decoded.push(parser.parseSpinPair(reqMatch?.body ?? null, res.body, res.url));
          } else {
            decoded.push(parser.parseResponse(res.body));
          }
        } catch {
          // ignore parse errors during discovery
        }
      }
    }

    // Step 4 — Feature Discovery (UI + network + paytable + gameplay + AI)
    const paytable = await paytableStore.load(slug);
    const features = await discoverFeatures({
      uiMap,
      rounds,
      paytable,
      spins: decoded,
    });
    await featureRegistry.save(slug, features);

    // Step 4b — Rules markdown extraction (Tier 1.1) — feeds AI catalog with
    // play-screen snapshot + paytable text. AI call ONCE, cold-start only.
    if (process.env.QA_EXTRACT_RULES !== "0") {
      try {
        const rulesResult = await extractRules(session.page, slug);
        if (rulesResult.rulesMdPath) {
          console.log(`[step4/extract-rules] rules.md → ${rulesResult.rulesMdPath}`);
        }
      } catch (err) {
        console.warn(
          `[step4/extract-rules] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 4c — Deep info extraction. Navigate into paytableButton / infoButton /
    // buyBonusButton / specialBetsButton popups, OCR + Vision-extract structured
    // content, save under fixtures/registry/<slug>/auxiliary-sources/. Feeds AI
    // catalog with exact paytable multipliers, RTP, feature mechanics, buy-option
    // costs. Skips popups whose trigger is missing from uiMap (rare).
    let deepExtractResult: import("../step4-feature-discovery/deep-extract.js").DeepExtractResult | null = null;
    if (process.env.QA_DEEP_EXTRACT !== "0") {
      try {
        const { deepExtractInfo } = await import("../step4-feature-discovery/deep-extract.js");
        deepExtractResult = await deepExtractInfo(session.page, uiMap, slug);
      } catch (err) {
        console.warn(
          `[step4c/deep-extract] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 6b — Preflight (Tier 1.3) — fail-fast on bad samples before running
    // expensive verification. Save report regardless of pass/fail for inspection.
    const execStrategy = buildExecutionStrategy({
      spins: decoded,
      rounds,
      spinApiUrl: top?.url ?? null,
      freeSpinDetected: Boolean(features.features["freeSpin"]?.present),
    });
    const preflight = await runPreflight(slug, execStrategy, decoded);
    if (!preflight.ok) {
      console.warn(`[step6/preflight] NOT OK:\n${formatPreflightResult(preflight)}`);
    } else {
      console.log(
        `[step6/preflight] ok — ${preflight.errors.length} error, ${preflight.warnings.length} warning`,
      );
    }

    // Step 7 — Generate Testcases (template-driven from features)
    const tcDoc = await generateTestcases({
      features,
      game: slug,
      uiMap,
      api: top ? { spinApi: { url: top.url, method: top.method } } : undefined,
    });
    await testcasesStore.save(slug, toYaml(tcDoc));

    // Step 7b — AI-rich catalog (20-40 cases with executable invariants).
    // Optional, gated by env var to skip in fast-CI lanes.
    let aiCatalog: import("../../ai/test-catalog.js").TestCaseCatalog | null = null;
    if (process.env.QA_AI_CATALOG !== "0") {
      const cat = await generateAiCatalog({
        gameSlug: slug,
        provider: await providerCache.load(slug),
        uiMap,
        features,
        rounds,
        parser,
        spinApiUrl: top?.url ?? null,
        auxiliarySources: deepExtractResult ? {
          paytableMd: deepExtractResult.paytableMd,
          infoMd: deepExtractResult.infoMd,
          buyOptionsMd: deepExtractResult.buyOptionsMd,
          specialBetsMd: deepExtractResult.specialBetsMd,
          paytableJson: deepExtractResult.paytableJson,
          rulesJson: deepExtractResult.rulesJson,
        } : null,
      });
      aiCatalog = cat.catalog;
      if (cat.catalog) {
        console.log(`[step7/ai-catalog] generated ${cat.catalog.total_cases} cases → ${cat.catalogJsonPath}`);
        // Export MD + CSV for QA review (deterministic, no AI).
        try {
          const { buildGameSpec } = await import("../step7-testcase-gen/build-game-spec.js");
          const { saveCatalogMarkdown } = await import("../step7-testcase-gen/md-writer.js");
          const { saveCatalogCsv } = await import("../step7-testcase-gen/csv-writer.js");
          const { paytable: paytableStore } = await import("../registry/paytable.js");
          const specForExport = buildGameSpec({
            gameSlug: slug,
            provider: await providerCache.load(slug),
            uiMap,
            features,
            parsedSpins: decoded,
            rounds,
            spinApiUrl: top?.url ?? null,
            paytable: await paytableStore.load(slug).catch(() => null),
          });
          const mdPath = await saveCatalogMarkdown(slug, cat.catalog, specForExport);
          const csvPath = await saveCatalogCsv(slug, cat.catalog, specForExport);
          console.log(`[step7/exports] md → ${mdPath}, csv → ${csvPath}`);
        } catch (err) {
          console.warn(
            `[step7/exports] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        console.log(`[step7/ai-catalog] skipped: ${cat.reason}`);
      }
    }

    // Step 7b2 — translate each case into a click/spin/wait ACTION LIST now,
    // so "Generate Cases" (which stops after the catalog) produces cases that
    // already show their steps. The actions cache was just cleared on re-gen,
    // so this translates fresh. case-runner reuses these (cache-hit) later.
    // Gated via QA_TRANSLATE_CASES=0 (skip for catalog-only inspection).
    if (
      aiCatalog &&
      aiCatalog.cases.length > 0 &&
      process.env.QA_TRANSLATE_CASES !== "0"
    ) {
      try {
        const { translateAllCases } = await import("../step7-testcase-gen/case-action-translator.js");
        const { buildGameSpec } = await import("../step7-testcase-gen/build-game-spec.js");
        const { paytable: paytableStore } = await import("../registry/paytable.js");
        const specForTranslate = buildGameSpec({
          gameSlug: slug,
          provider: await providerCache.load(slug),
          uiMap,
          features,
          parsedSpins: decoded,
          rounds,
          spinApiUrl: top?.url ?? null,
          paytable: await paytableStore.load(slug).catch(() => null),
        });
        console.log(`[step7b2/translate] translating ${aiCatalog.cases.length} cases → action lists...`);
        const cache = await translateAllCases(slug, aiCatalog.cases, uiMap, specForTranslate);
        const withActions = Object.values(cache.cases).filter((c) => (c.actions?.length ?? 0) > 0).length;
        console.log(`[step7b2/translate] ✔ ${withActions}/${aiCatalog.cases.length} cases have action lists`);
      } catch (err) {
        console.warn(`[step7b2/translate] non-fatal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Early-exit gate: QA_STOP_AFTER_CATALOG=1 → return now without running
    // cases or massive-spin. Used by dashboard "Generate Cases" button so QA
    // can inspect test-cases.json before deciding to execute.
    if (process.env.QA_STOP_AFTER_CATALOG === "1") {
      console.log("[cold-start] QA_STOP_AFTER_CATALOG=1 → stopping after catalog generation");
      const outDir =
        opts.outDir ??
        path.join("fixtures", "test-runs", new Date().toISOString().replace(/[:.]/g, "-"));
      // Write a minimal report so dashboard can show "what was generated"
      const report = await generateReport(
        {
          crawl: crawlResult,
          smoke,
          rules: { totalSpins: 0, totalRules: 0, passed: 0, failed: 0, results: [] },
          stats: { totalSpins: 0, totalBet: 0, totalWin: 0, rtp: 0, hitRate: 0, volatility: "low", features: { freeSpinTrigger: 0, bonusTrigger: 0, retrigger: 0 }, winDistribution: { totalSpins: 0, hitCount: 0, maxWin: 0, meanWin: 0, stddev: 0, percentiles: { p50: 0, p90: 0, p99: 0, p999: 0 } }, raw: { frameCount: 0, rtpRaw: 0, hitRateRaw: 0 } },
        },
        { outDir, generatePdf: opts.generatePdf },
      );
      return { mode: "cold", gameSlug: slug, report };
    }

    // Step 7c — Execute each AI catalog case as a scenario (Tier-3 feature).
    // Gated via QA_RUN_CASES=0 to skip when fast-CI lanes only need stats.
    let caseRun: import("../step8-run-scenarios/case-runner.js").CaseRunSummary | undefined;
    if (
      process.env.QA_RUN_CASES !== "0" &&
      aiCatalog &&
      aiCatalog.cases.length > 0
    ) {
      const { runAllCases } = await import("../step8-run-scenarios/case-runner.js");
      try {
        caseRun = await runAllCases(
          { page: session.page, gameSlug: slug, uiMap, parser },
          aiCatalog.cases as import("../step8-run-scenarios/case-runner.js").CatalogCase[],
        );
        console.log(
          `[step7c/cases] ${caseRun.passed} pass / ${caseRun.failed} fail / ${caseRun.skipped} skip in ${(caseRun.totalDurationMs / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.warn(
          `[step7c/cases] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 8 — Run scenarios (massive spins, UI or API mode).
    // Only PER-SPIN invariant rules. Rules that need playthrough context
    // (FreeSpinNoDeduct, StateTransition, CustomAssertion) belong to
    // case-runner, not statistical sampling. See warm-start.ts for full
    // rationale — simulate replays the same template N times, so server's
    // free-spin/state-chain context across samples isn't meaningful and
    // those rules false-positive (verified: fs=1 in replay response while
    // balance is deducted because request body still has c=0.025).
    const rules: import("../step9-verify/rule.js").Rule[] = [
      new FinancialRule(),
      new ApiResponseShapeRule(),
    ];
    const engine = new RuleEngine(rules);
    const spinCount = opts.spinCount ?? 10;
    const api = await apiMapping.load(slug);
    const cascade = detectCascade(rounds, crawlResult.provider);
    if (cascade) console.log(`[step8] cascade game detected → simulate will fetch doCollect tails`);
    phaseStart("run_scenarios", { spinCount, mode: opts.spinMode ?? "auto" });
    const massive = await runMassiveSpins(
      {
        gameSlug: slug,
        page: session.page,
        uiMap,
        capture: startCapture(session.page),
        api: api ?? undefined,
        parser,
        cascade,
      },
      { count: spinCount, mode: opts.spinMode },
    );
    phaseEnd("run_scenarios", {
      attempted: massive.attempted,
      succeeded: massive.succeeded,
      durationMs: massive.durationMs,
    });

    // Step 9 — Verify (rule engine evaluates each LOGICAL spin, post-dedup).
    // Cascade games (PP) emit multiple frames per logical spin; financial /
    // payout / state-transition rules should fire on the round-level view
    // (cumulative tw, final balance), not on intermediate frames.
    const dedupped = dedupByRoundId(massive.spins);
    let prevBalance: number | null = null;
    let prevState: import("../step6-build-model/normalized.js").SpinState | null = null;
    dedupped.forEach((spin, roundIndex) => {
      engine.evaluate(spin, { previousBalance: prevBalance, previousState: prevState, roundIndex });
      prevBalance = spin.balanceAfter;
      prevState = spin.state;
    });

    // Step 9b — History reconciliation (Tier 2 #7). Open history popup once,
    // OCR rows, match to captured spins. Detects missing rows + wrong values.
    let historyVerify: HistoryVerifyResult | null = null;
    if (process.env.QA_VERIFY_HISTORY !== "0" && dedupped.length > 0) {
      try {
        historyVerify = await verifyHistory(session.page, slug, uiMap, dedupped);
        if (!historyVerify.opened) {
          console.log(`[step9/history] skipped: ${historyVerify.reason}`);
        } else if (historyVerify.ok) {
          console.log(
            `[step9/history] ok — ${historyVerify.matchedCount}/${historyVerify.spinsCount} matched, ${historyVerify.rowsCount} rows total`,
          );
        } else {
          console.warn(
            `[step9/history] mismatches: ${historyVerify.mismatches.length} (${historyVerify.mismatches.slice(0, 3).map((m) => m.kind).join(", ")})`,
          );
        }
      } catch (err) {
        console.warn(
          `[step9/history] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 9c — UI verifier (Tier 3 #12) — opt-in OCR of balance/bet/win vs API.
    let uiVerify: UiVerifyResult | null = null;
    const lastSpin = dedupped[dedupped.length - 1];
    if (process.env.QA_VERIFY_UI === "1" && lastSpin) {
      try {
        uiVerify = await verifyUi(session.page, slug, lastSpin);
        const mismatchCount = uiVerify.checks.filter((c) => !c.match).length;
        if (uiVerify.ok) {
          console.log(`[step9/ui] ok — ${uiVerify.checks.length} fields checked`);
        } else {
          console.warn(`[step9/ui] ${mismatchCount} field mismatch(es)`);
        }
      } catch (err) {
        console.warn(
          `[step9/ui] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    void uiVerify;

    // Step 10 — Statistical aggregation + scenario library extraction
    const stats = aggregate(massive.spins);
    if (process.env.QA_EXTRACT_SCENARIOS !== "0") {
      try {
        const scn = await extractScenarios(slug, dedupped, "cold-start");
        if (scn.fixtures.length > 0) {
          console.log(
            `[step10/scenarios] saved ${scn.fixtures.length} labelled fixtures: ${scn.fixtures.map((f) => f.label).join(", ")}`,
          );
        } else {
          console.log("[step10/scenarios] no labelled scenarios in this run");
        }
      } catch (err) {
        console.warn(
          `[step10/scenarios] non-fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 11 — Report (JSON + HTML + PDF)
    const outDir =
      opts.outDir ??
      path.join(
        "fixtures",
        "test-runs",
        new Date().toISOString().replace(/[:.]/g, "-"),
      );
    const report = await generateReport(
      { crawl: crawlResult, smoke, rules: engine.summary(), massive, stats, caseRun },
      { outDir, generatePdf: opts.generatePdf },
    );

    return { mode: "cold", gameSlug: slug, report };
  } finally {
    await closeBrowser(session);
  }
}
