// INVARIANT — AI Failure Review (Phase 7.5)
//
// Tests the deterministic parts of the failure-review layer:
//   - buildEvidence: shaping CaseResult + CompiledKnowledge into Evidence
//   - heuristicClassify: fast-path pre-classification (no AI call)
//   - classifyFailure dryRun mode: heuristic-only path
//
// The AI-call path (classifyFailure without dryRun) requires API key + costs
// money, so we don't test it as an invariant. Integration tests can cover it.

import { test, expect } from "@playwright/test";
import { buildEvidence, heuristicClassify, classifyFailure } from "../../src/pipeline/step12-failure-review/index.js";
import type { CompiledKnowledge } from "../../src/pipeline/knowledge/index.js";
import type { CaseResult } from "../../src/pipeline/step8-run-scenarios/case-executor.js";

function fakeKnowledge(overrides: Partial<CompiledKnowledge> = {}): CompiledKnowledge {
  return {
    schemaVersion: 1,
    sourceHashes: {},
    compiledAt: new Date().toISOString(),
    gameSlug: "test-game",
    ui: { spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1, detectedAt: "" } },
    provider: null,
    api: null,
    fields: null,
    parser: { parser: "PragmaticParser", version: 1 },
    mechanics: { mechanic: "lines", betMultiplier: 20, waysOrLines: 20, detectedAt: "", detectionMethod: "balance_derived" },
    timing: { spinResponseTimeoutMs: 15000, postActionSettleMs: 10000, actionTimeoutMs: 30000, hardCapMs: 300000, popupCheckDelayMs: 2500, dismissInterClickMs: 800, dismissPreWaitMs: 10000, maxSpinRetries: 2 },
    betControls: { minBetClicks: 20, maxBetClicks: 20, stepDelayMs: 80 },
    popupKeywords: { interstitial: ["congratulations"], substate: ["paytable"] },
    subStateHints: {},
    derived: { betLadder: [], betFormulaDescription: "c × 20 (mechanic=lines)" },
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function fakeResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "test-case-1",
    name: "Test Case",
    category: "base_game",
    severity: "major",
    status: "fail",
    actionsExecuted: 1,
    assertions: [],
    spin: null,
    durationMs: 1000,
    ...overrides,
  };
}

test("buildEvidence shapes CaseResult into expected fields", () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      skipReason: "no spin response",
      assertions: [{ id: "a1", description: "balance ok", pass: false, detail: "actual 0 expected 100" }],
      spinsCount: 5,
      warnings: ["spin 3: popup blocked"],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [{ kind: "spin" }, { kind: "wait_ms", ms: 2500 }, { kind: "spin" }],
  });
  expect(ev.caseId).toBe("test-case-1");
  expect(ev.status).toBe("fail");
  expect(ev.skipReason).toBe("no spin response");
  expect(ev.failures.length).toBe(1);
  expect(ev.assertions.length).toBe(1);
  expect(ev.spinsCount).toBe(5);
  expect(ev.warnings.length).toBe(1);
  expect(ev.actionPlan.length).toBe(3);
});

test("buildEvidence: knowledge fields surface correctly", () => {
  const ev = buildEvidence({
    result: fakeResult(),
    knowledge: fakeKnowledge({
      mechanics: { mechanic: "ways", betMultiplier: 20, waysOrLines: 1024, detectedAt: "", detectionMethod: "balance_derived" },
      derived: { betLadder: [], betFormulaDescription: "c × 20 (mechanic=ways)" },
    }),
    actionPlan: [],
  });
  expect(ev.knowledge.mechanic).toBe("ways");
  expect(ev.knowledge.betMultiplier).toBe(20);
  expect(ev.knowledge.betFormulaDescription).toMatch(/ways/);
});

