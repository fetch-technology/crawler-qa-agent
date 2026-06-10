// INVARIANT — per-combo win breakdown (PP wlc_v) parsing + tumble accumulation
//
// The payout-integrity check (Layer 1) relies on Σ(combo wins) == total win.
// That requires (a) parsing the server's `wlc_v` itemization correctly and
// (b) ACCUMULATING combos across cascade/tumble frames — cascade-dedup merges
// frames keeping only the first frame's raw, so without explicit accumulation
// later tumbles' winning combos are lost → false phantom-win failures.

import { test, expect } from "@playwright/test";
import { parseWlcV, sumWinCombos, parseClusterWins } from "../../src/pipeline/step6-build-model/win-breakdown.js";
import { createDedupState, ingestFrame } from "../../src/pipeline/step8-run-scenarios/cascade-dedup.js";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.js";

test("parseWlcV: single combo", () => {
  const combos = parseWlcV({ wlc_v: "8~0.25~2~4~11,12,15,17,18~l" });
  expect(combos).toHaveLength(1);
  expect(combos[0]).toMatchObject({ symbol: "8", win: 0.25, ways: 2, count: 4, type: "l" });
  expect(combos[0]!.positions).toEqual([11, 12, 15, 17, 18]);
});

test("parseWlcV: multiple combos separated by ';'", () => {
  const combos = parseWlcV({ wlc_v: "3~0.75~3~3~0,11,12~l;10~0.03~1~3~1,2,10~l" });
  expect(combos).toHaveLength(2);
  expect(combos[0]).toMatchObject({ symbol: "3", win: 0.75, ways: 3, count: 3 });
  expect(combos[1]).toMatchObject({ symbol: "10", win: 0.03, ways: 1, count: 3 });
});

test("parseWlcV: absent / empty / non-string → []", () => {
  expect(parseWlcV({})).toEqual([]);
  expect(parseWlcV({ wlc_v: "" })).toEqual([]);
  expect(parseWlcV({ wlc_v: 123 as unknown as string })).toEqual([]);
  expect(parseWlcV(null)).toEqual([]);
});

test("parseWlcV: malformed entries are skipped, valid ones kept", () => {
  const combos = parseWlcV({ wlc_v: "garbage;5~0.15~1~3~1,2,3~l;~~~" });
  expect(combos).toHaveLength(1);
  expect(combos[0]!.symbol).toBe("5");
});

test("sumWinCombos sums wins (2dp), tolerant of null", () => {
  expect(sumWinCombos(parseWlcV({ wlc_v: "3~0.75~3~3~~l;10~0.03~1~3~~l" }))).toBe(0.78);
  expect(sumWinCombos(null)).toBe(0);
  expect(sumWinCombos([])).toBe(0);
});

// --- cascade-dedup accumulation ---

function frame(over: Partial<NormalizedSpinResult>): NormalizedSpinResult {
  return {
    roundId: "r1", bet: 0.5, win: 0, balanceBefore: 100, balanceAfter: 100,
    reels: [], cascadeFrames: [], state: "NORMAL", freeSpinsRemaining: null,
    isFreeSpin: false, hasBonus: false, raw: {}, winBreakdown: [], serverTotalWin: 0,
    ...over,
  };
}

test("dedup accumulates winBreakdown across tumble frames; serverTotalWin = latest", () => {
  const st = createDedupState();
  // Frame 1 (initial drop): roundId r1, one combo, tw=0.25
  ingestFrame(st, frame({
    roundId: "r1", balanceBefore: 100, balanceAfter: 100.25,
    winBreakdown: parseWlcV({ wlc_v: "3~0.25~1~3~~l" }), serverTotalWin: 0.25,
  }));
  // Frame 2 (tumble, same roundId): another combo, cumulative tw=0.40
  ingestFrame(st, frame({
    roundId: "r1", balanceBefore: 100, balanceAfter: 100.40,
    winBreakdown: parseWlcV({ wlc_v: "5~0.15~1~3~~l" }), serverTotalWin: 0.40,
  }));
  expect(st.spins).toHaveLength(1);
  const merged = st.spins[0]!;
  expect(merged.winBreakdown).toHaveLength(2);
  expect(sumWinCombos(merged.winBreakdown)).toBe(0.40);
  expect(merged.serverTotalWin).toBe(0.40);
});

