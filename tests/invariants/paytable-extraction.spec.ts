// INVARIANT — C1: paytable extraction wired end-to-end
//
// Two pure pieces are testable without browser:
//   1. convertToRegistryPaytable (deep-extract.ts) — auxiliary-sources
//      `PaytableStructured` → registry `Paytable` shape
//   2. paytableToGameSpecSymbols (build-game-spec.ts) — registry `Paytable`
//      → `GameSpec.symbols[]`
//
// Together they prove: when cold-start's deep-extract step succeeds,
// GameSpec.symbols[] is hydrated with concrete OCR data instead of empty.

import { test, expect } from "@playwright/test";
import { convertToRegistryPaytable, mergePaytables, findPaginationButton } from "../../src/pipeline/step4-feature-discovery/deep-extract.ts";
import { paytableToGameSpecSymbols } from "../../src/pipeline/step7-testcase-gen/build-game-spec.ts";
import type { Paytable, UiRegistry } from "../../src/pipeline/registry/types.ts";

test("convert: AI-vision shape → registry Paytable", () => {
  const src = {
    symbols: [
      { id: "H1", name: "Crown", multipliers: { "3": 1.5, "4": 5, "5": 25 } },
      { id: "L1", name: "Nine", multipliers: { "3": 0.3, "4": 0.5, "5": 2 } },
    ],
    features: [{ name: "Free Spins", trigger: "3 scatters", description: "10 free spins" }],
  };
  const out = convertToRegistryPaytable(src);
  expect(out.symbols.length).toBe(2);
  expect(out.symbols[0]).toEqual({
    symbol: "H1",
    name: "Crown",
    payouts: [{ count: 3, multiplier: 1.5 }, { count: 4, multiplier: 5 }, { count: 5, multiplier: 25 }],
  });
  expect(out.features?.[0]).toEqual({ name: "Free Spins", description: "10 free spins" });
});

test("convert: string multipliers with 'x' prefix parsed", () => {
  const src = {
    symbols: [{ id: "H1", name: "Crown", multipliers: { "3": "x5", "4": "x20", "5": "x100" } as unknown as Record<string, number> }],
  };
  const out = convertToRegistryPaytable(src);
  expect(out.symbols[0]!.payouts).toEqual([
    { count: 3, multiplier: 5 },
    { count: 4, multiplier: 20 },
    { count: 5, multiplier: 100 },
  ]);
});

test("convert: cluster ranges 'x-y' silently skipped (rule engine handles cluster math)", () => {
  const src = {
    symbols: [{
      id: "H1",
      name: "Watermelon",
      multipliers: { "3-5": 5, "6-8": 10, "9": 25, "10+": 100 } as unknown as Record<string, number>,
    }],
  };
  const out = convertToRegistryPaytable(src);
  // Only "9" (integer count) survives; "3-5", "6-8", "10+" are skipped
  expect(out.symbols[0]!.payouts).toEqual([{ count: 9, multiplier: 25 }]);
});

test("convert: symbol with zero parseable payouts is dropped", () => {
  const src = {
    symbols: [
      { id: "BAD", name: "Junk", multipliers: { "abc": "xyz" } as unknown as Record<string, number> },
      { id: "OK", name: "Crown", multipliers: { "3": 5 } },
    ],
  };
  const out = convertToRegistryPaytable(src);
  expect(out.symbols.length).toBe(1);
  expect(out.symbols[0]!.symbol).toBe("OK");
});

test("convert: empty input → empty paytable, no throw", () => {
  expect(convertToRegistryPaytable({})).toEqual({ symbols: [], features: [] });
  expect(convertToRegistryPaytable({ symbols: [] })).toEqual({ symbols: [], features: [] });
});

test("paytableToGameSpecSymbols: empty paytable → empty symbols", () => {
  expect(paytableToGameSpecSymbols(null)).toEqual([]);
  expect(paytableToGameSpecSymbols(undefined)).toEqual([]);
  expect(paytableToGameSpecSymbols({ symbols: [] })).toEqual([]);
});

