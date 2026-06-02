// Pure tests for inferProbeKind — verifies that every canonical key gets its
// dedicated probe kind AND that generic `*_toggle` keys (auto-added top-level
// extras like sound_toggle, special_bets_toggle, ambient_toggle) are now
// routed to "genericToggle" instead of being skipped entirely.

import { test, expect } from "@playwright/test";
import { inferProbeKind } from "../../src/pipeline/step2-detect-ui/element-probe.ts";

// Canonical kinds (verbatim match)
test.describe("canonical probe kinds", () => {
  test("spinButton", () => expect(inferProbeKind("spinButton")).toBe("spinButton"));
  test("betPlus", () => expect(inferProbeKind("betPlus")).toBe("betPlus"));
  test("betMinus", () => expect(inferProbeKind("betMinus")).toBe("betMinus"));
  test("menuButton", () => expect(inferProbeKind("menuButton")).toBe("menuButton"));
  test("paytableButton", () => expect(inferProbeKind("paytableButton")).toBe("paytableButton"));
  test("historyButton", () => expect(inferProbeKind("historyButton")).toBe("historyButton"));
  test("buyBonusButton", () => expect(inferProbeKind("buyBonusButton")).toBe("buyBonusButton"));
  test("autoButton", () => expect(inferProbeKind("autoButton")).toBe("autoButton"));
});

// Generic toggles (auto-added top-level extras)
test.describe("generic toggle inference", () => {
  test("sound_toggle (snake_case)", () => expect(inferProbeKind("sound_toggle")).toBe("genericToggle"));
  test("music_toggle", () => expect(inferProbeKind("music_toggle")).toBe("genericToggle"));
  test("ambient_toggle", () => expect(inferProbeKind("ambient_toggle")).toBe("genericToggle"));
  test("special_bets_toggle", () => expect(inferProbeKind("special_bets_toggle")).toBe("genericToggle"));
  test("soundToggle (camelCase)", () => expect(inferProbeKind("soundToggle")).toBe("genericToggle"));
  test("musicToggle", () => expect(inferProbeKind("musicToggle")).toBe("genericToggle"));
  test("dash-separated: sound-toggle", () => expect(inferProbeKind("sound-toggle")).toBe("genericToggle"));
});

// Reject patterns
test.describe("toggle rejection cases", () => {
  test("namespaced toggles get NULL (sub-state probe handles them, not canonical kind)", () => {
    // settingsPopup__musicToggle lives inside a popup — sub-state probe
    // walks the trigger chain and does its own pixel-diff. inferProbeKind
    // is canonical-only.
    expect(inferProbeKind("settingsPopup__musicToggle")).toBeNull();
    expect(inferProbeKind("autoButton__soundToggle")).toBeNull();
  });

  test("key containing 'toggle' mid-word doesn't match", () => {
    // Strict suffix only — avoid catching keys like "toggleButtonGuard"
    expect(inferProbeKind("togglePanel")).toBeNull();
  });

  test("unrelated keys return null", () => {
    expect(inferProbeKind("foo")).toBeNull();
    expect(inferProbeKind("randomButton")).toBeNull();
    expect(inferProbeKind("special_bets")).toBeNull(); // sibling of special_bets_toggle, NOT a toggle
  });
});
