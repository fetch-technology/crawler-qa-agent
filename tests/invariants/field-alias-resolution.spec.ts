// INVARIANT — field alias resolution
//
// AI-generated test cases reference fields with varying naming conventions
// (RG/PP/Sweet Bonanza schemas). The engine MUST expose canonical fields PLUS
// well-known aliases through a single adapter, so assertions like
// `s.matrix.length > 0` and `s.id.length > 0` work alongside canonical
// `s.reels` and `s.roundId`.
//
// If broken: assertions silently fail because `undefined.length` throws OR
// returns false → debugging nightmare. False fails block real bug detection.

import { test, expect } from "@playwright/test";
import {
  adaptSpinForAssertions,
  KNOWN_FIELD_NAMES,
} from "../../src/pipeline/step6-build-model/spin-adapter.js";
import { synthSpin } from "./helpers.js";

test("canonical fields are exposed: roundId, bet, win, balanceBefore, balanceAfter, reels, state", () => {
  const spin = synthSpin({
    roundId: "r1", bet: 10, win: 5,
    balanceBefore: 100, balanceAfter: 95,
    state: "NORMAL",
  });
  const a = adaptSpinForAssertions(spin);
  expect(a.roundId).toBe("r1");
  expect(a.bet).toBe(10);
  expect(a.win).toBe(5);
  expect(a.balanceBefore).toBe(100);
  expect(a.balanceAfter).toBe(95);
  expect(a.state).toBe("NORMAL");
  expect(Array.isArray(a.reels)).toBe(true);
});

test("alias `id` resolves to roundId (RG schema convention)", () => {
  const spin = synthSpin({ roundId: "req-1-1" });
  const a = adaptSpinForAssertions(spin);
  expect(a.id).toBe("req-1-1");
  expect(a.id).toBe(a.roundId);
});

test("alias `matrix` resolves to reels (Sweet Bonanza / RG schema)", () => {
  const reels = [["A", "B"], ["C", "D"]];
  const spin = synthSpin({ reels });
  const a = adaptSpinForAssertions(spin);
  expect(a.matrix).toBe(reels);
  expect(a.matrix).toBe(a.reels);
  expect(Array.isArray(a.matrix)).toBe(true);
});

test("alias `grid` resolves to reels (alternative schema)", () => {
  const reels = [["A", "B"], ["C", "D"]];
  const spin = synthSpin({ reels });
  const a = adaptSpinForAssertions(spin);
  expect(a.grid).toBe(reels);
  expect(a.grid).toBe(a.reels);
});

test("aliases `betAmount` ≡ bet, `winAmount` ≡ win", () => {
  const spin = synthSpin({ bet: 10, win: 5 });
  const a = adaptSpinForAssertions(spin);
  expect(a.betAmount).toBe(10);
  expect(a.winAmount).toBe(5);
});

test("aliases `startingBalance` ≡ balanceBefore, `endingBalance` ≡ balanceAfter", () => {
  const spin = synthSpin({ balanceBefore: 100, balanceAfter: 95 });
  const a = adaptSpinForAssertions(spin);
  expect(a.startingBalance).toBe(100);
  expect(a.endingBalance).toBe(95);
});

test("startingBalance is null (not undefined) when balanceBefore is null", () => {
  const spin = synthSpin({ balanceBefore: null });
  const a = adaptSpinForAssertions(spin);
  expect(a.startingBalance).toBe(null);
  expect(a.balanceBefore).toBe(null);
});

test("legacy status field is 'RESOLVED' constant", () => {
  const spin = synthSpin();
  const a = adaptSpinForAssertions(spin);
  expect(a.status).toBe("RESOLVED");
});

test("isEndRound is true when raw.na is 's' OR raw.na is undefined", () => {
  const aWithS = adaptSpinForAssertions(synthSpin({ raw: { na: "s" } }));
  expect(aWithS.isEndRound).toBe(true);
  const aWithUndefined = adaptSpinForAssertions(synthSpin({ raw: {} }));
  expect(aWithUndefined.isEndRound).toBe(true);
  const aWithC = adaptSpinForAssertions(synthSpin({ raw: { na: "c" } }));
  expect(aWithC.isEndRound).toBe(false);
});

test("adapter is pure — same input twice → same output structure", () => {
  const spin = synthSpin({ roundId: "r1", bet: 10, win: 5, balanceBefore: 100, balanceAfter: 95 });
  const a1 = adaptSpinForAssertions(spin);
  const a2 = adaptSpinForAssertions(spin);
  expect(a1).toEqual(a2);
});

test("KNOWN_FIELD_NAMES includes all aliases tested above", () => {
  for (const name of ["id", "matrix", "grid", "betAmount", "winAmount", "startingBalance", "endingBalance"]) {
    expect(KNOWN_FIELD_NAMES.has(name)).toBe(true);
  }
});

test("KNOWN_FIELD_NAMES includes all canonical fields", () => {
  for (const name of ["roundId", "bet", "win", "balanceBefore", "balanceAfter", "reels", "state", "isFreeSpin"]) {
    expect(KNOWN_FIELD_NAMES.has(name)).toBe(true);
  }
});

test("Practical AI-assertion pattern: `s.matrix.length > 0` works for non-empty reels", () => {
  const spin = synthSpin({ reels: [["A", "B"], ["C", "D"]] });
  const a = adaptSpinForAssertions(spin);
  // Cast through unknown to express AI-assertion-style dynamic access.
  const matrix = (a as { matrix?: unknown[] }).matrix;
  expect(Array.isArray(matrix)).toBe(true);
  expect(matrix!.length > 0).toBe(true);
});

test("Practical AI-assertion pattern: `s.id.length > 0` works for non-empty roundId", () => {
  const spin = synthSpin({ roundId: "req-7-3" });
  const a = adaptSpinForAssertions(spin);
  const id = (a as { id?: string }).id;
  expect(typeof id).toBe("string");
  expect(id!.length > 0).toBe(true);
});
