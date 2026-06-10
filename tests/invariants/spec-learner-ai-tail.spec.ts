// INVARIANT — Phase 5: AI tail for win-itemization.
//
// The AI is consulted ONLY when the deterministic path flags needsAi (gate
// failed despite enough wins), and its pick is RE-VALIDATED by the same
// replay-gate. Trust always comes from the gate, never the model.

import { test, expect } from "@playwright/test";
import { learnParserOverlayWithAi } from "../../src/pipeline/step8-run-scenarios/spec-learner.ts";
import type { ReplaySample } from "../../src/pipeline/step8-run-scenarios/spec-replay-gate.ts";
import type { ProviderSpec, WinItemization } from "../../src/pipeline/step6-build-model/providers/spec-types.ts";

function ppSpec(): ProviderSpec {
  return {
    name: "Pragmatic", wireFormat: "querystring",
    urlPatterns: ["/gs2c/.*gameservice"], nonSpinActions: ["doInit"], spinRequiredParams: ["c"],
    response: {
      fields: { balanceBefore: "bb", balanceAfter: "ba", totalWin: "tw", initialReels: "s", roundIndex: "index" },
      reelsDecoder: "column_major", defaultReelDimensions: { width: 5, height: 3 },
      shapeScore: { requiredFields: ["ba"], bonusFields: ["tw", "index"], minScore: 1 },
    },
    request: { fields: { coin: "c", betLevel: "bl", lines: "l", roundIdParts: ["index", "counter"] }, betFormula: "coin * lines" },
    roundId: { source: "request", fields: ["index", "counter"], format: "req-{0}-{1}", fallback: "response_hash" },
  };
}

// Each winning round carries BOTH a (wrong) wlc_v AND a (correct) cluster l0.
// "auto"/wlc_v parses the wrong wlc_v → Σ≠tw → gate fails → needsAi. The
// correct itemization is cluster (l0 sums to tw).
function dualFormatSamples(): ReplaySample[] {
  const rows = [
    { idx: 1, tw: 0.50, bb: 100.0 },
    { idx: 2, tw: 0.30, bb: 99.6 },
    { idx: 3, tw: 1.20, bb: 99.3 },
    { idx: 4, tw: 0.40, bb: 100.1 },
    { idx: 5, tw: 0.80, bb: 100.1 },
    { idx: 6, tw: 2.00, bb: 100.5 },
  ];
  return rows.map((r) => ({
    request: `action=doSpin&c=0.02&l=20&index=${r.idx}&counter=2`,
    // wlc_v win=999 (WRONG) ; cluster l0 win=tw (CORRECT, symbol from grid[0]=9)
    response: `tw=${r.tw}&wlc_v=9~999~1~3~0,1,2~l&s=9,9,9,1,2&l0=0~${r.tw}~0~1~2&na=s&bb=${r.bb}&ba=${(r.bb - 0.4 + r.tw).toFixed(2)}&index=1`,
  }));
}

const fakeAi = (value: WinItemization, reasoning = "ai") =>
  async (_responses: string[]) => ({ value, reasoning });

test("deterministic path fails (wlc_v wrong) then AI → cluster → gate validates → trusted", async () => {
  const r = await learnParserOverlayWithAi(ppSpec(), dualFormatSamples(), {
    minWinningRounds: 5,
    aiPropose: fakeAi("cluster"),
  });
  expect(r.aiUsed).toBe(true);
  expect(r.overlay.winItemization?.value).toBe("cluster");
  expect(r.overlay.winItemization?.trusted).toBe(true); // gate reconciled the AI pick
  expect(r.gate.itemization.reconciled).toBe(true);
});

test("AI proposes a WRONG strategy → gate rejects → stays untrusted (model never trusted blindly)", async () => {
  const r = await learnParserOverlayWithAi(ppSpec(), dualFormatSamples(), {
    minWinningRounds: 5,
    aiPropose: fakeAi("none"), // wrong: there ARE itemized wins
  });
  expect(r.aiUsed).toBe(true);
  expect(r.overlay.winItemization?.trusted).toBe(false);
  expect(r.needsAi).toBe(true); // still unrecognized → manual review
});

test("AI unavailable (returns null) → graceful fallback to deterministic untrusted overlay", async () => {
  const r = await learnParserOverlayWithAi(ppSpec(), dualFormatSamples(), {
    minWinningRounds: 5,
    aiPropose: async () => null,
  });
  expect(r.aiUsed).toBe(false);
  expect(r.overlay.winItemization?.trusted).toBe(false);
});

test("deterministic path SUCCEEDS → AI is NOT called", async () => {
  // Clean wlc_v-only winning samples reconcile deterministically.
  const clean: ReplaySample[] = [
    { idx: 1, tw: 0.04, wlc: "12~0.04~1~3~6,8,19~l", bb: 100.0 },
    { idx: 2, tw: 0.24, wlc: "5~0.24~2~3~1,2,6~l", bb: 99.64 },
    { idx: 3, tw: 0.40, wlc: "7~0.40~1~3~0,1,4~l", bb: 99.48 },
    { idx: 4, tw: 0.14, wlc: "8~0.14~2~3~0,7,8~l", bb: 99.48 },
    { idx: 5, tw: 0.30, wlc: "11~0.30~3~3~6,13,14~l", bb: 99.22 },
    { idx: 6, tw: 5.52, wlc: "7~5.52~4~6~0,1,4,7,9,11~l", bb: 99.12 },
  ].map((r) => ({
    request: `action=doSpin&c=0.02&l=20&index=${r.idx}&counter=2`,
    response: `tw=${r.tw}&wlc_v=${r.wlc}&na=s&bb=${r.bb}&ba=${(r.bb - 0.4 + r.tw).toFixed(2)}&index=1`,
  }));
  let aiCalled = false;
  const r = await learnParserOverlayWithAi(ppSpec(), clean, {
    minWinningRounds: 5,
    aiPropose: async () => { aiCalled = true; return null; },
  });
  expect(aiCalled).toBe(false);
  expect(r.aiUsed).toBe(false);
  expect(r.overlay.winItemization?.trusted).toBe(true);
});
