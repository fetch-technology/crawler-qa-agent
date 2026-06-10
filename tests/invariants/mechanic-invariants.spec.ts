// INVARIANT — per-mechanic crown-jewel helpers (Phase 6). Pure geometry +
// well-formedness checks over winBreakdown combos.

import { test, expect } from "@playwright/test";
import { comboWellFormed, distinctReels, clusterConnected } from "../../src/pipeline/step8-run-scenarios/mechanic-invariants.ts";

// === comboWellFormed (robust, no grid) ===

test("comboWellFormed accepts a sound ways combo", () => {
  expect(comboWellFormed({ symbol: "7", win: 3.2, ways: 4, count: 6, positions: [0, 1, 4, 7, 9, 11] })).toBe(true);
});

test("comboWellFormed rejects empty positions", () => {
  expect(comboWellFormed({ win: 0.5, count: 3, positions: [] })).toBe(false);
});

test("comboWellFormed rejects count > positions (inflated reel count)", () => {
  expect(comboWellFormed({ win: 0.5, count: 5, positions: [0, 1] })).toBe(false);
});

test("comboWellFormed rejects NaN / negative win", () => {
  expect(comboWellFormed({ win: NaN, count: 1, positions: [0] })).toBe(false);
  expect(comboWellFormed({ win: -1, count: 1, positions: [0] })).toBe(false);
});

test("comboWellFormed rejects null/garbage", () => {
  expect(comboWellFormed(null)).toBe(false);
  expect(comboWellFormed({})).toBe(false);
});

// === distinctReels (column-major, height-based) ===

test("distinctReels counts unique reel columns (height=3)", () => {
  // positions 0,1,2 → reel 0; 3 → reel 1; 6,7 → reel 2
  expect(distinctReels([0, 1, 2, 3, 6, 7], 3)).toBe(3);
});

test("distinctReels = ways combo's reel count (matches `count`)", () => {
  // a 3-reel ways win across reels 0,1,2 (one cell each)
  expect(distinctReels([0, 3, 6], 3)).toBe(3);
});

test("distinctReels guards bad input", () => {
  expect(distinctReels([], 3)).toBe(0);
  expect(distinctReels([0, 1], 0)).toBe(0);
});

// === clusterConnected (4-adjacency, width×height column-major) ===

test("clusterConnected: vertical adjacent cells in one reel are connected", () => {
  // 5x3 grid, reel 0 = positions 0,1,2 (col-major). 0-1-2 vertically adjacent.
  expect(clusterConnected([0, 1, 2], 5, 3)).toBe(true);
});

test("clusterConnected: horizontally adjacent across reels connected", () => {
  // pos 0 (reel0,row0) and pos 3 (reel1,row0) are horizontal neighbors
  expect(clusterConnected([0, 3], 5, 3)).toBe(true);
});

test("clusterConnected: disjoint cells are NOT connected", () => {
  // pos 0 (reel0,row0) and pos 8 (reel2,row2) — not adjacent, nothing between
  expect(clusterConnected([0, 8], 5, 3)).toBe(false);
});

test("clusterConnected: L-shaped connected cluster", () => {
  // 0(r0,c0),1(r0,c1),4(r1,c1) → 0-1 vertical, 1-4 horizontal → connected
  expect(clusterConnected([0, 1, 4], 5, 3)).toBe(true);
});

test("clusterConnected: singleton / empty trivially connected", () => {
  expect(clusterConnected([5], 5, 3)).toBe(true);
  expect(clusterConnected([], 5, 3)).toBe(true);
});

test("clusterConnected: off-grid position → false", () => {
  expect(clusterConnected([0, 99], 5, 3)).toBe(false);
});
