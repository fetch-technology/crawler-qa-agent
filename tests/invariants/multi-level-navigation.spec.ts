// Pure tests for the BFS path-finder used by graph-explorer + probe to reach
// states at any depth. Replaces the previous "single inbound transition"
// scheme that couldn't navigate beyond level 1.

import { test, expect } from "@playwright/test";
import { findPathFromMain } from "../../src/pipeline/step2-detect-ui/graph-explorer.ts";

type Transition = { from: string; via: string; to: string };

test("main → main → empty path", () => {
  expect(findPathFromMain([], "main")).toEqual([]);
});

test("main → level1 (1 hop)", () => {
  const t: Transition[] = [{ from: "main", via: "paytableButton", to: "paytable_page1" }];
  const path = findPathFromMain(t, "paytable_page1");
  expect(path).toEqual([{ from: "main", via: "paytableButton", to: "paytable_page1" }]);
});

test("main → level2 (2 hops)", () => {
  const t: Transition[] = [
    { from: "main", via: "paytableButton", to: "paytable_page1" },
    { from: "paytable_page1", via: "paytableButton__nextPageButton", to: "paytable_page2" },
  ];
  const path = findPathFromMain(t, "paytable_page2");
  expect(path).toEqual([
    { from: "main", via: "paytableButton", to: "paytable_page1" },
    { from: "paytable_page1", via: "paytableButton__nextPageButton", to: "paytable_page2" },
  ]);
});

test("main → level3 (3 hops, via deepest popup)", () => {
  const t: Transition[] = [
    { from: "main", via: "autoButton", to: "autoplay_settings" },
    { from: "autoplay_settings", via: "autoButton__lossLimitButton", to: "loss_limit_input" },
    { from: "loss_limit_input", via: "autoButton__lossLimitButton__keypad", to: "keypad_popup" },
  ];
  const path = findPathFromMain(t, "keypad_popup");
  expect(path).toHaveLength(3);
  expect(path?.map((p) => p.to)).toEqual(["autoplay_settings", "loss_limit_input", "keypad_popup"]);
});

test("BFS picks SHORTER path when multiple exist", () => {
  // settings_popup reachable directly OR via paytable's settings link.
  const t: Transition[] = [
    { from: "main", via: "menuButton", to: "settings_popup" },
    { from: "main", via: "paytableButton", to: "paytable_page1" },
    { from: "paytable_page1", via: "paytableButton__settingsLink", to: "settings_popup" },
  ];
  const path = findPathFromMain(t, "settings_popup");
  expect(path).toHaveLength(1);
  expect(path?.[0]?.via).toBe("menuButton");
});

test("unreachable target → null", () => {
  const t: Transition[] = [{ from: "main", via: "menuButton", to: "settings_popup" }];
  expect(findPathFromMain(t, "nonexistent_state")).toBeNull();
});

test("isolated subgraph (no edge from main) → null", () => {
  // popup_a has children but main never reaches popup_a directly.
  const t: Transition[] = [
    { from: "popup_a", via: "popup_a__close", to: "popup_b" },
  ];
  expect(findPathFromMain(t, "popup_b")).toBeNull();
});

test("graph with cycles doesn't loop forever (visited set)", () => {
  const t: Transition[] = [
    { from: "main", via: "menuButton", to: "settings_popup" },
    { from: "settings_popup", via: "menuButton__back", to: "main" }, // back to main (cycle)
    { from: "settings_popup", via: "menuButton__history", to: "history_popup" },
  ];
  const path = findPathFromMain(t, "history_popup");
  expect(path).toEqual([
    { from: "main", via: "menuButton", to: "settings_popup" },
    { from: "settings_popup", via: "menuButton__history", to: "history_popup" },
  ]);
});

test("self-loops on main are ignored as path", () => {
  const t: Transition[] = [
    { from: "main", via: "soundToggle", to: "main" }, // self-loop
    { from: "main", via: "paytableButton", to: "paytable" },
  ];
  const path = findPathFromMain(t, "paytable");
  expect(path).toEqual([{ from: "main", via: "paytableButton", to: "paytable" }]);
});

test("empty transitions + non-main target → null", () => {
  expect(findPathFromMain([], "some_state")).toBeNull();
});

test("preserves transition order in path (clicks must replay in sequence)", () => {
  // Linear chain main → A → B → C → D
  const t: Transition[] = [
    { from: "main", via: "v0", to: "A" },
    { from: "A", via: "v1", to: "B" },
    { from: "B", via: "v2", to: "C" },
    { from: "C", via: "v3", to: "D" },
  ];
  const path = findPathFromMain(t, "D");
  expect(path?.map((p) => p.via)).toEqual(["v0", "v1", "v2", "v3"]);
});
