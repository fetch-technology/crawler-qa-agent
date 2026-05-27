// INVARIANT — Expected spin count derivation (2026-05-26)
//
// Network signal rollup compares captured spins against an expected count.
// Old behavior: count = number of explicit `spin` actions. Broke for
// autoplay UI flow (PATH 2) cases where actions are `click autoButton →
// click slider → click start` (0 spin actions) but assertions expect N rounds.
//
// New behavior: when no explicit spins AND case is autoplay-shaped, parse
// `collector.spins.length >= N` from custom assertions.

import { test, expect } from "@playwright/test";
import { deriveExpectedSpinCount } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

test("explicit spin actions: returns the count", () => {
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "spin" }, { kind: "wait_ms" }, { kind: "spin" }, { kind: "spin" }],
    category: "base_game",
    customAssertions: [],
    setupBlob: "",
  })).toBe(3);
});

test("UI-only (no spin actions, no autoplay): returns 0", () => {
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "click" }, { kind: "wait_ms" }, { kind: "click" }],
    category: "options",
    customAssertions: [],
    setupBlob: "options menu inspection",
  })).toBe(0);
});

test("autoplay PATH 2 (category=autoplay, 0 spins, assertion expects 30): returns 30", () => {
  expect(deriveExpectedSpinCount({
    actions: [
      { kind: "click" },        // autoButton
      { kind: "wait_ms" },
      { kind: "click" },        // slider preset
      { kind: "click" },        // start
      { kind: "wait_until_state" },
    ],
    category: "autoplay",
    customAssertions: [
      { check_code: "getRoundEndSpins(collector.spins).length >= 30" },
      { check_code: "new Set(collector.spins.map(s => s.id)).size === collector.spins.length" },
    ],
    setupBlob: "auto30 autoplay 30 rounds",
  })).toBe(30);
});

test("autoplay PATH 2 with wait_until_no_spin_response: returns expected count from assertion", () => {
  // New action variant — also signals autoplay shape regardless of category
  expect(deriveExpectedSpinCount({
    actions: [
      { kind: "click" },
      { kind: "click" },
      { kind: "click" },
      { kind: "wait_until_no_spin_response" },
    ],
    category: "other",  // category doesn't say autoplay
    customAssertions: [
      { check_code: "collector.spins.length >= 50" },
    ],
    setupBlob: "non-obvious shape",
  })).toBe(50);
});

test("autoplay without numeric assertion: falls back to 1 (at least one spin expected)", () => {
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "click" }, { kind: "wait_until_no_spin_response" }],
    category: "autoplay",
    customAssertions: [
      { check_code: "collector.spins.length > 0" },  // doesn't match >= N pattern
    ],
    setupBlob: "autoplay test",
  })).toBe(1);
});

test("autoplay with both length patterns: picks the larger N", () => {
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "click" }, { kind: "wait_until_no_spin_response" }],
    category: "autoplay",
    customAssertions: [
      { check_code: "getRoundEndSpins(collector.spins).length >= 10" },
      { check_code: "collector.spins.length >= 25" },  // larger
    ],
    setupBlob: "autoplay-25",
  })).toBe(25);
});

test("setupBlob containing 'autoplay': triggers autoplay shape detection", () => {
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "click" }, { kind: "click" }],
    category: "other",  // category misleading
    customAssertions: [
      { check_code: "collector.spins.length >= 20" },
    ],
    setupBlob: "auto20-test autoplay panel 20 spins",  // setup blob signals autoplay
  })).toBe(20);
});

test("explicit spins take priority over autoplay detection", () => {
  // Mixed shape — both spin actions AND autoplay category. Use explicit count.
  expect(deriveExpectedSpinCount({
    actions: [{ kind: "spin" }, { kind: "spin" }],
    category: "autoplay",
    customAssertions: [
      { check_code: "collector.spins.length >= 30" },  // would suggest 30
    ],
    setupBlob: "autoplay",
  })).toBe(2);  // explicit spins win
});

test("REGRESSION: user's auto30-round-count case shape", () => {
  // User-reported: 30-rounds autoplay case, 13/30 spins captured, Network
  // signal said "expected 0 (UI-only case)" — wrong classification.
  // Post-fix: expectedSpinCount should be 30.
  const result = deriveExpectedSpinCount({
    actions: [
      { kind: "click" },        // autoButton
      { kind: "wait_ms" },
      { kind: "click" },        // autoCountSlide-30
      { kind: "wait_ms" },
      { kind: "click" },        // startAutoplayButton
      { kind: "wait_until_network_idle" },
      { kind: "wait_until_state" },  // (old action — should still work)
    ],
    category: "autoplay",
    customAssertions: [
      { check_code: "getRoundEndSpins(collector.spins).length >= 30" },
      { check_code: "new Set(collector.spins.map(s => s.id)).size === collector.spins.length" },
      { check_code: "collector.spins.every(s => Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)" },
    ],
    setupBlob: "auto30-round-count At least 30 round-end spins captured autoplay panel 30 rounds",
  });
  expect(result).toBe(30);
});
