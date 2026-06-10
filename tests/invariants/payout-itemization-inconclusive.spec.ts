// INVARIANT — Phase 4: itemization-dependent payout assertions become
// INCONCLUSIVE (not false FAIL / false PASS) when the parser's win itemization
// is UNVERIFIED for the game (no trusted parser-overlay). When verified, real
// payout failures stand.

import { test, expect } from "@playwright/test";
import { evaluateAssertions } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

// A winning spin whose winBreakdown is EMPTY — the exact shape that produced
// the false "phantom win" FAIL when itemization wasn't populated.
function winningSpinNoBreakdown(): NormalizedSpinResult {
  return {
    roundId: "req-1-2", bet: 0.4, win: 5.52,
    balanceBefore: 100, balanceAfter: 105.12,
    reels: [], cascadeFrames: [], state: "NORMAL",
    isFreeSpin: false, hasBonus: false, freeSpinsRemaining: 0,
    raw: {}, winBreakdown: [], serverTotalWin: 5.52,
  } as unknown as NormalizedSpinResult;
}

const PHANTOM = {
  id: "payout-l1-no-phantom-win",
  description: "A positive win is always backed by at least one winning combo",
  check_code: "getRoundEndSpins(collector.spins).every(s => !(typeof s.winAmount === 'number' && s.winAmount > 0) || (Array.isArray(s.winBreakdown) && s.winBreakdown.length > 0))",
};

test("UNVERIFIED itemization → phantom-win assertion is INCONCLUSIVE, not FAIL", () => {
  const spin = winningSpinNoBreakdown();
  const [r] = evaluateAssertions(spin, [spin], [PHANTOM], { winItemizationVerified: false });
  expect(r.outcome).toBe("INCONCLUSIVE");
  expect(r.pass).toBe(true);              // not a failure → won't red the case
  expect(r.detail).toMatch(/unverified/i);
});

test("VERIFIED itemization → empty breakdown on a win is a REAL phantom-win FAIL", () => {
  const spin = winningSpinNoBreakdown();
  const [r] = evaluateAssertions(spin, [spin], [PHANTOM], { winItemizationVerified: true });
  expect(r.outcome).not.toBe("INCONCLUSIVE");
  expect(r.pass).toBe(false);             // genuine failure preserved
});

test("default (no flag) treats itemization as verified → real failures stand", () => {
  const spin = winningSpinNoBreakdown();
  const [r] = evaluateAssertions(spin, [spin], [PHANTOM]);
  expect(r.pass).toBe(false);
});

test("non-itemization assertion is unaffected by winItemizationVerified=false", () => {
  const spin = winningSpinNoBreakdown();
  const betCheck = { id: "bet-positive", description: "bet > 0", check_code: "spin.betAmount > 0" };
  const [r] = evaluateAssertions(spin, [spin], [betCheck], { winItemizationVerified: false });
  expect(r.outcome).not.toBe("INCONCLUSIVE");
  expect(r.pass).toBe(true);
});

test("properly itemized win passes phantom-win even when unverified (no downgrade needed for a true pass)", () => {
  const spin = { ...winningSpinNoBreakdown(), winBreakdown: [{ symbol: "7", win: 5.52, ways: 4, count: 6, positions: [0, 1], type: "l" }] } as unknown as NormalizedSpinResult;
  // verified=false still downgrades itemization-dependent checks to INCONCLUSIVE
  // (we can't certify the itemization), even though this particular round looks fine.
  const [r] = evaluateAssertions(spin, [spin], [PHANTOM], { winItemizationVerified: false });
  expect(r.outcome).toBe("INCONCLUSIVE");
});
