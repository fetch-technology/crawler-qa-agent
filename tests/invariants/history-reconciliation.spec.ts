// INVARIANT — In-game history popup reconciliation (2026-05-26)
//
// Captured spins are matched against rows OCR'd from the game's history
// popup. Mismatch classification powers the per-case history signal
// (missing rows → server didn't persist; field_mismatch → server displayed
// different numbers; extra → stale session rows leaked through).
//
// Tolerance is 0.01 (1 cent for fiat currency), applied to bet / win /
// balance comparisons + tuple fallback matching.

import { test, expect } from "@playwright/test";
import {
  findMatchingRow,
  reconcileSpinsWithRows,
  checkOrdering,
  pickHistoryTrigger,
  HISTORY_TOLERANCE,
} from "../../src/pipeline/step9-verify/history-verifier.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";
import type { TranscribedHistoryRow } from "../../src/ai/vision.ts";
import type { UiRegistry } from "../../src/pipeline/registry/types.ts";

const el = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ x, y, strategy: "coord", ...extra }) as unknown as UiRegistry[string];

// === pickHistoryTrigger ===

test("pickHistoryTrigger: prefers top-level historyButton", () => {
  const reg = { historyButton: el(10, 20), menuButton__historyButton: el(30, 40) } as unknown as UiRegistry;
  const r = pickHistoryTrigger(reg);
  expect(r?.key).toBe("historyButton");
});

test("pickHistoryTrigger: recognizes menuButton__historyButton (nested under menu)", () => {
  // Regression: old code only checked `menu__historyButton`, so the real
  // `menuButton__historyButton` key fell through to the loop and the caller
  // never knew to open the parent menu → clicked empty space → 0/5 matched.
  const reg = { menuButton: el(5, 5), menuButton__historyButton: el(30, 40) } as unknown as UiRegistry;
  const r = pickHistoryTrigger(reg);
  expect(r?.key).toBe("menuButton__historyButton");
  expect(r?.el.x).toBe(30);
  // Parent derivation the verifier relies on:
  expect(r!.key.split("__")[0]).toBe("menuButton");
});

test("pickHistoryTrigger: falls back to any key containing 'history'", () => {
  const reg = { someOther__gameHistoryLink: el(7, 8) } as unknown as UiRegistry;
  expect(pickHistoryTrigger(reg)?.key).toBe("someOther__gameHistoryLink");
});

test("pickHistoryTrigger: null when no history trigger present", () => {
  const reg = { spinButton: el(1, 2), betPlus: el(3, 4) } as unknown as UiRegistry;
  expect(pickHistoryTrigger(reg)).toBeNull();
});

function mkSpin(over: Partial<NormalizedSpinResult> = {}): NormalizedSpinResult {
  return {
    roundId: "abc12345",
    bet: 0.5,
    win: 0,
    balanceBefore: 100,
    balanceAfter: 99.5,
    reels: [],
    cascadeFrames: [],
    state: "NORMAL",
    freeSpinsRemaining: null,
    isFreeSpin: false,
    hasBonus: false,
    raw: {},
    ...over,
  };
}

function mkRow(over: Partial<TranscribedHistoryRow> = {}): TranscribedHistoryRow {
  const base: TranscribedHistoryRow = {
    round_id: "abc12345",
    time: "12:00",
    bet: 0.5,
    win: 0,
    balance_after: 99.5,
    currency: "USD",
    raw_text: "abc12345 12:00 0.5 0 99.5",
  };
  const merged = { ...base, ...over };
  // Auto-sync raw_text with field overrides so test assertions on raw_text work.
  if (over.raw_text === undefined) {
    merged.raw_text = `${merged.round_id ?? ""} ${merged.time ?? ""} ${merged.bet ?? ""} ${merged.win ?? ""} ${merged.balance_after ?? ""}`.trim();
  }
  return merged;
}

// === findMatchingRow ===

