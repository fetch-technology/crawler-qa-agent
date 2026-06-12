// INVARIANT — money-flow awareness is LEARNED PER GAME, never assumed:
//   1. classifyBetRatio: ante is a small surcharge — a large ratio is a bet-
//      LEVEL difference, not ante; the learned per-game anteFactor narrows the
//      band further.
//   2. detectFsCreditTiming: whether FS wins credit per-round (immediate) or
//      at chain end (deferred) is classified from the game's OWN balance
//      movement in captured samples — self-validating, coverage-gated.
//   3. Conservation checks consult the learned aspect; unknown → INCONCLUSIVE
//      (only for deferral-consistent mismatches), buy rounds → signature-based
//      skip. No single hardcoded model for all games.

import { test, expect } from "@playwright/test";
import { classifyBetRatio } from "../../src/pipeline/step2-detect-ui/ante-normalize.ts";
import { detectFsCreditTiming } from "../../src/pipeline/step8-run-scenarios/spec-learner.ts";
import { SpecDrivenParser } from "../../src/pipeline/step6-build-model/providers/spec-driven-parser.ts";
import { evaluateBalanceMultiSignal } from "../../src/pipeline/step8-run-scenarios/evidence/balance-multi-signal.ts";
import type { ReplaySample } from "../../src/pipeline/step8-run-scenarios/spec-replay-gate.ts";
import type { ProviderSpec } from "../../src/pipeline/step6-build-model/providers/spec-types.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

// === 1. classifyBetRatio — upper bound + learned factor ===

test("cross-bet-level ratio (20× / 6.25×) is UNKNOWN, never 'on' (ante ≤ ~2×)", () => {
  expect(classifyBetRatio(4, 0.2)).toBe("unknown");    // the cur=4 off=0.2 false positive
  expect(classifyBetRatio(1.25, 0.2)).toBe("unknown"); // the cur=1.25 off=0.2 false positive
});

test("genuine ante band still classifies 'on'; off still 'off'", () => {
  expect(classifyBetRatio(0.25, 0.2)).toBe("on"); // 1.25× — classic ante
  expect(classifyBetRatio(0.38, 0.2)).toBe("on"); // 1.9× — upper ante
  expect(classifyBetRatio(0.2, 0.2)).toBe("off");
});

test("learned per-game anteFactor narrows the 'on' band", () => {
  // game's factor = 1.5 → 1.25× no longer matches it → unknown, 1.5× → on
  expect(classifyBetRatio(0.3, 0.2, 1.5)).toBe("on");      // 1.5×
  expect(classifyBetRatio(0.25, 0.2, 1.5)).toBe("unknown"); // 1.25× outside band
});

// === 2. detectFsCreditTiming — classified from the game's own balances ===

function ppSpec(): ProviderSpec {
  return {
    name: "Pragmatic", wireFormat: "querystring",
    urlPatterns: ["/gs2c/.*gameservice"], nonSpinActions: ["doInit"], spinRequiredParams: ["c"],
    response: {
      fields: { balanceBefore: "bb", balanceAfter: "ba", totalWin: "tw", initialReels: "s", freeSpinsRemaining: "fs", roundIndex: "index" },
      reelsDecoder: "column_major", defaultReelDimensions: { width: 5, height: 3 },
      shapeScore: { requiredFields: ["ba"], bonusFields: ["tw", "index"], minScore: 1 },
    },
    request: { fields: { coin: "c", betLevel: "bl", lines: "l", roundIdParts: ["index", "counter"] }, betFormula: "coin * lines" },
    roundId: { source: "request", fields: ["index", "counter"], format: "req-{0}-{1}", fallback: "response_hash" },
  };
}

// FS frame: fs>0 + bb==ba (no deduction) → SpecDrivenParser flags isFreeSpin.
const fsFrame = (idx: number, win: number, bb: number, ba: number, fs: number): ReplaySample => ({
  request: `action=doSpin&c=0.02&l=20&index=${idx}&counter=2`,
  response: `tw=${win}&fs=${fs}&na=s&bb=${bb}&ba=${ba}&index=1`,
});

test("deferred game (FS wins flat mid-chain) → 'deferred', trusted", () => {
  const samples = [
    fsFrame(1, 0.5, 100, 100, 3), // win but balance flat
    fsFrame(2, 1.2, 100, 100, 2),
    fsFrame(3, 0, 100, 100, 1),
  ];
  const r = detectFsCreditTiming(new SpecDrivenParser(ppSpec(), "PragmaticParser"), samples);
  expect(r.value).toBe("deferred");
  expect(r.trusted).toBe(true);
});