test("paytableToGameSpecSymbols: normal high-value symbol → PICTURE_SYMBOL", () => {
  const pt: Paytable = {
    symbols: [{ symbol: "H1", name: "Crown", payouts: [{ count: 3, multiplier: 1.5 }, { count: 4, multiplier: 5 }, { count: 5, multiplier: 25 }] }],
  };
  const out = paytableToGameSpecSymbols(pt);
  expect(out).toEqual([{
    code: "H1",
    name: "Crown",
    type: "PICTURE_SYMBOL",
    multipliers: { "3": "x1.5", "4": "x5", "5": "x25" },
    note: null,
  }]);
});

test("paytableToGameSpecSymbols: wild symbol detected by name", () => {
  const pt: Paytable = {
    symbols: [{ symbol: "W", name: "Wild", payouts: [{ count: 5, multiplier: 100 }] }],
  };
  expect(paytableToGameSpecSymbols(pt)[0]!.type).toBe("WILD");
});

test("paytableToGameSpecSymbols: scatter detected", () => {
  const pt: Paytable = {
    symbols: [{ symbol: "S", name: "Scatter Bonus", payouts: [{ count: 3, multiplier: 5 }] }],
  };
  expect(paytableToGameSpecSymbols(pt)[0]!.type).toBe("SCATTER");
});

test("end-to-end: auxiliary-sources shape → GameSpec.symbols[] populated", () => {
  // The full chain that runs at cold-start:
  //   deep-extract OCR popup → PaytableStructured → registry Paytable
  //   → buildGameSpec reads registry → GameSpec.symbols[] for AI catalog
  const auxStructured = {
    symbols: [
      { id: "H1", name: "Crown", multipliers: { "3": 1.5, "4": 5, "5": 25 } },
      { id: "SC", name: "Free Spins Scatter", multipliers: { "3": 100 } },
    ],
  };
  const registry = convertToRegistryPaytable(auxStructured);
  const gameSpecSymbols = paytableToGameSpecSymbols(registry);
  expect(gameSpecSymbols.length).toBe(2);
  expect(gameSpecSymbols[1]!.type).toBe("SCATTER");
  expect(gameSpecSymbols[1]!.multipliers).toEqual({ "3": "x100" });
});

// === Multi-page paytable merge (pagination) ===

test("mergePaytables: unions symbols from different pages", () => {
  const merged = mergePaytables([
    { symbols: [{ id: "H1", name: "Crown", multipliers: { "3": 5, "4": 20, "5": 100 } }] },
    { symbols: [{ id: "H2", name: "Ring", multipliers: { "3": 4, "4": 15, "5": 80 } }] },
  ]);
  expect(merged.symbols).toHaveLength(2);
  expect(merged.symbols!.map((s) => s.id)).toEqual(["H1", "H2"]);
});

test("mergePaytables: dedups same symbol id across pages, fills missing multipliers", () => {
  const merged = mergePaytables([
    { symbols: [{ id: "H1", name: "Crown", multipliers: { "3": 5 } }] },
    { symbols: [{ id: "H1", name: "Crown", multipliers: { "4": 20, "5": 100 } }] }, // same id, more counts
  ]);
  expect(merged.symbols).toHaveLength(1);
  expect(merged.symbols![0]!.multipliers).toEqual({ "3": 5, "4": 20, "5": 100 });
});

test("mergePaytables: dedup falls back to name when id missing", () => {
  const merged = mergePaytables([
    { symbols: [{ name: "Wild", multipliers: { "5": 50 } }] },
    { symbols: [{ name: "Wild", multipliers: { "4": 10 } }] },
  ]);
  expect(merged.symbols).toHaveLength(1);
  expect(merged.symbols![0]!.multipliers).toEqual({ "5": 50, "4": 10 });
});

