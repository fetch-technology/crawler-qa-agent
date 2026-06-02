// Pure tests for aliasElementsForNewTrigger — verifies that when a popup
// state is reached via a second trigger (e.g. both betPlus and betMinus open
// the same bet-selector popup in PP slots), the popup's elements get
// aliased under the new trigger's namespace so the registry tree shows
// betMinus__bet-0.20 etc., not just betPlus__bet-0.20.

import { test, expect } from "@playwright/test";
import { aliasElementsForNewTrigger } from "../../src/pipeline/step2-detect-ui/graph-explorer.ts";
import type { UiElement } from "../../src/pipeline/registry/types.ts";

function el(x: number, y: number): UiElement {
  return {
    x, y,
    strategy: "ai_vision",
    confidence: 0.9,
    detectedAt: "2026-06-01T00:00:00Z",
  };
}

test("aliases all `betPlus__*` children under `betMinus__*`", () => {
  const elements = new Map<string, UiElement>();
  elements.set("betPlus__bet-0.20", el(100, 200));
  elements.set("betPlus__bet-0.40", el(150, 200));
  elements.set("betPlus__bet-0.50", el(200, 200));
  elements.set("betPlus__closeButton", el(900, 50));

  const added = aliasElementsForNewTrigger(elements, "betMinus");

  expect(added).toBe(4);
  expect(elements.has("betMinus__bet-0.20")).toBe(true);
  expect(elements.has("betMinus__bet-0.40")).toBe(true);
  expect(elements.has("betMinus__bet-0.50")).toBe(true);
  expect(elements.has("betMinus__closeButton")).toBe(true);
  // Original entries preserved
  expect(elements.has("betPlus__bet-0.20")).toBe(true);
});

test("preserves coord values in aliased copies", () => {
  const elements = new Map<string, UiElement>();
  elements.set("betPlus__bet-5.00", el(500, 300));
  aliasElementsForNewTrigger(elements, "betMinus");
  const aliased = elements.get("betMinus__bet-5.00");
  expect(aliased?.x).toBe(500);
  expect(aliased?.y).toBe(300);
});

test("aliasing creates INDEPENDENT copies — mutating alias doesn't change original", () => {
  const elements = new Map<string, UiElement>();
  elements.set("betPlus__bet-5.00", el(500, 300));
  aliasElementsForNewTrigger(elements, "betMinus");
  const alias = elements.get("betMinus__bet-5.00")!;
  alias.x = 999;
  expect(elements.get("betPlus__bet-5.00")?.x).toBe(500);
});

test("skips top-level keys (no `__` separator)", () => {
  // Top-level keys are main canonical elements, not namespaced under any
  // popup trigger — they shouldn't be aliased.
  const elements = new Map<string, UiElement>();
  elements.set("spinButton", el(990, 650));
  elements.set("betPlus__bet-1.00", el(100, 200));

  const added = aliasElementsForNewTrigger(elements, "betMinus");

  expect(added).toBe(1);
  expect(elements.has("betMinus")).toBe(false); // no top-level alias
  expect(elements.has("betMinus__bet-1.00")).toBe(true);
});

test("skips existing alias keys (idempotent)", () => {
  const elements = new Map<string, UiElement>();
  elements.set("betPlus__bet-0.20", el(100, 200));
  elements.set("betMinus__bet-0.20", el(110, 200)); // already aliased

  const added = aliasElementsForNewTrigger(elements, "betMinus");

  expect(added).toBe(0);
  // Existing alias coord PRESERVED — not overwritten
  expect(elements.get("betMinus__bet-0.20")?.x).toBe(110);
});

test("multi-level namespaces: strips one prefix layer only", () => {
  // "autoButton__lossLimit__keypad" → alias under "soundToggle" becomes
  // "soundToggle__lossLimit__keypad" (only top-level prefix replaced).
  const elements = new Map<string, UiElement>();
  elements.set("autoButton__lossLimit__keypad", el(400, 500));
  aliasElementsForNewTrigger(elements, "soundToggle");
  expect(elements.has("soundToggle__lossLimit__keypad")).toBe(true);
});

test("empty map → returns 0, no mutation", () => {
  const elements = new Map<string, UiElement>();
  expect(aliasElementsForNewTrigger(elements, "betMinus")).toBe(0);
  expect(elements.size).toBe(0);
});

test("empty trigger name → returns 0 (defensive guard)", () => {
  const elements = new Map<string, UiElement>();
  elements.set("betPlus__bet-1.00", el(100, 200));
  expect(aliasElementsForNewTrigger(elements, "")).toBe(0);
  // Original entry preserved
  expect(elements.has("betPlus__bet-1.00")).toBe(true);
  expect(elements.size).toBe(1);
});

test("REGRESSION 2026-06-01: vswaysmahwin2 bet popup — 17 levels alias from betPlus to betMinus", () => {
  // Reproduce the observed log: bet_multiplier_popup has 17 elements under
  // betPlus__bet-* after explorer's first AI call from betPlus. When
  // betMinus subsequently matches the same state, all 17 should be
  // aliased.
  const elements = new Map<string, UiElement>();
  const levels = ["0.20", "0.40", "0.50", "0.70", "0.90", "2.00", "3.00", "5.00", "7.00",
                  "9.00", "10.00", "30.00", "50.00", "70.00", "80.00", "100.00"];
  for (const lvl of levels) {
    elements.set(`betPlus__bet-${lvl}`, el(Math.random() * 1000, 500));
  }
  elements.set("betPlus__closeButton", el(900, 100));

  const added = aliasElementsForNewTrigger(elements, "betMinus");

  expect(added).toBe(17); // 16 levels + 1 closeButton
  for (const lvl of levels) {
    expect(elements.has(`betMinus__bet-${lvl}`)).toBe(true);
  }
  expect(elements.has("betMinus__closeButton")).toBe(true);
});
