// INVARIANT — Phase 6 crown-jewel helpers are bound into the assertion sandbox
// (comboWellFormed / distinctReels / clusterConnected + gridWidth/gridHeight),
// so catalog/builtin assertions can call them in check_code.

import { test, expect } from "@playwright/test";
import { evaluateAssertions } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

// 5 reels × 3 rows (column-major). A winning combo on reel 0 (positions 0,1,2).
function spinWithCluster(): NormalizedSpinResult {
  return {
    roundId: "req-1-2", bet: 0.4, win: 0.5,
    balanceBefore: 100, balanceAfter: 100.1,
    reels: [["7", "7", "7"], ["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"], ["j", "k", "l"]],
    cascadeFrames: [], state: "NORMAL", isFreeSpin: false, hasBonus: false, freeSpinsRemaining: 0,
    raw: {}, serverTotalWin: 0.5,
    winBreakdown: [{ symbol: "7", win: 0.5, ways: 1, count: 1, positions: [0, 1, 2], type: "cluster" }],
  } as unknown as NormalizedSpinResult;
}

const evalOne = (check_code: string) => {
  const s = spinWithCluster();
  return evaluateAssertions(s, [s], [{ id: "x", description: "x", check_code }])[0];
};

test("gridWidth / gridHeight are bound from the spin's reels", () => {
  expect(evalOne("gridWidth === 5 && gridHeight === 3").pass).toBe(true);
});

test("comboWellFormed is callable in check_code", () => {
  expect(evalOne("(spin.winBreakdown||[]).every(c => comboWellFormed(c))").pass).toBe(true);
});

test("clusterConnected is callable with grid dims (vertical cluster connected)", () => {
  expect(evalOne("clusterConnected(spin.winBreakdown[0].positions, gridWidth, gridHeight)").pass).toBe(true);
});

test("distinctReels is callable (positions 0,1,2 all on reel 0 → 1 reel)", () => {
  expect(evalOne("distinctReels(spin.winBreakdown[0].positions, gridHeight) === 1").pass).toBe(true);
});

test("crown-jewel catches a malformed combo (count > positions) as FAIL", () => {
  const s = spinWithCluster();
  (s as unknown as { winBreakdown: unknown[] }).winBreakdown = [{ symbol: "7", win: 0.5, count: 9, positions: [0, 1] }];
  const r = evaluateAssertions(s, [s], [
    { id: "wf", description: "well-formed", check_code: "(spin.winBreakdown||[]).every(c => comboWellFormed(c))" },
  ])[0];
  expect(r.pass).toBe(false);
});