test("mergePaytables: existing multiplier value is NOT overwritten by later page", () => {
  const merged = mergePaytables([
    { symbols: [{ id: "H1", name: "Crown", multipliers: { "3": 5 } }] },
    { symbols: [{ id: "H1", name: "Crown", multipliers: { "3": 999 } }] }, // conflicting — first wins
  ]);
  expect(merged.symbols![0]!.multipliers["3"]).toBe(5);
});

test("mergePaytables: features deduped by name; rtp/maxWin/wild take first non-empty", () => {
  const merged = mergePaytables([
    { features: [{ name: "Free Spins", trigger: "3 scatter", description: "10 spins" }], rtp: 96.5 },
    { features: [{ name: "Free Spins", trigger: "x", description: "y" }, { name: "Multiplier", trigger: "z", description: "w" }], rtp: 90, wild: { rules: "subs all", substitutes: ["H1"] } },
  ]);
  expect(merged.features).toHaveLength(2);
  expect(merged.features!.map((f) => f.name)).toEqual(["Free Spins", "Multiplier"]);
  expect(merged.rtp).toBe(96.5); // first non-null wins
  expect(merged.wild?.rules).toBe("subs all");
});

test("mergePaytables: empty pages → empty result (no throw)", () => {
  const merged = mergePaytables([]);
  expect(merged.symbols).toEqual([]);
  expect(merged.features).toEqual([]);
});

test("mergePaytables: skips symbols with empty id+name key", () => {
  const merged = mergePaytables([
    { symbols: [{ id: "", name: "", multipliers: { "3": 5 } }] },
  ]);
  expect(merged.symbols).toHaveLength(0);
});

test("REGRESSION: 7-page paytable merges all symbol pages (no single-page truncation)", () => {
  // Replicates the bug: previously only page 1 was extracted. Now all pages merge.
  const pages = Array.from({ length: 7 }, (_, i) => ({
    symbols: [{ id: `S${i}`, name: `Symbol ${i}`, multipliers: { "3": i + 1 } }],
  }));
  const merged = mergePaytables(pages);
  expect(merged.symbols).toHaveLength(7);
});

// === findPaginationButton: prefer QA-verified registry next-arrow ===

function el(x: number, y: number, status?: "verified" | "pending" | "rejected") {
  return { x, y, strategy: "ai_vision" as const, confidence: 0.8, detectedAt: "t", status };
}

test("findPaginationButton: matches nextButton under the trigger namespace", () => {
  const reg: UiRegistry = {
    paytableButton: el(10, 10),
    "paytableButton__nextButton": el(940, 540, "verified"),
    "paytableButton__closeButton": el(900, 60),
  };
  const found = findPaginationButton(reg, "paytableButton");
  expect(found?.x).toBe(940);
});

test("findPaginationButton: verified wins over pending", () => {
  const reg: UiRegistry = {
    "paytableButton__nextButton": el(100, 100, "pending"),
    "paytableButton__nextPage": el(940, 540, "verified"),
  };
  const found = findPaginationButton(reg, "paytableButton");
  expect(found?.x).toBe(940); // the verified one
});

test("findPaginationButton: matches name variants (nextPage, rightArrow)", () => {
  expect(findPaginationButton({ "paytableButton__nextPage": el(5, 5) }, "paytableButton")?.x).toBe(5);
  expect(findPaginationButton({ "paytableButton__rightArrow": el(6, 6) }, "paytableButton")?.x).toBe(6);
});

test("findPaginationButton: does NOT match closeButton / unrelated keys", () => {
  const reg: UiRegistry = {
    "paytableButton__closeButton": el(900, 60),
    "paytableButton__prevButton": el(40, 540),
  };
  expect(findPaginationButton(reg, "paytableButton")).toBeNull();
});

test("findPaginationButton: ignores buttons under a DIFFERENT trigger", () => {
  const reg: UiRegistry = { "autoButton__nextButton": el(940, 540, "verified") };
  expect(findPaginationButton(reg, "paytableButton")).toBeNull();
});

test("findPaginationButton: null when no pagination button discovered", () => {
  expect(findPaginationButton({ paytableButton: el(10, 10) }, "paytableButton")).toBeNull();
});
