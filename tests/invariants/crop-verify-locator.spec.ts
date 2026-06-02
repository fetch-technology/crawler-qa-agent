// INVARIANT — pure helpers of the crop-verify locator.
//
// `applyAdjustment` translates an AI verdict into a new bbox; `clampBbox`
// keeps the result inside the viewport with a sane min size so
// `page.screenshot({clip})` can't throw. A bug here = the loop drifts off
// the viewport (silent dead-end) or shrinks to a 0-area crop (always fails
// AI verify). Lock the math.

import { test, expect } from "@playwright/test";
import { applyAdjustment, clampBbox } from "../../src/ai/crop-verify-locator.js";

const VP = { width: 1280, height: 720 };

test("applyAdjustment: dx/dy shift the crop, w/h unchanged", () => {
  const out = applyAdjustment({ x: 100, y: 100, w: 50, h: 50 }, { dx: 30, dy: -20 });
  expect(out).toEqual({ x: 130, y: 80, w: 50, h: 50 });
});

test("applyAdjustment: expand grows outward — opposite edge stays put", () => {
  // expandLeft = 25 means "extend the LEFT edge 25px to the left" — x decreases by 25, w grows by 25.
  const out = applyAdjustment({ x: 100, y: 100, w: 50, h: 50 }, { expandLeft: 25 });
  expect(out).toEqual({ x: 75, y: 100, w: 75, h: 50 });
});

test("applyAdjustment: expandRight grows right edge only", () => {
  const out = applyAdjustment({ x: 100, y: 100, w: 50, h: 50 }, { expandRight: 40 });
  expect(out).toEqual({ x: 100, y: 100, w: 90, h: 50 });
});

test("applyAdjustment: negative expand SHRINKS that edge", () => {
  const out = applyAdjustment({ x: 100, y: 100, w: 50, h: 50 }, { expandBottom: -30 });
  expect(out).toEqual({ x: 100, y: 100, w: 50, h: 20 });
});

test("applyAdjustment: mixed dx + expand combine", () => {
  const out = applyAdjustment(
    { x: 100, y: 100, w: 50, h: 50 },
    { dx: 10, dy: -5, expandLeft: 5, expandRight: 5, expandTop: 5, expandBottom: 5 },
  );
  // dx=10 → x +=10. expandLeft=5 → x -=5 + w +=5. Net x = 100+10-5=105, w = 50+5+5=60.
  // dy=-5 → y -=5. expandTop=5 → y -=5 + h +=5. Net y = 100-5-5=90, h = 50+5+5=60.
  expect(out).toEqual({ x: 105, y: 90, w: 60, h: 60 });
});

test("applyAdjustment: empty adjustment is a no-op", () => {
  const bbox = { x: 200, y: 300, w: 80, h: 40 };
  expect(applyAdjustment(bbox, {})).toEqual(bbox);
  expect(applyAdjustment(bbox, undefined)).toEqual(bbox);
});

test("clampBbox: in-viewport bbox is unchanged", () => {
  expect(clampBbox({ x: 100, y: 100, w: 200, h: 100 }, VP))
    .toEqual({ x: 100, y: 100, w: 200, h: 100 });
});

test("clampBbox: negative x/y clamped to 0", () => {
  const out = clampBbox({ x: -50, y: -10, w: 200, h: 100 }, VP);
  expect(out.x).toBe(0);
  expect(out.y).toBe(0);
});

test("clampBbox: width overflowing right edge is shrunk to fit", () => {
  const out = clampBbox({ x: 1200, y: 100, w: 200, h: 100 }, VP);
  expect(out.x + out.w).toBeLessThanOrEqual(VP.width);
});

test("clampBbox: height overflowing bottom edge is shrunk to fit", () => {
  const out = clampBbox({ x: 100, y: 700, w: 50, h: 200 }, VP);
  expect(out.y + out.h).toBeLessThanOrEqual(VP.height);
});

test("clampBbox: zero/negative dimensions bumped to MIN_DIM (20)", () => {
  const zero = clampBbox({ x: 100, y: 100, w: 0, h: 0 }, VP);
  expect(zero.w).toBeGreaterThanOrEqual(20);
  expect(zero.h).toBeGreaterThanOrEqual(20);
  const negative = clampBbox({ x: 100, y: 100, w: -50, h: -50 }, VP);
  expect(negative.w).toBeGreaterThanOrEqual(20);
  expect(negative.h).toBeGreaterThanOrEqual(20);
});

test("clampBbox: fractional coords floored to ints", () => {
  const out = clampBbox({ x: 100.7, y: 50.3, w: 80.5, h: 40.9 }, VP);
  expect(Number.isInteger(out.x) && Number.isInteger(out.y) && Number.isInteger(out.w) && Number.isInteger(out.h)).toBe(true);
});

test("applyAdjustment + clampBbox compose deterministically", () => {
  // Realistic flow: bbox shifts left 30, expands right by 20, then clamped.
  let bbox = { x: 100, y: 100, w: 60, h: 60 };
  bbox = applyAdjustment(bbox, { dx: -30, expandRight: 20 });
  expect(bbox).toEqual({ x: 70, y: 100, w: 80, h: 60 });
  bbox = clampBbox(bbox, VP);
  expect(bbox).toEqual({ x: 70, y: 100, w: 80, h: 60 });
});
