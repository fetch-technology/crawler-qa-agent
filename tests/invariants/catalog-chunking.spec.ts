// INVARIANT — Catalog EXPAND chunking + merge (2026-05-27)
//
// EXPAND no longer expands all 30-40 stubs in one call (attention dilution +
// truncation risk). It chunks stubs into small batches, expands them in
// parallel (cached sourceBlock), and merges results. These pure helpers back
// that flow; the model call itself (catalogCall) needs the network so isn't
// unit-tested here.

import { test, expect } from "@playwright/test";
import { chunkStubs, mergeExpandedBatches, mapLimit } from "../../src/ai/catalog-llm.ts";

// === chunkStubs ===

test("chunkStubs: 37 items, size 7 → 6 batches (last partial)", () => {
  const items = Array.from({ length: 37 }, (_, i) => i);
  const batches = chunkStubs(items, 7);
  expect(batches.length).toBe(6);
  expect(batches.slice(0, 5).every((b) => b.length === 7)).toBe(true);
  expect(batches[5]!.length).toBe(2); // 37 - 35
  // No item lost or duplicated.
  expect(batches.flat()).toEqual(items);
});

test("chunkStubs: exact multiple → even batches", () => {
  const batches = chunkStubs([1, 2, 3, 4, 5, 6], 3);
  expect(batches).toEqual([[1, 2, 3], [4, 5, 6]]);
});

test("chunkStubs: size >= length → single batch", () => {
  expect(chunkStubs([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
});

test("chunkStubs: empty → []", () => {
  expect(chunkStubs([], 7)).toEqual([]);
});

test("chunkStubs: size < 1 clamps to 1 (one item per batch)", () => {
  expect(chunkStubs([1, 2], 0)).toEqual([[1], [2]]);
  expect(chunkStubs([1, 2], -5)).toEqual([[1], [2]]);
});

// === mergeExpandedBatches ===

test("mergeExpandedBatches: concatenates in batch order", () => {
  const merged = mergeExpandedBatches([
    [{ id: "a" }, { id: "b" }],
    [{ id: "c" }],
  ]);
  expect(merged.map((c) => c.id)).toEqual(["a", "b", "c"]);
});

test("mergeExpandedBatches: dedups by id (first wins)", () => {
  const merged = mergeExpandedBatches([
    [{ id: "a", v: 1 }],
    [{ id: "a", v: 2 }, { id: "b" }],
  ]);
  expect(merged.map((c) => c.id)).toEqual(["a", "b"]);
  expect((merged[0] as { v: number }).v).toBe(1); // first occurrence kept
});

test("mergeExpandedBatches: skips entries without a string id", () => {
  const merged = mergeExpandedBatches([
    [{ id: "a" }, { id: "" }, { id: 5 as unknown as string }, { name: "x" } as { id?: unknown }],
    [{ id: "b" }],
  ]);
  expect(merged.map((c) => c.id)).toEqual(["a", "b"]);
});

test("mergeExpandedBatches: tolerates non-array / empty batches (failed batch)", () => {
  const merged = mergeExpandedBatches([
    [{ id: "a" }],
    [], // a batch that parse-failed → empty
    [{ id: "b" }],
  ]);
  expect(merged.map((c) => c.id)).toEqual(["a", "b"]);
});

test("mergeExpandedBatches: all batches empty → []", () => {
  expect(mergeExpandedBatches([[], []])).toEqual([]);
});

// === mapLimit ===

test("mapLimit: preserves result order regardless of completion order", async () => {
  const items = [50, 10, 30, 5, 40];
  const out = await mapLimit(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  // Results indexed by input position, not completion time.
  expect(out).toEqual(["0:50", "1:10", "2:30", "3:5", "4:40"]);
});

test("mapLimit: respects concurrency cap (never more than N in flight)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapLimit(items, 3, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  });
  expect(maxInFlight).toBeLessThanOrEqual(3);
});

test("mapLimit: empty input → []", async () => {
  expect(await mapLimit([], 4, async () => 1)).toEqual([]);
});

test("REGRESSION: 40-stub plan → batched + merged preserves all ids in order", () => {
  const stubs = Array.from({ length: 40 }, (_, i) => ({ id: `case-${i}`, category: "base_game" }));
  const batches = chunkStubs(stubs, 7);
  expect(batches.length).toBe(6);
  // Simulate each batch expanding to the same ids it received.
  const merged = mergeExpandedBatches(batches.map((b) => b.map((s) => ({ id: s.id }))));
  expect(merged.length).toBe(40);
  expect(merged.map((c) => c.id)).toEqual(stubs.map((s) => s.id));
});