test("buildEvidence: knownAliasFields populated from KNOWN_FIELD_NAMES", () => {
  const ev = buildEvidence({
    result: fakeResult(),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  expect(ev.knowledge.knownAliasFields).toContain("matrix");
  expect(ev.knowledge.knownAliasFields).toContain("roundId");
  expect(ev.knowledge.knownAliasFields).toContain("id");
});

// === Heuristic classifier ===

test("heuristic catches: uiKey 'X' not in registry → wrong_registry, high confidence", () => {
  const ev = buildEvidence({
    result: fakeResult({
      skipReason: "action failed: uiKey 'autoButton__betLevelSlider' not in registry",
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  const h = heuristicClassify(ev);
  expect(h?.classification).toBe("wrong_registry");
  expect(h?.confidence).toBeGreaterThanOrEqual(0.85);
  expect(h?.reason).toMatch(/autoButton__betLevelSlider/);
});

test("heuristic catches: popup-blocked + no spin captured → wrong_popup_keywords", () => {
  const ev = buildEvidence({
    result: fakeResult({
      skipReason: "no spin response captured within timeout",
      warnings: ["spin 1: popup blocked (matched=[congrats]) — retry 1/2"],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  const h = heuristicClassify(ev);
  expect(h?.classification).toBe("wrong_popup_keywords");
});

test("heuristic catches: cumulative balance fail with extra captured spins → wrong_cascade_rule", () => {
  const ev = buildEvidence({
    result: fakeResult({
      assertions: [
        { id: "cumulative-balance-reconciles", description: "Final balance matches", pass: false, detail: "..." },
      ],
      spinsCount: 12, // captured 12 spins
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [{ kind: "spin" }, { kind: "spin" }, { kind: "spin" }], // action plan has 3 spins
  });
  const h = heuristicClassify(ev);
  expect(h?.classification).toBe("wrong_cascade_rule");
});

test("heuristic returns null for ambiguous cases (defer to AI)", () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      assertions: [{ id: "some-assertion", description: "Generic check", pass: false }],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  const h = heuristicClassify(ev);
  expect(h).toBe(null);
});

// === classifyFailure dry-run mode ===

test("classifyFailure dryRun=true: returns heuristic result if confident", async () => {
  const ev = buildEvidence({
    result: fakeResult({
      skipReason: "action failed: uiKey 'unknownButton' not in registry",
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  const r = await classifyFailure(ev, { dryRun: true });
  expect(r?.classification).toBe("wrong_registry");
  expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
});

test("classifyFailure dryRun=true: returns null when heuristic can't decide (no AI call)", async () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      assertions: [{ id: "ambiguous", description: "something", pass: false }],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  const r = await classifyFailure(ev, { dryRun: true });
  expect(r).toBe(null);
});

test("classifyFailure dryRun=true + skipHeuristic=true: returns null without AI call", async () => {
  const ev = buildEvidence({
    result: fakeResult({
      skipReason: "action failed: uiKey 'X' not in registry",
    }),
    knowledge: fakeKnowledge(),
    actionPlan: [],
  });
  // skipHeuristic forces "AI path" but dryRun blocks AI → null
  const r = await classifyFailure(ev, { skipHeuristic: true, dryRun: true });
  expect(r).toBe(null);
});

// === wrong_test_pacing heuristic ===

test("heuristic catches: cascade pacing — N<expected spins, timeout warnings, balance OK → wrong_test_pacing", () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      spinsCount: 3,
      assertions: [
        { id: "five-end-rounds-recorded", description: "5 round-end spins", pass: false, detail: "got 3" },
        { id: "balance-conservation", description: "balance reconciles", pass: true },
      ],
      spin: { bet: 0.2, win: 0, balanceBefore: 100, balanceAfter: 99.8, roundId: "r1", state: "NORMAL" },
      warnings: [
        "spin 2: no spin/gameService response within 15s of click (total elapsed 15.0s, 0 popup-retries)",
        "expected 5 spin response(s), got 3 — clicks debounced by ongoing cascade animation OR popup-blocked",
      ],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: Array.from({ length: 5 }, () => ({ kind: "spin" as const, reason: "spin" })),
  });
  const r = heuristicClassify(ev);
  expect(r?.classification).toBe("wrong_test_pacing");
  expect(r?.confidence).toBeGreaterThanOrEqual(0.7);
});

test("heuristic upgrades to high-confidence wrong_test_pacing when cascade-merge signal present", () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      spinsCount: 4,
      assertions: [
        { id: "five-end-rounds-recorded", description: "5 round-end spins", pass: false },
      ],
      spin: { bet: 0.2, win: 0, balanceBefore: 100, balanceAfter: 99.8, roundId: "r1", state: "NORMAL" },
      warnings: [
        "spin 3: responses arrived (merged/rejected) but no new spin response within 15s",
        "expected 5 spin response(s), got 4 — 1 click(s) likely debounced by ongoing cascade animation (3 responses were dedup-merged as cascade frames — game is cascade-heavy)",
      ],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: Array.from({ length: 5 }, () => ({ kind: "spin" as const, reason: "spin" })),
  });
  const r = heuristicClassify(ev);
  expect(r?.classification).toBe("wrong_test_pacing");
  // Cascade-heavy variant gets 0.85 (above auto-apply gate) because the
  // recommended fix (relax assertion or longer wait_ms) is unambiguous.
  expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
  // Reason must explicitly warn that bumping spinResponseTimeoutMs WON'T help
  expect(r?.reason).toMatch(/WON'T help|won't help|cascade-heavy|IGNORED during/i);
});

test("heuristic distinguishes wrong_test_pacing from wrong_cascade_rule (count direction)", () => {
  // wrong_cascade_rule: captured MORE than expected (cascade not deduping)
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      spinsCount: 12, // more than 5 expected
      assertions: [
        { id: "cumulative-balance-reconciles", description: "cumulative balance", pass: false, detail: "off by 0.5" },
      ],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: Array.from({ length: 5 }, () => ({ kind: "spin" as const, reason: "spin" })),
  });
  const r = heuristicClassify(ev);
  expect(r?.classification).toBe("wrong_cascade_rule");
});

test("heuristic does NOT classify wrong_test_pacing when balance also failed (likely deeper bug)", () => {
  const ev = buildEvidence({
    result: fakeResult({
      status: "fail",
      spinsCount: 2,
      assertions: [
        { id: "five-end-rounds-recorded", description: "5 round-end spins", pass: false },
        { id: "balance-reconciles", description: "balance reconciles", pass: false, detail: "off by 5" },
      ],
      warnings: ["spin 3: no response within 15s of click"],
    }),
    knowledge: fakeKnowledge(),
    actionPlan: Array.from({ length: 5 }, () => ({ kind: "spin" as const, reason: "spin" })),
  });
  const r = heuristicClassify(ev);
  // With balance also broken, this isn't simple pacing — defer to AI
  expect(r?.classification).not.toBe("wrong_test_pacing");
});

// === schema-summary ===

test("buildSchemaSummary lists every patchable file with valid fields", async () => {
  const { buildSchemaSummary } = await import("../../src/pipeline/step12-failure-review/schema-summary.js");
  const summary = buildSchemaSummary();
  // Must mention canonical config files
  expect(summary).toContain("timing-config.json");
  expect(summary).toContain("ui-registry.json");
  expect(summary).toContain("game-mechanics.json");
  expect(summary).toContain("popup-keywords.json");
  // Must mention real fields, not hallucinated ones
  expect(summary).toContain("spinResponseTimeoutMs");
  expect(summary).toContain("betMultiplier");
  // Must NOT contain fabricated fields from past AI hallucinations
  expect(summary).not.toContain("actionPlanHints");
  expect(summary).not.toContain("spinIdleMaxMs");
  expect(summary).not.toContain("balanceDiffEpsilon");
});

test("buildSchemaSummary tags required + nullable fields", async () => {
  const { buildSchemaSummary } = await import("../../src/pipeline/step12-failure-review/schema-summary.js");
  const summary = buildSchemaSummary();
  // ui-registry.spinButton is required in some schemas; check tags appear
  expect(summary).toMatch(/\[(required|nullable)/);
});