test("findMatchingRow: exact round_id match wins over tuple", () => {
  const rows = [
    mkRow({ round_id: "999", bet: 0.5, win: 0, balance_after: 99.5 }),  // tuple match
    mkRow({ round_id: "abc12345", bet: 1.0, win: 5, balance_after: 200 }),  // id match (different tuple)
  ];
  const spin = mkSpin({ roundId: "abc12345", bet: 0.5, win: 0, balanceAfter: 99.5 });
  // Should pick idx 1 (round_id wins)
  expect(findMatchingRow(rows, spin)).toBe(1);
});

test("findMatchingRow: tuple fallback when no round_id match", () => {
  const rows = [
    mkRow({ round_id: "different", bet: 999, win: 999, balance_after: 999 }),
    mkRow({ round_id: null, bet: 0.5, win: 0, balance_after: 99.5 }),
  ];
  const spin = mkSpin({ roundId: "abc12345", bet: 0.5, win: 0, balanceAfter: 99.5 });
  expect(findMatchingRow(rows, spin)).toBe(1);
});

test("findMatchingRow: tolerance ±0.01 — match passes at edge", () => {
  const rows = [
    mkRow({ round_id: "x", bet: 0.5 + 0.005, win: 0, balance_after: 99.5 }),  // within ±0.01
  ];
  const spin = mkSpin({ roundId: "abc12345", bet: 0.5, win: 0, balanceAfter: 99.5 });
  expect(findMatchingRow(rows, spin)).toBe(0);
});

test("findMatchingRow: tolerance ±0.01 — no match beyond edge", () => {
  const rows = [
    mkRow({ round_id: "x", bet: 0.5 + 0.02, win: 0, balance_after: 99.5 }),  // beyond 0.01
  ];
  const spin = mkSpin({ roundId: "abc12345", bet: 0.5, win: 0, balanceAfter: 99.5 });
  expect(findMatchingRow(rows, spin)).toBe(-1);
});

test("findMatchingRow: returns -1 when no row matches", () => {
  const rows = [mkRow({ round_id: "xxx", bet: 99, win: 0, balance_after: 0 })];
  const spin = mkSpin({ roundId: "abc12345", bet: 0.5, win: 0, balanceAfter: 99.5 });
  expect(findMatchingRow(rows, spin)).toBe(-1);
});

test("findMatchingRow: handles empty rows array", () => {
  expect(findMatchingRow([], mkSpin())).toBe(-1);
});

// === reconcileSpinsWithRows ===

test("reconcile: all spins match all rows (clean run) → 0 mismatches", () => {
  const spins = [
    mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 }),
    mkSpin({ roundId: "r2", bet: 0.5, win: 1, balanceAfter: 100 }),
  ];
  const rows = [
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: "r2", bet: 0.5, win: 1, balance_after: 100 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(2);
  expect(result.mismatches).toHaveLength(0);
});

test("reconcile: spin missing from history → 'missing' mismatch", () => {
  const spins = [mkSpin({ roundId: "ghost", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows: TranscribedHistoryRow[] = [];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(0);
  expect(result.mismatches).toHaveLength(1);
  expect(result.mismatches[0]!.kind).toBe("missing");
  expect(result.mismatches[0]!.spinRoundId).toBe("ghost");
});

test("reconcile: row bet differs > tolerance → 'field_mismatch'", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [mkRow({ round_id: "r1", bet: 0.75, win: 0, balance_after: 99.5 })];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  const fm = result.mismatches.find((m) => m.kind === "field_mismatch");
  expect(fm).toBeDefined();
  expect(fm!.detail).toContain("bet mismatch");
});

test("reconcile: row win differs > tolerance → 'field_mismatch'", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 5, balanceAfter: 104.5 })];
  const rows = [mkRow({ round_id: "r1", bet: 0.5, win: 2, balance_after: 104.5 })];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  const fm = result.mismatches.find((m) => m.kind === "field_mismatch");
  expect(fm).toBeDefined();
  expect(fm!.detail).toContain("win mismatch");
});

test("reconcile: row balance differs > tolerance → 'field_mismatch'", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 88.0 })];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  const fm = result.mismatches.find((m) => m.kind === "field_mismatch");
  expect(fm).toBeDefined();
  expect(fm!.detail).toContain("balance mismatch");
});

