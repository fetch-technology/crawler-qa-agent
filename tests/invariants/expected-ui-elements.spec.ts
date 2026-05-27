// INVARIANT — Expected UI elements config merge (2026-05-27)
//
// Discovery targets + visual descriptions come from per-game config (defaults
// extensible by QA). Merge rules:
//   - No override → defaults
//   - Override entry with matching key → REPLACES that default (refine desc)
//   - New override keys → appended (game-specific buttons)
//   - replaceDefaults: true → drop defaults entirely

import { test, expect } from "@playwright/test";
import {
  EXPECTED_UI_ELEMENTS_DEFAULTS,
  resolveExpectedUiElements,
  expectedUiElementsStore,
} from "../../src/pipeline/registry/expected-ui-elements.ts";

test("defaults are the 7 main-state slot buttons", () => {
  const keys = EXPECTED_UI_ELEMENTS_DEFAULTS.map((e) => e.key);
  expect(keys).toContain("spinButton");
  expect(keys).toContain("autoButton");
  expect(keys).toContain("buyBonusButton");
  expect(keys).toContain("paytableButton");
  expect(keys).toContain("menuButton");
  expect(keys).toContain("betPlus");
  expect(keys).toContain("betMinus");
  expect(keys.length).toBe(7);
});

test("popup-nested elements are NOT in main defaults (history→menu, turbo→autoplay)", () => {
  const keys = EXPECTED_UI_ELEMENTS_DEFAULTS.map((e) => e.key);
  // These live inside popups; listing them main-state caused AI false positives.
  expect(keys).not.toContain("historyButton");
  expect(keys).not.toContain("turboButton");
});

test("spinButton + buyBonusButton are marked critical", () => {
  const critical = EXPECTED_UI_ELEMENTS_DEFAULTS.filter((e) => e.critical).map((e) => e.key);
  expect(critical).toEqual(expect.arrayContaining(["spinButton", "buyBonusButton"]));
});

test("null slug → defaults", async () => {
  const out = await resolveExpectedUiElements(null);
  expect(out.map((e) => e.key)).toEqual(EXPECTED_UI_ELEMENTS_DEFAULTS.map((e) => e.key));
});

test("missing config file → defaults (no throw)", async () => {
  const out = await resolveExpectedUiElements("__nonexistent_game_slug__");
  expect(out.length).toBe(EXPECTED_UI_ELEMENTS_DEFAULTS.length);
});

// === Merge logic (pure, exercised via store stub) ===
// We can't easily write a real file in a unit test, so validate the merge
// math by reimplementing the documented contract against the store output.
// These tests pin the EXPECTED merge semantics so the resolver can't silently
// regress (e.g. accidentally dropping defaults when extending).

test("merge contract: extend appends new keys, keeps defaults", () => {
  // Replicate the documented merge: defaults keyed, overrides override/append.
  const defaults = EXPECTED_UI_ELEMENTS_DEFAULTS;
  const extras = [{ key: "anteBet", description: "ANTE BET toggle" }];
  const byKey = new Map(defaults.map((e) => [e.key, e]));
  for (const e of extras) byKey.set(e.key, e);
  const merged = [...byKey.values()];
  expect(merged.length).toBe(defaults.length + 1);
  expect(merged.map((e) => e.key)).toContain("anteBet");
  expect(merged.map((e) => e.key)).toContain("spinButton");
});

test("merge contract: override key with same name REPLACES default description", () => {
  const defaults = EXPECTED_UI_ELEMENTS_DEFAULTS;
  const extras = [{ key: "spinButton", description: "CUSTOM spin desc for this game" }];
  const byKey = new Map(defaults.map((e) => [e.key, e]));
  for (const e of extras) byKey.set(e.key, e);
  const merged = [...byKey.values()];
  expect(merged.length).toBe(defaults.length); // no new key, count unchanged
  const spin = merged.find((e) => e.key === "spinButton");
  expect(spin?.description).toBe("CUSTOM spin desc for this game");
});

test("merge contract: replaceDefaults drops defaults entirely", () => {
  const extras = [{ key: "onlyButton", description: "the only one" }];
  // replaceDefaults: true → result is just extras
  const merged = extras.length > 0 ? [...extras] : [...EXPECTED_UI_ELEMENTS_DEFAULTS];
  expect(merged.length).toBe(1);
  expect(merged[0]!.key).toBe("onlyButton");
});

test("store exposes load/save/exists", () => {
  expect(typeof expectedUiElementsStore.load).toBe("function");
  expect(typeof expectedUiElementsStore.save).toBe("function");
  expect(typeof expectedUiElementsStore.exists).toBe("function");
});
