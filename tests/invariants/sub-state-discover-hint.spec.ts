// INVARIANT — Sub-state discover hints (2026-05-27)
//
// When QA clicks [Discover] on a trigger (e.g. autoButton), the discover flow
// uses the TRIGGER KEY as the stateLabel/namespace ("autoButton"), NOT the
// hint.stateLabel ("autoplay_popup"). The discover-hint lookup MUST therefore
// key off the trigger key. Regression guard: a stateLabel-only match silently
// dropped the hint → autoplay presets weren't named autoCountSlide-N.

import { test, expect } from "@playwright/test";
import { SUB_STATE_HINTS_DEFAULTS, interpolateSliderStops } from "../../src/pipeline/registry/sub-state-hints.ts";

test("autoButton hint covers BOTH discrete chips and continuous slider", () => {
  const h = SUB_STATE_HINTS_DEFAULTS["autoButton"];
  expect(h).toBeDefined();
  expect(h!.discoverHint).toBeTruthy();
  // (a) discrete preset chips → autoCountSlide-<N>
  expect(h!.discoverHint).toContain("autoCountSlide-");
  // (b) continuous slider → track-end anchors (backend interpolates stops)
  expect(h!.discoverHint).toContain("autospinsSliderMin");
  expect(h!.discoverHint).toContain("autospinsSliderMax");
  // always-present controls
  expect(h!.discoverHint).toContain("startAutoplayButton");
  expect(h!.discoverHint).toContain("turboSpinToggle");
});

test("menuButton hint surfaces historyButton (history lives in menu)", () => {
  const h = SUB_STATE_HINTS_DEFAULTS["menuButton"];
  expect(h).toBeDefined();
  expect(h!.discoverHint).toContain("historyButton");
});

test("REGRESSION: hint lookup keys off TRIGGER KEY, not hint.stateLabel", () => {
  // The discover flow passes safeLabel = trigger key ("autoButton"). Replicate
  // the (fixed) lookup and assert it resolves; the old code matched
  // h.stateLabel === "autoButton" which is "autoplay_popup" → no match.
  const hints = SUB_STATE_HINTS_DEFAULTS;
  const safeLabel = "autoButton"; // what the dashboard actually sends

  const correctLookup = hints[safeLabel] ?? Object.values(hints).find((h) => h.stateLabel === safeLabel);
  expect(correctLookup?.discoverHint).toContain("autoCountSlide-");

  // The OLD (buggy) lookup matched only by stateLabel → would miss it.
  const buggyLookup = Object.values(hints).find((h) => h.stateLabel === safeLabel);
  expect(buggyLookup).toBeUndefined(); // proves why the bug occurred
});

test("hint stateLabel for autoButton is autoplay_popup (decoupled from trigger key)", () => {
  // Documents the mismatch that caused the bug: the hint's stateLabel differs
  // from the trigger key used as the actual namespace.
  expect(SUB_STATE_HINTS_DEFAULTS["autoButton"]!.stateLabel).toBe("autoplay_popup");
});

// === Continuous-slider stop synthesis ===

test("autoButton sliderMarks config: 8 stops with autoCountSlide prefix", () => {
  const sm = SUB_STATE_HINTS_DEFAULTS["autoButton"]!.sliderMarks;
  expect(sm).toBeDefined();
  expect(sm!.keyPrefix).toBe("autoCountSlide");
  expect(sm!.values).toEqual([10, 20, 30, 50, 70, 100, 500, 1000]);
  expect(sm!.minAnchor).toBe("autospinsSliderMin");
  expect(sm!.maxAnchor).toBe("autospinsSliderMax");
});

test("interpolateSliderStops: evenly spaces values between anchors", () => {
  // Horizontal track from x=100 to x=800, y constant 560.
  const stops = interpolateSliderStops({ x: 100, y: 560 }, { x: 800, y: 560 }, [10, 20, 30, 50, 70, 100, 500, 1000]);
  expect(stops).toHaveLength(8);
  // First stop at min end, last at max end.
  expect(stops[0]).toEqual({ value: 10, x: 100, y: 560 });
  expect(stops[7]).toEqual({ value: 1000, x: 800, y: 560 });
  // Evenly spaced: gap = 700/7 = 100px between consecutive stops.
  expect(stops[1]!.x).toBe(200);
  expect(stops[2]!.x).toBe(300);
  // Spacing is EVEN (by index), NOT proportional to the value jumps.
  const gaps = stops.slice(1).map((s, i) => s.x - stops[i]!.x);
  expect(new Set(gaps).size).toBe(1); // all gaps equal
});

test("interpolateSliderStops: handles diagonal track (y varies)", () => {
  const stops = interpolateSliderStops({ x: 100, y: 500 }, { x: 800, y: 600 }, [10, 50, 100]);
  expect(stops[0]).toEqual({ value: 10, x: 100, y: 500 });
  expect(stops[2]).toEqual({ value: 100, x: 800, y: 600 });
  expect(stops[1]).toEqual({ value: 50, x: 450, y: 550 }); // midpoint
});

test("interpolateSliderStops: single value sits at min anchor", () => {
  const stops = interpolateSliderStops({ x: 100, y: 560 }, { x: 800, y: 560 }, [100]);
  expect(stops).toEqual([{ value: 100, x: 100, y: 560 }]);
});
