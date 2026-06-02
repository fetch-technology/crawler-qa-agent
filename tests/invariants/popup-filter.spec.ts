// INVARIANT — popup-discovery main-overlap filter
//
// When AI discovers sub-state elements, it must NOT register main-game controls
// visible behind a dimmed popup. The filter is the deterministic safety net on
// top of the prompt instruction. Critical rules:
//   1. Coord within tolerance of a CANONICAL main key (no `__`) → dropped.
//   2. Coord matching a sub-state key (has `__`) → KEPT (legit cross-popup
//      reuse: betMinus / betPlus both open the same bet selector).
//   3. Beyond tolerance → kept.
// A regression here = either popups get polluted with main buttons (false
// positives) or legitimate cross-popup elements get silently dropped.

import { test, expect } from "@playwright/test";
import { filterMainOverlap, POPUP_MAIN_OVERLAP_TOLERANCE_PX } from "../../src/pipeline/step2-detect-ui/popup-filter.js";

const REG = {
  // Canonical main keys
  spinButton: { x: 960, y: 600 },
  betPlus: { x: 1100, y: 600 },
  betMinus: { x: 900, y: 600 },
  menuButton: { x: 100, y: 100 },
  // Pre-existing sub-state keys (must NOT trigger filter)
  betMinus__betAmount_050: { x: 200, y: 300 },
  paytableButton__closeButton: { x: 1000, y: 50 },
};

test("drops popup element overlapping a canonical main key (within tolerance)", () => {
  // Same coord as spinButton (960,600) — clearly the spin button bleeding
  // through dimmed background.
  const r = filterMainOverlap([{ key: "soundToggle", x: 960, y: 600 }], REG);
  expect(r.kept).toHaveLength(0);
  expect(r.dropped).toHaveLength(1);
  expect(r.dropped[0]!.overlapsMainKey).toBe("spinButton");
});

test("drops at tolerance boundary; keeps just outside", () => {
  const tol = POPUP_MAIN_OVERLAP_TOLERANCE_PX;
  const within = filterMainOverlap(
    [{ key: "x1", x: 960 + (tol - 1), y: 600 }], REG,
  );
  expect(within.kept).toHaveLength(0);
  const outside = filterMainOverlap(
    [{ key: "x2", x: 960 + (tol + 1), y: 600 }], REG,
  );
  expect(outside.kept).toHaveLength(1);
  expect(outside.dropped).toHaveLength(0);
});

test("DOES NOT drop overlaps with sub-state keys (cross-popup reuse is legit)", () => {
  // Coord matches betMinus__betAmount_050 (200,300) — another popup discovering
  // the same physical chip. Must be kept under the new namespace.
  const r = filterMainOverlap([{ key: "amount_050", x: 200, y: 300 }], REG);
  expect(r.kept).toHaveLength(1);
  expect(r.dropped).toHaveLength(0);
});

test("keeps popup-internal elements (far from main controls)", () => {
  const r = filterMainOverlap(
    [
      { key: "closeButton", x: 1200, y: 100 },
      { key: "buyOption_25x", x: 700, y: 400 },
    ],
    REG,
  );
  expect(r.kept).toHaveLength(2);
  expect(r.dropped).toHaveLength(0);
});

test("empty input → empty output", () => {
  expect(filterMainOverlap([], REG)).toEqual({ kept: [], dropped: [] });
});

test("empty registry → everything kept (nothing to overlap)", () => {
  const r = filterMainOverlap([{ key: "x", x: 100, y: 100 }], {});
  expect(r.kept).toHaveLength(1);
  expect(r.dropped).toHaveLength(0);
});

test("undefined entries in registry are ignored (no false drop)", () => {
  const reg = { spinButton: undefined, betPlus: { x: 1100, y: 600 } };
  const r = filterMainOverlap([{ key: "x", x: 1100, y: 600 }], reg);
  expect(r.dropped[0]!.overlapsMainKey).toBe("betPlus");
});

test("non-finite coords on main entries are skipped (no NaN comparisons)", () => {
  const reg = { spinButton: { x: NaN, y: 600 }, menuButton: { x: 100, y: 100 } };
  const r = filterMainOverlap([{ key: "x", x: 100, y: 100 }], reg);
  expect(r.dropped[0]!.overlapsMainKey).toBe("menuButton");
});

test("REGRESSION: popup with 5 items, 2 are main false positives → only 3 kept", () => {
  // Realistic AI output for a buy-feature popup: 2 true popup buttons +
  // 3 main-control bleed-throughs.
  const aiReturned = [
    { key: "buy_25x", x: 700, y: 400 },         // popup-only ✓
    { key: "yesButton", x: 700, y: 500 },        // popup-only ✓
    { key: "spinButton_dup", x: 960, y: 605 },   // main bleed
    { key: "betPlus_dup", x: 1095, y: 600 },     // main bleed
    { key: "closeButton", x: 1200, y: 100 },     // popup-only ✓
  ];
  const r = filterMainOverlap(aiReturned, REG);
  expect(r.kept.map((c) => c.key).sort()).toEqual(["buy_25x", "closeButton", "yesButton"]);
  expect(r.dropped.map((d) => d.overlapsMainKey).sort()).toEqual(["betPlus", "spinButton"]);
});
