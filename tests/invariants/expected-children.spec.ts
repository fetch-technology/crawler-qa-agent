// Verifies the audit / mirror / prune helpers in expected-children.ts behave
// correctly across the 4 failure modes a fresh-discovered registry typically
// exhibits: missing required children, dynamic-prefix shortfall, mirror
// asymmetry, legacy-namespace dups. These tests guard the post-auto-onboard
// chain (manualSession.verifyRegistry → discoverVia → mirror → prune)
// against silent regressions when the rule set changes.

import { test, expect } from "@playwright/test";
import {
  auditRegistry,
  applyMirrorRules,
  pruneLegacyNamespaces,
  EXPECTED_CHILDREN,
} from "../../src/pipeline/registry/expected-children.ts";

const verifiedEl = (x: number, y: number) => ({
  x, y, status: "verified" as const, strategy: "ai_vision", confidence: 0.9,
});
const pendingEl = (x: number, y: number) => ({
  x, y, status: "pending" as const, strategy: "ai_vision", confidence: 0.5,
});

test("EXPECTED_CHILDREN has the universal PP slot parents", () => {
  expect(EXPECTED_CHILDREN).toHaveProperty("autoButton");
  expect(EXPECTED_CHILDREN).toHaveProperty("betPlus");
  expect(EXPECTED_CHILDREN).toHaveProperty("betMinus");
  expect(EXPECTED_CHILDREN).toHaveProperty("paytableButton");
  expect(EXPECTED_CHILDREN).toHaveProperty("menuButton");
  expect(EXPECTED_CHILDREN).toHaveProperty("buyBonusButton");
});

test("auditRegistry: detects missing required children", () => {
  const reg = {
    autoButton: verifiedEl(100, 100),
    autoButton__closeButton: verifiedEl(200, 100),
    // missing autoButton__startAutoplayButton (required)
  };
  const audit = auditRegistry(reg);
  const auto = audit.missingRequired.find((m) => m.trigger === "autoButton");
  expect(auto).toBeDefined();
  expect(auto?.missing).toContain("startAutoplayButton");
});

test("auditRegistry: skips parents that don't exist", () => {
  // No autoButton in registry → no missingRequired entry for it.
  const reg = { spinButton: verifiedEl(500, 500) };
  const audit = auditRegistry(reg);
  expect(audit.missingRequired.some((m) => m.trigger === "autoButton")).toBe(false);
});

test("auditRegistry: detects dynamic-prefix shortfall (bet popup with <5 entries)", () => {
  const reg = {
    betPlus: verifiedEl(100, 100),
    "betPlus__closeButton": verifiedEl(400, 100),
    "betPlus__bet-0.20": verifiedEl(200, 200),
    "betPlus__bet-0.40": verifiedEl(220, 200),
    // Only 2 bet-* entries, need 5.
  };
  const audit = auditRegistry(reg);
  const dyn = audit.missingDynamic.find((m) => m.trigger === "betPlus");
  expect(dyn?.got).toBe(2);
  expect(dyn?.need).toBe(5);
});

test("auditRegistry: detects mirror asymmetry between betPlus and betMinus", () => {
  const reg = {
    betPlus: verifiedEl(100, 100),
    betPlus__closeButton: verifiedEl(400, 100),
    betMinus: verifiedEl(80, 100),
    betMinus__closeButton: verifiedEl(400, 100),
    "betMinus__bet-0.20": verifiedEl(200, 200),
    "betMinus__bet-0.50": verifiedEl(220, 200),
  };
  const audit = auditRegistry(reg);
  const m = audit.mirrorCandidates.find(
    (c) => c.source === "betMinus" && c.target === "betPlus",
  );
  expect(m?.childrenToMirror).toContain("bet-0.20");
  expect(m?.childrenToMirror).toContain("bet-0.50");
});

test("auditRegistry: detects legacy-namespace duplicates", () => {
  const reg = {
    autoButton: verifiedEl(100, 100),
    autoButton__closeButton: verifiedEl(200, 100),
    autoplay_popup__closeButton: pendingEl(200, 100),
    autoplay_popup__startAutoplayButton: pendingEl(300, 300),
  };
  const audit = auditRegistry(reg);
  const dup = audit.duplicateNamespaces.find(
    (d) => d.legacy === "autoplay_popup" && d.canonical === "autoButton",
  );
  expect(dup).toBeDefined();
  expect(dup?.legacyKeys.length).toBe(2);
});

test("applyMirrorRules: copies verified betMinus children to betPlus and vice versa", () => {
  const reg: Record<string, any> = {
    betMinus: verifiedEl(80, 100),
    betPlus: verifiedEl(120, 100),
    "betMinus__bet-0.20": verifiedEl(200, 200),
    "betMinus__bet-0.40": verifiedEl(220, 200),
    "betMinus__closeButton": verifiedEl(400, 100),
    // Only betMinus side has verified bet entries; betPlus has nothing.
  };
  const mirrored = applyMirrorRules(reg, "2026-06-02T00:00:00.000Z");
  expect(mirrored.length).toBe(3); // 2 bet levels + closeButton
  expect(reg["betPlus__bet-0.20"]?.status).toBe("verified");
  expect(reg["betPlus__bet-0.20"]?.verifiedBy).toBe("alias-mirror");
  expect(reg["betPlus__bet-0.20"]?.x).toBe(200);
});

test("applyMirrorRules: does NOT overwrite an already-verified target", () => {
  const reg: Record<string, any> = {
    betMinus: verifiedEl(80, 100),
    betPlus: verifiedEl(120, 100),
    "betMinus__bet-0.20": { ...verifiedEl(200, 200), probeSignal: "from-minus" },
    "betPlus__bet-0.20": { ...verifiedEl(200, 200), probeSignal: "from-plus" },
  };
  applyMirrorRules(reg, "2026-06-02T00:00:00.000Z");
  // betPlus entry should NOT be overwritten
  expect(reg["betPlus__bet-0.20"]?.probeSignal).toBe("from-plus");
});

test("pruneLegacyNamespaces: removes legacy keys when canonical exists", () => {
  const reg: Record<string, any> = {
    autoButton: verifiedEl(100, 100),
    autoButton__closeButton: verifiedEl(200, 100),
    autoplay_popup__closeButton: pendingEl(200, 100),
    autoplay_popup__startAutoplayButton: pendingEl(300, 300),
  };
  const removed = pruneLegacyNamespaces(reg);
  expect(removed.length).toBe(2);
  expect(reg).not.toHaveProperty("autoplay_popup__closeButton");
  expect(reg).not.toHaveProperty("autoplay_popup__startAutoplayButton");
  expect(reg).toHaveProperty("autoButton__closeButton"); // canonical preserved
});

test("pruneLegacyNamespaces: KEEPS legacy keys when no canonical exists", () => {
  const reg: Record<string, any> = {
    // Only autoplay_popup__* present; no autoButton__*.
    autoplay_popup__closeButton: verifiedEl(200, 100),
  };
  const removed = pruneLegacyNamespaces(reg);
  expect(removed.length).toBe(0);
  expect(reg).toHaveProperty("autoplay_popup__closeButton");
});