test("immediate game (FS wins credit per round) → 'immediate', trusted", () => {
  const samples = [
    fsFrame(1, 0.5, 100, 100.5, 3),
    fsFrame(2, 1.2, 100.5, 101.7, 2),
  ];
  const r = detectFsCreditTiming(new SpecDrivenParser(ppSpec(), "PragmaticParser"), samples);
  expect(r.value).toBe("immediate");
  expect(r.trusted).toBe(true);
});

test("no FS coverage → null, untrusted (never guesses)", () => {
  const samples: ReplaySample[] = [{
    request: "action=doSpin&c=0.02&l=20&index=1&counter=2",
    response: "tw=0.00&na=s&bb=100&ba=99.6&index=1",
  }];
  const r = detectFsCreditTiming(new SpecDrivenParser(ppSpec(), "PragmaticParser"), samples);
  expect(r.value).toBeNull();
  expect(r.trusted).toBe(false);
});

// === 3. conservation consults the learned aspect ===

const synth = (o: Partial<NormalizedSpinResult>): NormalizedSpinResult => ({
  roundId: "r1", bet: 0.4, win: 0, balanceBefore: 1000, balanceAfter: 999.6,
  reels: [], cascadeFrames: [], state: "NORMAL", isFreeSpin: false, hasBonus: false,
  freeSpinsRemaining: 0, raw: {},
  ...o,
} as NormalizedSpinResult);

test("deferred game: mid-chain FS win with FLAT balance → PASS (not false-fail)", () => {
  const r = evaluateBalanceMultiSignal({
    fsCreditTiming: "deferred",
    spin: synth({ isFreeSpin: true, bet: 0, win: 1.86, balanceBefore: 100, balanceAfter: 100 }),
  });
  expect(r.pass).toBe(true);
});

test("UNKNOWN timing: deferral-consistent FS mismatch → INCONCLUSIVE, not FAIL", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synth({ isFreeSpin: true, bet: 0, win: 1.86, balanceBefore: 100, balanceAfter: 100 }),
  });
  expect(r.outcome).toBe("INCONCLUSIVE");
  expect(r.pass).toBe(true);
  expect(r.detail).toMatch(/fsCreditTiming|deferred/i);
});

test("UNKNOWN timing: FS balance DECREASE is still a hard FAIL (illegal under both models)", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synth({ isFreeSpin: true, bet: 0, win: 0, balanceBefore: 100, balanceAfter: 90 }),
  });
  expect(r.pass).toBe(false);
});

test("deferred game: FS balance DECREASE fails too", () => {
  const r = evaluateBalanceMultiSignal({
    fsCreditTiming: "deferred",
    spin: synth({ isFreeSpin: true, bet: 0, win: 0, balanceBefore: 100, balanceAfter: 90 }),
  });
  expect(r.pass).toBe(false);
});

test("BUY round (signature: feature granted + deduction ≫ bet) → INCONCLUSIVE skip, not bet-conservation FAIL", () => {
  // bet 0.4, buy cost 40 deducted, fs granted → tester's issue 1a round-1.
  const r = evaluateBalanceMultiSignal({
    spin: synth({ bet: 0.4, win: 0, freeSpinsRemaining: 10, balanceBefore: 1000, balanceAfter: 960 }),
  });
  expect(r.outcome).toBe("INCONCLUSIVE");
  expect(r.pass).toBe(true);
  expect(r.detail).toMatch(/buy/i);
});

test("organic FS trigger (deduction == bet, fs granted) is NOT mistaken for a buy", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synth({ bet: 0.4, win: 0, freeSpinsRemaining: 10, balanceBefore: 1000, balanceAfter: 999.6 }),
  });
  expect(r.pass).toBe(true); // normal conservation applies and holds
  expect(r.outcome).not.toBe("INCONCLUSIVE");
});

// No-provider-spec path: fsCreditTiming must be learnable from the game's
// ACTUAL (legacy) parser too — deployments without _providers/pragmatic.json
// previously skipped the learner entirely and never wrote an overlay.
test("detectFsCreditTiming works with the legacy PragmaticParser (deferred game)", async () => {
  const { PragmaticParser } = await import("../../src/pipeline/step6-build-model/providers/pragmatic-parser.ts");
  const p = new PragmaticParser();
  const fs = (idx: number, win: number, bal: number, fsLeft: number) => ({
    request: `action=doSpin&symbol=x&c=0.02&l=20&index=${idx}&counter=2`,
    response: `tw=${win}&w=${win}&fs=${fsLeft}&na=s&bb=${bal}&ba=${bal}&balance=${bal}&index=1&s=1,2,3,4,5,6,7,8,9,1,2,3,4,5,6&sh=3`,
  });
  const r = detectFsCreditTiming(p, [fs(1, 0.5, 100, 3), fs(2, 1.2, 100, 2)]);
  expect(r.value).toBe("deferred");
  expect(r.trusted).toBe(true);
});
