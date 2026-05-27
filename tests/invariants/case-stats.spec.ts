// INVARIANT — case stats (Gap C)
//
// computeStats produces passRate + flakyScore + recent outcomes from history.
// Tests verify formula edges (empty, all-pass, alternating).

import { test, expect } from "@playwright/test";
import { computeStats, flakyTier } from "../../src/pipeline/step8-run-scenarios/history/index.ts";
import type { HistoryEntry } from "../../src/pipeline/step8-run-scenarios/history/index.ts";

function entry(outcome: HistoryEntry["outcome"]): HistoryEntry {
  return {
    ranAt: new Date().toISOString(),
    outcome,
    status: outcome.startsWith("PASS") ? "pass" : outcome.startsWith("FAIL") ? "fail" : "skip",
    durationMs: 1000,
  };
}

test("empty history → zeros", () => {
  const s = computeStats([]);
  expect(s.totalRuns).toBe(0);
  expect(s.passRate).toBe(0);
  expect(s.flakyScore).toBe(0);
});

test("all pass → passRate 1.0, flakyScore 0", () => {
  const s = computeStats([entry("PASS_HIGH"), entry("PASS_HIGH"), entry("PASS_LOW")]);
  expect(s.passRate).toBe(1);
  expect(s.flakyScore).toBe(0);
});

test("all fail → passRate 0, flakyScore 0 (consistent)", () => {
  const s = computeStats([entry("FAIL_HIGH"), entry("FAIL_LOW"), entry("FAIL_HIGH")]);
  expect(s.passRate).toBe(0);
  expect(s.flakyScore).toBe(0);
});

test("alternating P/F (3 of each in window 5) → flakyScore high", () => {
  // Last 5 = P F P F P → min(3,2)*2/5 = 0.8
  const s = computeStats([
    entry("FAIL_HIGH"),
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"),
  ]);
  expect(s.flakyScore).toBeGreaterThan(0.5);
});

test("50/50 perfect split → flakyScore 1.0", () => {
  // Last 5 of 6: P F P F P → 3 pass + 2 fail → 0.8
  // Need EXACT 50/50 in window. Last 4 = P F P F → 1.0
  const s = computeStats([
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"), entry("FAIL_HIGH"),
  ]);
  expect(s.flakyScore).toBe(1);
});

test("passRate counts ALL runs (not just window)", () => {
  // 10 runs: 7 pass, 3 fail → 70% pass rate
  const hist: HistoryEntry[] = [];
  for (let i = 0; i < 7; i++) hist.push(entry("PASS_HIGH"));
  for (let i = 0; i < 3; i++) hist.push(entry("FAIL_HIGH"));
  const s = computeStats(hist);
  expect(s.passRate).toBe(0.7);
});

test("inconclusive runs counted separately", () => {
  const s = computeStats([
    entry("PASS_HIGH"), entry("INCONCLUSIVE"), entry("INCONCLUSIVE"), entry("PASS_HIGH"),
  ]);
  expect(s.passes).toBe(2);
  expect(s.fails).toBe(0);
  expect(s.inconclusives).toBe(2);
  expect(s.passRate).toBe(0.5); // 2 pass / 4 total
});

test("recentOutcomes capped at 10", () => {
  const hist: HistoryEntry[] = [];
  for (let i = 0; i < 20; i++) hist.push(entry(i % 2 === 0 ? "PASS_HIGH" : "FAIL_HIGH"));
  const s = computeStats(hist);
  expect(s.recentOutcomes.length).toBe(10);
});

test("recentOutcomes is most-recent first", () => {
  const hist: HistoryEntry[] = [
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"),
  ];
  const s = computeStats(hist);
  expect(s.recentOutcomes[0]).toBe("PASS_HIGH"); // most recent
});

// === flakyTier ===

test("flakyTier: 0.0 → STABLE", () => expect(flakyTier(0)).toBe("STABLE"));
test("flakyTier: 0.1 → STABLE", () => expect(flakyTier(0.1)).toBe("STABLE"));
test("flakyTier: 0.3 → LOW", () => expect(flakyTier(0.3)).toBe("LOW"));
test("flakyTier: 0.6 → MEDIUM", () => expect(flakyTier(0.6)).toBe("MEDIUM"));
test("flakyTier: 0.9 → HIGH", () => expect(flakyTier(0.9)).toBe("HIGH"));
test("flakyTier: 1.0 → HIGH", () => expect(flakyTier(1.0)).toBe("HIGH"));
