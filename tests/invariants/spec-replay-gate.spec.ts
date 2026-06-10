// INVARIANT — Replay-gate (Phase 2)
//
// The gate re-parses captured samples through a candidate parser and certifies
// itemization ONLY if it reconciles AND the samples cover enough winning
// rounds. Trust must come from the data's own arithmetic, never from trusting
// the detector/AI guess.

import { test, expect } from "@playwright/test";
import { SpecDrivenParser } from "../../src/pipeline/step6-build-model/providers/spec-driven-parser.ts";
import { replayGate, type ReplaySample } from "../../src/pipeline/step8-run-scenarios/spec-replay-gate.ts";
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

// 6 single-frame winning rounds (na=s, no cascade continuation → each is its
// own round). bet = c*l = 0.02*20 = 0.40. ba = bb − 0.40 + tw. Distinct index
// → unique roundId. wlc_v strings are real PP itemizations.
function winningSamples(): ReplaySample[] {
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
    response: `tw=${r.tw}&wlc_v=${r.wlc}&na=s&rs=tumbling&bb=${r.bb}&ba=${(r.bb - 0.4 + r.tw).toFixed(2)}&index=1`,
  }));
}

test("real winning samples reconcile → itemization trusted", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const r = replayGate(parser, winningSamples());
  expect(r.itemization.winningRounds).toBe(6);
  expect(r.itemization.coverageMet).toBe(true);      // 6 >= 5
  expect(r.invariants.sumsToTotal.pass).toBe(true);  // Σcombos == tw each
  expect(r.invariants.roundIdUnique.pass).toBe(true);
  expect(r.itemization.trusted).toBe(true);
});

test("winItemization='none' on a sample WITH wins → INV1 fails → NOT trusted", () => {
  const spec = ppSpec();
  spec.response.winItemization = "none"; // wrong: hides real itemization
  const parser = new SpecDrivenParser(spec, "PragmaticParser");
  const r = replayGate(parser, winningSamples());
  expect(r.invariants.sumsToTotal.pass).toBe(false); // Σ=0 ≠ tw>0
  expect(r.itemization.reconciled).toBe(false);
  expect(r.itemization.trusted).toBe(false);
  expect(r.itemization.reason).toMatch(/mismatch/);
});

test("insufficient coverage (<5 winning rounds) → NOT trusted even if reconciled", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const r = replayGate(parser, winningSamples().slice(0, 3)); // only 3 wins
  expect(r.invariants.sumsToTotal.pass).toBe(true);  // those 3 reconcile
  expect(r.itemization.coverageMet).toBe(false);     // 3 < 5
  expect(r.itemization.trusted).toBe(false);
  expect(r.itemization.reason).toMatch(/coverage/);
});

test("balance conservation invariant holds on clean samples", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const r = replayGate(parser, winningSamples());
  expect(r.invariants.balanceConservation.pass).toBe(true); // ba−bb == tw−bet
});

test("zero-win frames don't count as winning rounds (coverage guard)", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const zeroWins: ReplaySample[] = [1, 2, 3, 4, 5, 6].map((idx) => ({
    request: `action=doSpin&c=0.02&l=20&index=${idx}&counter=2`,
    response: `tw=0.00&na=s&bb=100&ba=99.6&index=1`,
  }));
  const r = replayGate(parser, zeroWins);
  expect(r.itemization.winningRounds).toBe(0);
  expect(r.itemization.coverageMet).toBe(false);
  expect(r.itemization.trusted).toBe(false); // can't certify itemization with no wins
});