test("dedup: separate rounds are NOT merged (each keeps its own breakdown)", () => {
  const st = createDedupState();
  // rA: paid spin, no win (balance drops by the 0.5 bet).
  ingestFrame(st, frame({ roundId: "rA", balanceBefore: 100, balanceAfter: 99.5, winBreakdown: [], serverTotalWin: 0 }));
  // rB: next paid spin — bet 0.5, win 0.25 → balanceAfter = 99.5 - 0.5 + 0.25 = 99.25.
  // The deduction breaks balance-continuity so this is a NEW round, not a merge.
  ingestFrame(st, frame({ roundId: "rB", balanceBefore: 99.5, balanceAfter: 99.25, winBreakdown: parseWlcV({ wlc_v: "3~0.25~1~3~~l" }), serverTotalWin: 0.25 }));
  expect(st.spins).toHaveLength(2);
  expect(sumWinCombos(st.spins[1]!.winBreakdown)).toBe(0.25);
});

// ── Cluster / pays-anywhere format (`l0`,`l1`,…) — vs20fruitsw and similar
// tumble games emit NO `wlc_v`; each cluster is `<marker>~<win>~<pos>~…` and
// the symbol must be read from the reel grid `s` at those positions.

// Real vs20fruitsw frame: l0 positions 3,4,8,9,10,13,14,19 over this grid are
// all symbol "7" → one cluster of 8 paying 0.20.
const FRUIT_GRID = "10,5,5,7,7,4,10,5,7,7,7,3,4,7,7,9,10,3,4,7,8,9,10,9,1,10,8,10,9,9";

test("parseClusterWins resolves symbol from grid, count = cluster size", () => {
  const c = parseClusterWins({ s: FRUIT_GRID, l0: "0~0.20~3~4~8~9~10~13~14~19" });
  expect(c).toHaveLength(1);
  expect(c[0]!.symbol).toBe("7");      // grid value at the cluster positions
  expect(c[0]!.win).toBe(0.20);
  expect(c[0]!.count).toBe(8);          // 8 positions → cluster of 8
  expect(c[0]!.ways).toBe(1);           // no ways multiplier in cluster pays
  expect(c[0]!.type).toBe("cluster");
});

test("parseClusterWins handles multiple clusters (l0 + l1)", () => {
  const c = parseClusterWins({ s: FRUIT_GRID, l0: "0~0.30~7~13~14~18~20~23~24~29", l1: "0~0.05~1~2~8~9~11~15~17~28" });
  expect(c).toHaveLength(2);
  expect(sumWinCombos(c)).toBe(0.35);
});

test("parseWlcV falls back to cluster format when wlc_v is absent", () => {
  const c = parseWlcV({ s: FRUIT_GRID, l0: "0~0.20~3~4~8~9~10~13~14~19" });
  expect(c).toHaveLength(1);
  expect(c[0]!.symbol).toBe("7");
});

test("parseWlcV still prefers wlc_v when present (no cluster fallback)", () => {
  const c = parseWlcV({ wlc_v: "5~0.25~2~4~1,2,3,4~l", s: FRUIT_GRID, l0: "0~9.99~0~1~2" });
  expect(c).toHaveLength(1);
  expect(c[0]!.symbol).toBe("5");       // from wlc_v, NOT the cluster l0
  expect(c[0]!.win).toBe(0.25);
});

test("parseClusterWins returns [] with no grid (can't resolve symbol)", () => {
  expect(parseClusterWins({ l0: "0~0.20~3~4~8" })).toEqual([]);
});

test("parseClusterWins ignores `l` (lines) and zero-win clusters", () => {
  // `l=20` is the line count, not a cluster; a 0-win cluster is not a win.
  const c = parseClusterWins({ s: FRUIT_GRID, l: "20", l0: "0~0~3~4" });
  expect(c).toEqual([]);
});
