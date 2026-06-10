// INVARIANT — Spec-learner (Phase 3)
//
// Deterministic detector proposes a winItemization; the replay-gate decides
// trust. Detector is never the source of truth — a wrong/unsure guess is
// caught by the gate and surfaced as needsAi/needMoreSamples.

import { test, expect } from "@playwright/test";
import { detectWinItemization, learnParserOverlay } from "../../src/pipeline/step8-run-scenarios/spec-learner.ts";
import type { ReplaySample } from "../../src/pipeline/step8-run-scenarios/spec-replay-gate.ts";
import type { ProviderSpec } from "../../src/pipeline/step6-build-model/providers/spec-types.ts";

function ppSpec(): ProviderSpec {
  return {
    name: "Pragmatic",
    wireFormat: "querystring",
    urlPatterns: ["/gs2c/.*gameservice"],
    nonSpinActions: ["doInit"],
    spinRequiredParams: ["c"],
    response: {
      fields: { balanceBefore: "bb", balanceAfter: "ba", totalWin: "tw", initialReels: "s", roundIndex: "index" },
      reelsDecoder: "column_major",
      defaultReelDimensions: { width: 5, height: 3 },
      shapeScore: { requiredFields: ["ba"], bonusFields: ["tw", "index"], minScore: 1 },
    },
    request: { fields: { coin: "c", betLevel: "bl", lines: "l", roundIdParts: ["index", "counter"] }, betFormula: "coin * lines" },
    roundId: { source: "request", fields: ["index", "counter"], format: "req-{0}-{1}", fallback: "response_hash" },
  };
}

function wlcvSamples(): ReplaySample[] {
  const rows = [
    { idx: 1, tw: 0.04, wlc: "12~0.04~1~3~6,8,19~l", bb: 100.0 },
    { idx: 2, tw: 0.24, wlc: "5~0.24~2~3~1,2,6~l", bb: 99.64 },
    { idx: 3, tw: 0.40, wlc: "7~0.40~1~3~0,1,4~l", bb: 99.48 },
    { idx: 4, tw: 0.14, wlc: "8~0.14~2~3~0,7,8~l", bb: 99.48 },
    { idx: 5, tw: 0.30, wlc: "11~0.30~3~3~6,13,14~l", bb: 99.22 },
    { idx: 6, tw: 5.52, wlc: "7~5.52~4~6~0,1,4,7,9,11~l", bb: 99.12 },
  ];
  return rows.map((r) => ({
    request: `action=doSpin&c=0.02&l=20&index=${r.idx}&counter=2`,
    response: `tw=${r.tw}&wlc_v=${r.wlc}&na=s&bb=${r.bb}&ba=${(r.bb - 0.4 + r.tw).toFixed(2)}&index=1`,
  }));
}

// === detector ===

test("detect wlc_v → high confidence", () => {
  const d = detectWinItemization(wlcvSamples(), "querystring");
  expect(d.value).toBe("wlc_v");
  expect(d.confidence).toBe("high");
  expect(d.evidence.wlcvFrames).toBe(6);
});

test("detect cluster (l0/l1) → high confidence", () => {
  const samples: ReplaySample[] = [
    { request: "action=doSpin&c=0.02&l=20&index=1&counter=2", response: "tw=0.50&s=3,3,3,7,8&l0=0~0.50~0,1,2&na=s&bb=100&ba=99.9&index=1" },
  ];
  const d = detectWinItemization(samples, "querystring");
  expect(d.value).toBe("cluster");
  expect(d.confidence).toBe("high");
});

test("no itemization field but wins present → auto, low confidence (AI-tail candidate)", () => {
  const samples: ReplaySample[] = [
    { request: "action=doSpin&c=0.02&l=20&index=1&counter=2", response: "tw=0.50&wb_detail=weird&na=s&bb=100&ba=99.9&index=1" },
  ];
  const d = detectWinItemization(samples, "querystring");
  expect(d.value).toBe("auto");
  expect(d.confidence).toBe("low");
  expect(d.reason).toMatch(/AI tail/);
});

// === learnParserOverlay (detect → gate → overlay) ===

test("wlc_v samples → overlay winItemization trusted (gate reconciled + coverage)", () => {
  const r = learnParserOverlay(ppSpec(), wlcvSamples());
  expect(r.detector.value).toBe("wlc_v");
  expect(r.overlay.winItemization?.value).toBe("wlc_v");
  expect(r.overlay.winItemization?.trusted).toBe(true);
  expect(r.overlay.validation?.invariants).toContain("sums-to-total");
  expect(r.needsAi).toBe(false);
  expect(r.needMoreSamples).toBe(false);
});

test("trusted comes from the GATE, not the detector: too few wins → untrusted + needMoreSamples", () => {
  const r = learnParserOverlay(ppSpec(), wlcvSamples().slice(0, 3)); // 3 < K=5
  expect(r.detector.value).toBe("wlc_v");       // detector still confident
  expect(r.overlay.winItemization?.trusted).toBe(false); // but gate withholds
  expect(r.needMoreSamples).toBe(true);
  expect(r.needsAi).toBe(false);
});

test("unrecognized itemization with enough wins → not trusted + needsAi (escalate to Phase 5)", () => {
  // 6 winning frames but wins live in an unknown field → auto/wlc_v yields
  // empty breakdown → gate INV1 fails despite coverage → AI tail.
  const samples: ReplaySample[] = [1, 2, 3, 4, 5, 6].map((idx) => ({
    request: `action=doSpin&c=0.02&l=20&index=${idx}&counter=2`,
    response: `tw=0.50&wb_detail=sym7:0.50&na=s&bb=100&ba=99.9&index=1`,
  }));
  const r = learnParserOverlay(ppSpec(), samples);
  expect(r.overlay.winItemization?.trusted).toBe(false);
  expect(r.gate.itemization.coverageMet).toBe(true);
  expect(r.needsAi).toBe(true);
});