test("reconcile: history row not matched by any spin → 'extra'", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),  // matched
    mkRow({ round_id: "older", bet: 1.0, win: 50, balance_after: 200 }),  // extra
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  const extras = result.mismatches.filter((m) => m.kind === "extra");
  expect(extras).toHaveLength(1);
  expect(extras[0]!.historyRowText).toContain("older");
});

test("reconcile: extra row without bet/win is silently ignored (OCR junk)", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: null, bet: null, win: null, balance_after: null, raw_text: "ROUND  ----" }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  expect(result.mismatches).toHaveLength(0);  // no extra emitted for junk row
});

test("reconcile: null row fields skip respective check (don't false-flag)", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 5, balanceAfter: 104.5 })];
  const rows = [mkRow({
    round_id: "r1",
    bet: null,           // OCR failed for bet column
    win: 5,
    balance_after: 104.5,
  })];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  expect(result.mismatches).toHaveLength(0);  // null bet → not flagged
});

test("reconcile: ok ignores 'extra' but fails on missing/field_mismatch (used by HistoryVerifyResult.ok)", () => {
  // This invariant pins the public ok semantic — extras are warnings, not fails
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: "older", bet: 1, win: 0, balance_after: 99 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  const nonExtras = result.mismatches.filter((m) => m.kind !== "extra");
  expect(nonExtras).toHaveLength(0);  // ok=true because only extras
});

test("reconcile: ok=false when any missing or field_mismatch present", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [mkRow({ round_id: "r1", bet: 99, win: 0, balance_after: 99.5 })];
  const result = reconcileSpinsWithRows(spins, rows);
  const nonExtras = result.mismatches.filter((m) => m.kind !== "extra");
  expect(nonExtras.length).toBeGreaterThan(0);
});

test("HISTORY_TOLERANCE is 0.01 (cent precision)", () => {
  expect(HISTORY_TOLERANCE).toBe(0.01);
});

// === End-to-end realistic scenarios ===

test("E2E: buy-feature case — BUY row + 3 FS rows all match", () => {
  const spins = [
    mkSpin({ roundId: "buy01", bet: 0.5, win: 0, balanceAfter: 99.5 }),
    mkSpin({ roundId: "fs01", bet: 0, win: 0, balanceAfter: 99.5, isFreeSpin: true, state: "FREE_SPIN" }),
    mkSpin({ roundId: "fs02", bet: 0, win: 5, balanceAfter: 104.5, isFreeSpin: true, state: "FREE_SPIN" }),
    mkSpin({ roundId: "fs03", bet: 0, win: 10, balanceAfter: 114.5, isFreeSpin: true, state: "FREE_SPIN" }),
  ];
  const rows = [
    mkRow({ round_id: "fs03", bet: 0, win: 10, balance_after: 114.5 }),
    mkRow({ round_id: "fs02", bet: 0, win: 5, balance_after: 104.5 }),
    mkRow({ round_id: "fs01", bet: 0, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: "buy01", bet: 0.5, win: 0, balance_after: 99.5 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(4);
  expect(result.mismatches).toHaveLength(0);
});

test("E2E: server dropped middle spin → 1 missing mismatch", () => {
  const spins = [
    mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 }),
    mkSpin({ roundId: "r2", bet: 0.5, win: 0, balanceAfter: 99 }),
    mkSpin({ roundId: "r3", bet: 0.5, win: 5, balanceAfter: 103.5 }),
  ];
  const rows = [
    mkRow({ round_id: "r3", bet: 0.5, win: 5, balance_after: 103.5 }),
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(2);
  const missing = result.mismatches.filter((m) => m.kind === "missing");
  expect(missing).toHaveLength(1);
  expect(missing[0]!.spinRoundId).toBe("r2");
});

// === Ordering check (newest-first vs oldest-first detection + violations) ===

test("checkOrdering: <2 pairs → indeterminate, no violations", () => {
  expect(checkOrdering([])).toEqual({ direction: "indeterminate", violations: [] });
  expect(checkOrdering([{ spinIdx: 0, rowIdx: 5 }])).toEqual({
    direction: "indeterminate",
    violations: [],
  });
});

test("checkOrdering: clean newest-first (spin0→row2, spin1→row1, spin2→row0)", () => {
  const result = checkOrdering([
    { spinIdx: 0, rowIdx: 2 },
    { spinIdx: 1, rowIdx: 1 },
    { spinIdx: 2, rowIdx: 0 },
  ]);
  expect(result.direction).toBe("newest_first");
  expect(result.violations).toHaveLength(0);
});

test("checkOrdering: clean oldest-first (spin0→row0, spin1→row1, spin2→row2)", () => {
  const result = checkOrdering([
    { spinIdx: 0, rowIdx: 0 },
    { spinIdx: 1, rowIdx: 1 },
    { spinIdx: 2, rowIdx: 2 },
  ]);
  expect(result.direction).toBe("oldest_first");
  expect(result.violations).toHaveLength(0);
});

test("checkOrdering: violation when direction reverses partway (newest-first then jumps up)", () => {
  // Started newest-first (row2 → row1) but then jumped to row3 (regression)
  const result = checkOrdering([
    { spinIdx: 0, rowIdx: 2 },
    { spinIdx: 1, rowIdx: 1 },
    { spinIdx: 2, rowIdx: 3 },
  ]);
  expect(result.direction).toBe("newest_first");
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]).toEqual({ spinIdx: 2, rowIdx: 3, prevRowIdx: 1 });
});

