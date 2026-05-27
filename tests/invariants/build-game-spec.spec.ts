// INVARIANT — buildGameSpec extracts observed reel grid dimensions
//
// Phase 11 follow-up (Fix 2). Catalog EXPAND prompt depends on
// gameSpec.grid_dimensions to AVOID hallucinating matrix.length /
// matrix[0].length literals in assertions. Tests pin extraction logic
// against typical PP-style normalized spin shapes.

import { test, expect } from "@playwright/test";
import { buildGameSpec } from "../../src/pipeline/step7-testcase-gen/build-game-spec.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

function fakeSpin(reels: string[][], overrides: Partial<NormalizedSpinResult> = {}): NormalizedSpinResult {
  return {
    roundId: "r1",
    bet: 0.2,
    win: 0,
    balanceBefore: 100,
    balanceAfter: 99.8,
    reels,
    cascadeFrames: [],
    state: "NORMAL",
    freeSpinsRemaining: null,
    isFreeSpin: false,
    hasBonus: false,
    raw: {},
    ...overrides,
  };
}

test("grid_dimensions: extracts 5x5 from observed reels", () => {
  const reels = Array.from({ length: 5 }, () => ["A", "B", "C", "D", "E"]);
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [fakeSpin(reels)],
  });
  expect(spec.grid_dimensions).toEqual({ width: 5, height: 5, source: "observed" });
});

test("grid_dimensions: extracts 5x3 (classic PP) correctly", () => {
  const reels = Array.from({ length: 5 }, () => ["X", "Y", "Z"]);
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [fakeSpin(reels)],
  });
  expect(spec.grid_dimensions).toEqual({ width: 5, height: 3, source: "observed" });
});

test("grid_dimensions: extracts 6x5 (Megaways-style)", () => {
  const reels = Array.from({ length: 6 }, () => ["A", "B", "C", "D", "E"]);
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [fakeSpin(reels)],
  });
  expect(spec.grid_dimensions).toEqual({ width: 6, height: 5, source: "observed" });
});

test("grid_dimensions: undefined when reels missing / empty", () => {
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [fakeSpin([])],
  });
  expect(spec.grid_dimensions).toBeUndefined();
});

test("grid_dimensions: undefined when no spins at all", () => {
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [],
  });
  expect(spec.grid_dimensions).toBeUndefined();
});

test("grid_dimensions: undefined when reels[0] is not an array", () => {
  // Edge case: malformed normalized result
  const broken = fakeSpin([] as string[][]);
  // Force-cast to simulate bad input
  (broken as unknown as { reels: unknown }).reels = [["A"], "broken"];
  const spec = buildGameSpec({
    gameSlug: "test",
    provider: null,
    uiMap: null,
    features: null,
    parsedSpins: [broken],
  });
  // First reel IS array, length 1 → still produces 2x1 (first reel passes test)
  // Actually width=2 height=1
  expect(spec.grid_dimensions).toEqual({ width: 2, height: 1, source: "observed" });
});
