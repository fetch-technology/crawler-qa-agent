// INVARIANT — replay determinism (end-to-end pipeline)
//
// Given a fixed sequence of NormalizedSpinResult inputs (simulating captured
// network responses), the engine pipeline must produce DETERMINISTIC outputs:
//   - Same cascade-dedup merge decisions
//   - Same balance conservation evaluations
//   - Same adapter field projections
//
// If broken: re-running the same case on the same network capture gives
// different verdicts → unreliable, can't reproduce bugs.

import { test, expect } from "@playwright/test";
import { createDedupState, ingestFrame } from "../../src/pipeline/step8-run-scenarios/cascade-dedup.js";
import { adaptSpinForAssertions } from "../../src/pipeline/step6-build-model/spin-adapter.js";
import { synthSpin, balanceConserved } from "./helpers.js";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.js";

// === Synthetic captured "session" — 10 rounds, including cascades ===
function buildSession(): NormalizedSpinResult[] {
  // 10 rounds of vs20rnriches-style sequence:
  //   Rounds 1-3 + 5-7 + 10: simple (no cascade)
  //   Round 4: cascade with win
  //   Round 8: cascade with no win (return to bb)
  //   Round 9: 3-frame cascade (big win)
  //
  // Bet=10 throughout, balance starts at 1000.
  const frames: NormalizedSpinResult[] = [];

  // Round 1: normal, no win
  frames.push(synthSpin({ roundId: "r-1-1", bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }));
  // Round 2: normal, no win
  frames.push(synthSpin({ roundId: "r-2-1", bet: 10, win: 0, balanceBefore: 990, balanceAfter: 980 }));
  // Round 3: normal, no win
  frames.push(synthSpin({ roundId: "r-3-1", bet: 10, win: 0, balanceBefore: 980, balanceAfter: 970 }));
  // Round 4: 2-frame cascade, win=5
  frames.push(synthSpin({ roundId: "r-4-1", bet: 10, win: 0, balanceBefore: 970, balanceAfter: 960 }));
  frames.push(synthSpin({ roundId: "r-4-cascade-1", bet: 10, win: 5, balanceBefore: 960, balanceAfter: 965 }));
  // Round 5-7: normal
  frames.push(synthSpin({ roundId: "r-5-1", bet: 10, win: 0, balanceBefore: 965, balanceAfter: 955 }));
  frames.push(synthSpin({ roundId: "r-6-1", bet: 10, win: 0, balanceBefore: 955, balanceAfter: 945 }));
  frames.push(synthSpin({ roundId: "r-7-1", bet: 10, win: 0, balanceBefore: 945, balanceAfter: 935 }));
  // Round 8: cascade with no win (rare but possible)
  frames.push(synthSpin({ roundId: "r-8-1", bet: 10, win: 0, balanceBefore: 935, balanceAfter: 925 }));
  frames.push(synthSpin({ roundId: "r-8-cascade-1", bet: 10, win: 0, balanceBefore: 925, balanceAfter: 925 }));
  // Round 9: 3-frame cascade, win=50
  frames.push(synthSpin({ roundId: "r-9-1", bet: 10, win: 0, balanceBefore: 925, balanceAfter: 915 }));
  frames.push(synthSpin({ roundId: "r-9-cascade-1", bet: 10, win: 20, balanceBefore: 915, balanceAfter: 935 }));
  frames.push(synthSpin({ roundId: "r-9-cascade-2", bet: 10, win: 30, balanceBefore: 935, balanceAfter: 965 }));
  // Round 10: normal
  frames.push(synthSpin({ roundId: "r-10-1", bet: 10, win: 0, balanceBefore: 965, balanceAfter: 955 }));

  return frames;
}

function replay(frames: NormalizedSpinResult[]) {
  const state = createDedupState();
  for (const frame of frames) {
    ingestFrame(state, frame);
  }
  return state.spins;
}

test("dedup produces correct round count (cascade frames merged)", () => {
  const session = buildSession();
  const spins = replay(session);
  // 14 frames → 10 rounds after dedup
  expect(spins.length).toBe(10);
});

test("dedup preserves first round's balanceBefore, takes last round's balanceAfter", () => {
  const session = buildSession();
  const spins = replay(session);
  // Round 4: bb stays 970 (first frame), ba = 965 (cascade frame)
  expect(spins[3]!.balanceBefore).toBe(970);
  expect(spins[3]!.balanceAfter).toBe(965);
  // Round 9: bb stays 925 (first frame), ba = 965 (last cascade frame)
  expect(spins[8]!.balanceBefore).toBe(925);
  expect(spins[8]!.balanceAfter).toBe(965);
});

test("dedup derives correct win from balance delta + bet", () => {
  const session = buildSession();
  const spins = replay(session);
  // Round 4: balanceAfter - balanceBefore + bet = 965 - 970 + 10 = 5
  expect(spins[3]!.win).toBe(5);
  // Round 9: 965 - 925 + 10 = 50
  expect(spins[8]!.win).toBe(50);
});

test("balance conservation holds for every dedup'd round", () => {
  const session = buildSession();
  const spins = replay(session);
  for (const spin of spins) {
    expect(balanceConserved(spin)).toBe(true);
  }
});

test("cumulative balance conservation across all 10 rounds", () => {
  const session = buildSession();
  const spins = replay(session);
  const first = spins[0]!;
  const last = spins[spins.length - 1]!;
  const sumBet = spins.reduce((acc, s) => acc + s.bet, 0);
  const sumWin = spins.reduce((acc, s) => acc + s.win, 0);
  // 10 spins × 10 = 100 bet; wins: 5 + 50 = 55
  expect(sumBet).toBe(100);
  expect(sumWin).toBe(55);
  // start 1000 - 100 + 55 = 955 (last.ba)
  expect(last.balanceAfter).toBe(first.balanceBefore! - sumBet + sumWin);
});

test("replay is deterministic — same input twice → identical state", () => {
  const a = replay(buildSession());
  const b = replay(buildSession());
  expect(a).toEqual(b);
});

test("adapter projection is deterministic across replays", () => {
  const session = buildSession();
  const spinsA = replay(session);
  const spinsB = replay(session);
  const projectedA = spinsA.map(adaptSpinForAssertions);
  const projectedB = spinsB.map(adaptSpinForAssertions);
  expect(projectedA).toEqual(projectedB);
});

test("adapter projection: every spin has matrix (alias of reels)", () => {
  const session = buildSession();
  const spins = replay(session);
  for (const spin of spins) {
    const adapted = adaptSpinForAssertions(spin);
    expect((adapted as { matrix?: unknown[] }).matrix).toBe(spin.reels);
  }
});

test("realistic AI-assertion replay: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`", () => {
  const session = buildSession();
  const spins = replay(session);
  const collector = { spins: spins.map(adaptSpinForAssertions) };
  // The above is exactly the shape AI catalog assertions consume
  const result = collector.spins.every((s) => typeof (s as { id?: unknown }).id === "string" && (s as { id: string }).id.length > 0);
  expect(result).toBe(true);
});

test("realistic AI-assertion replay: `getRoundEndSpins().length >= N` works on adapted spins", () => {
  const session = buildSession();
  const spins = replay(session);
  const adapted = spins.map(adaptSpinForAssertions);
  // Filter end-rounds (isEndRound true). Our synth raw doesn't include `na`,
  // so adapter defaults isEndRound=true for everything → length == spins.length
  const endRounds = adapted.filter((s) => (s as { isEndRound?: boolean }).isEndRound);
  expect(endRounds.length).toBe(spins.length);
});