test("checkOrdering: same rowIdx between first 2 pairs → indeterminate", () => {
  const result = checkOrdering([
    { spinIdx: 0, rowIdx: 5 },
    { spinIdx: 1, rowIdx: 5 },
  ]);
  expect(result.direction).toBe("indeterminate");
});

test("reconcileSpinsWithRows: returns ordering info alongside mismatches", () => {
  const spins = [
    mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 }),
    mkSpin({ roundId: "r2", bet: 0.5, win: 1, balanceAfter: 100 }),
  ];
  // Newest-first: r2 is row 0, r1 is row 1
  const rows = [
    mkRow({ round_id: "r2", bet: 0.5, win: 1, balance_after: 100 }),
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.ordering.direction).toBe("newest_first");
  expect(result.ordering.violations).toHaveLength(0);
  expect(result.mismatches.filter((m) => m.kind === "ordering")).toHaveLength(0);
});

test("reconcileSpinsWithRows: emits 'ordering' mismatch when direction breaks", () => {
  const spins = [
    mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 }),
    mkSpin({ roundId: "r2", bet: 0.5, win: 1, balanceAfter: 100 }),
    mkSpin({ roundId: "r3", bet: 0.5, win: 0, balanceAfter: 99.5 }),
  ];
  // Newest-first start (r2→row0, r1→row1) then r3→row2 (regression)
  const rows = [
    mkRow({ round_id: "r2", bet: 0.5, win: 1, balance_after: 100 }),
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: "r3", bet: 0.5, win: 0, balance_after: 99.5 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  const orderingMismatches = result.mismatches.filter((m) => m.kind === "ordering");
  expect(orderingMismatches).toHaveLength(1);
  expect(orderingMismatches[0]!.spinRoundId).toBe("r3");
});

test("E2E: leaking older session → extras don't break ok", () => {
  const spins = [mkSpin({ roundId: "r1", bet: 0.5, win: 0, balanceAfter: 99.5 })];
  const rows = [
    mkRow({ round_id: "r1", bet: 0.5, win: 0, balance_after: 99.5 }),
    mkRow({ round_id: "yesterday-1", bet: 2, win: 0, balance_after: 50 }),
    mkRow({ round_id: "yesterday-2", bet: 2, win: 10, balance_after: 60 }),
  ];
  const result = reconcileSpinsWithRows(spins, rows);
  expect(result.matchedCount).toBe(1);
  const extras = result.mismatches.filter((m) => m.kind === "extra");
  expect(extras).toHaveLength(2);
  const nonExtras = result.mismatches.filter((m) => m.kind !== "extra");
  expect(nonExtras).toHaveLength(0);  // run still passes (ok)
});
