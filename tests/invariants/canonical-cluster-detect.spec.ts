// Cluster detection + spin-anchor description enrichment. Pure logic — no
// browser, no AI. Verifies that batch AI-vision failure modes (e.g. all
// canonical main elements returning coords within 50px of each other) are
// recognized so the per-element fallback fires, and that spin-anchor strings
// only appear when spinButton has finite coords.

import { test, expect } from "@playwright/test";
import { detectCanonicalCluster } from "../../src/pipeline/step2-detect-ui/discover-canonical-per-element.ts";
import { enrichDescriptionWithSpinAnchor } from "../../src/pipeline/registry/canonical-element-hints.ts";
import type { UiElement, UiRegistry } from "../../src/pipeline/registry/types.ts";

const CANONICAL = ["spinButton", "betPlus", "betMinus", "autoButton", "menuButton", "paytableButton", "buyBonusButton", "historyButton"];

function el(x: number, y: number, opts: Partial<UiElement> = {}): UiElement {
  return {
    x, y,
    strategy: "ai_vision",
    confidence: 0.7,
    status: "pending",
    detectedAt: "2026-05-31T00:00:00Z",
    ...opts,
  };
}

// --- detectCanonicalCluster ---

test("cluster detected when ≥3 canonical coords sit within 80px", () => {
  const reg: UiRegistry = {
    spinButton: el(1144, 661),
    betPlus: el(1160, 670),
    betMinus: el(1130, 655),
    autoButton: el(1170, 665),
  };
  const r = detectCanonicalCluster(reg, CANONICAL);
  expect(r.detected).toBe(true);
  expect(r.keys.length).toBeGreaterThanOrEqual(3);
  expect(r.centroid).not.toBeNull();
});

test("normal layout (spread across bottom row) NOT a cluster", () => {
  const reg: UiRegistry = {
    spinButton: el(640, 660),
    betPlus: el(740, 660),
    betMinus: el(540, 660),
    autoButton: el(820, 660),
    menuButton: el(60, 660),
    paytableButton: el(60, 60),
  };
  const r = detectCanonicalCluster(reg, CANONICAL);
  expect(r.detected).toBe(false);
});

test("two elements close + others spread → NOT a cluster (min=3 default)", () => {
  const reg: UiRegistry = {
    spinButton: el(640, 660),
    betPlus: el(660, 670), // close to spin
    betMinus: el(60, 660),
    autoButton: el(820, 660),
  };
  const r = detectCanonicalCluster(reg, CANONICAL);
  expect(r.detected).toBe(false);
});

test("QA-verified entries excluded from cluster detection", () => {
  // Even if 4 entries are tightly grouped, if 3 of them are verified, the
  // cluster shouldn't be flagged for re-discovery — those are known correct.
  const reg: UiRegistry = {
    spinButton: el(1144, 661, { verifiedBy: "QA", status: "verified" }),
    betPlus: el(1160, 670, { verifiedBy: "probe", status: "verified" }),
    betMinus: el(1130, 655, { verifiedBy: "QA", status: "verified" }),
    autoButton: el(1170, 665), // only 1 unverified
  };
  const r = detectCanonicalCluster(reg, CANONICAL);
  expect(r.detected).toBe(false);
});

test("non-finite coords skipped (NaN guard)", () => {
  const reg: UiRegistry = {
    spinButton: el(NaN, NaN),
    betPlus: el(1160, 670),
    betMinus: el(1130, 655),
    autoButton: el(1170, 665),
  };
  const r = detectCanonicalCluster(reg, CANONICAL);
  // 3 valid + 1 NaN → 3 form a cluster
  expect(r.detected).toBe(true);
  expect(r.keys).not.toContain("spinButton");
});

test("custom maxDistance/minCluster override defaults", () => {
  const reg: UiRegistry = {
    spinButton: el(100, 100),
    betPlus: el(150, 100), // 50px away
  };
  // Default min=3 → no cluster
  expect(detectCanonicalCluster(reg, CANONICAL).detected).toBe(false);
  // Custom min=2 + maxDist=60 → cluster
  const r = detectCanonicalCluster(reg, CANONICAL, { minCluster: 2, maxDistance: 60 });
  expect(r.detected).toBe(true);
});

test("empty registry → no cluster", () => {
  expect(detectCanonicalCluster({}, CANONICAL).detected).toBe(false);
});

// --- enrichDescriptionWithSpinAnchor ---

test("no spinCoord → base description returned unchanged", () => {
  const base = "the BET PLUS button";
  expect(enrichDescriptionWithSpinAnchor("betPlus", base, null)).toBe(base);
});

test("non-finite spinCoord → base description unchanged", () => {
  const base = "the BET PLUS button";
  expect(enrichDescriptionWithSpinAnchor("betPlus", base, { x: NaN, y: 100 })).toBe(base);
});

test("spinButton itself never gets a self-anchor", () => {
  const base = "the SPIN button";
  expect(enrichDescriptionWithSpinAnchor("spinButton", base, { x: 988, y: 640 })).toBe(base);
});

test("betPlus + spinCoord → anchor mentions spin coord + 'right of spinButton'", () => {
  const base = "the BET PLUS button";
  const out = enrichDescriptionWithSpinAnchor("betPlus", base, { x: 988, y: 640 });
  expect(out).toContain(base);
  expect(out).toContain("988");
  expect(out).toContain("640");
  expect(out.toLowerCase()).toContain("right of spinbutton");
});

test("betMinus → anchor says LEFT of spinButton", () => {
  const out = enrichDescriptionWithSpinAnchor("betMinus", "the BET MINUS button", { x: 988, y: 640 });
  expect(out.toLowerCase()).toContain("left of spinbutton");
});

test("autoButton → anchor says adjacent / right / below + warns about overlap", () => {
  const out = enrichDescriptionWithSpinAnchor("autoButton", "AUTOPLAY button", { x: 988, y: 640 });
  expect(out).toContain("988");
  expect(out.toLowerCase()).toContain("spinbutton");
  expect(out.toLowerCase()).toContain("never on top");
});

test("paytableButton has no useful spin anchor → base unchanged", () => {
  // Paytable is usually top-corner, far from spin; an "X px from spin"
  // anchor would mislead more than help.
  const base = "the paytable button";
  const out = enrichDescriptionWithSpinAnchor("paytableButton", base, { x: 988, y: 640 });
  expect(out).toBe(base);
});

test("menuButton same — no spin anchor", () => {
  const base = "the menu button";
  expect(enrichDescriptionWithSpinAnchor("menuButton", base, { x: 988, y: 640 })).toBe(base);
});

test("unknown key → base description unchanged", () => {
  const base = "some custom button";
  expect(enrichDescriptionWithSpinAnchor("unknownKey", base, { x: 988, y: 640 })).toBe(base);
});
