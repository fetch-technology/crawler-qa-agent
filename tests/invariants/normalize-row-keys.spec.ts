// INVARIANT — replay-stable discovered row keys (manual-session)
//
// The AI sometimes names a repeated row list (history "expand row" buttons) by
// the row's SESSION/SPIN ID instead of a positional index — those IDs change
// every run, so a testcase referencing `expandRow-01KV9GTV…` never matches on
// replay. normalizeVolatileRowKeys renumbers id-suffixed bases to a positional
// index by vertical row order, while leaving meaningful numeric/value suffixes
// (bet chips, autoplay counts) untouched.

import { test, expect } from "@playwright/test";
import { normalizeVolatileRowKeys } from "../../src/pipeline/server/manual-session.ts";

type E = { key: string; x: number; y: number };
const keys = (els: E[]) => els.map((e) => e.key);

test("id-suffixed rows → positional index by vertical order", () => {
  const els: E[] = [
    { key: "expandRow-01KV9GTV09T42P5TRF3YYSKS3Y", x: 100, y: 300 },
    { key: "expandRow-Xhsahdytdgw7281", x: 100, y: 150 },
    { key: "expandRow-9ZZqweRt44", x: 100, y: 450 },
  ];
  normalizeVolatileRowKeys(els);
  // sorted by y: 150, 300, 450 → 1, 2, 3
  expect(els.find((e) => e.y === 150)!.key).toBe("expandRow-1");
  expect(els.find((e) => e.y === 300)!.key).toBe("expandRow-2");
  expect(els.find((e) => e.y === 450)!.key).toBe("expandRow-3");
});

test("mixed index + id suffixes → all renumbered positionally (consistent)", () => {
  const els: E[] = [
    { key: "expandRow-1", x: 10, y: 100 },
    { key: "expandRow-AbcDefGhij", x: 10, y: 200 },
  ];
  normalizeVolatileRowKeys(els);
  expect(keys(els).sort()).toEqual(["expandRow-1", "expandRow-2"]);
});

test("numeric/value suffixes are NOT touched (bet chips, autoplay counts)", () => {
  const els: E[] = [
    { key: "bet-0.40", x: 10, y: 100 },
    { key: "bet-0.20", x: 10, y: 200 },
    { key: "autoCountSlide-10", x: 10, y: 300 },
    { key: "autoCountSlide-100", x: 10, y: 400 },
  ];
  normalizeVolatileRowKeys(els);
  expect(keys(els)).toEqual(["bet-0.40", "bet-0.20", "autoCountSlide-10", "autoCountSlide-100"]);
});

test("keys without a '-' suffix are untouched", () => {
  const els: E[] = [
    { key: "closeButton", x: 10, y: 10 },
    { key: "refreshButton", x: 20, y: 10 },
    { key: "freeSpinsTab", x: 30, y: 10 },
  ];
  normalizeVolatileRowKeys(els);
  expect(keys(els)).toEqual(["closeButton", "refreshButton", "freeSpinsTab"]);
});

test("single id-suffixed row is still normalized to -1", () => {
  const els: E[] = [{ key: "expandRow-01KV9GTV09T42P5TRF3YYSKS3Y", x: 5, y: 5 }];
  normalizeVolatileRowKeys(els);
  expect(els[0]!.key).toBe("expandRow-1");
});

test("an already-clean positional list is left as-is", () => {
  const els: E[] = [
    { key: "expandRow-1", x: 10, y: 100 },
    { key: "expandRow-2", x: 10, y: 200 },
    { key: "expandRow-3", x: 10, y: 300 },
  ];
  normalizeVolatileRowKeys(els);
  expect(keys(els)).toEqual(["expandRow-1", "expandRow-2", "expandRow-3"]);
});
