// INVARIANT — Per-category assertion templates (Phase 11.3)
//
// Templates are STATIC text fed into the EXPAND prompt. Tests pin the shape
// so accidental edits don't strip required categories or break the rendered
// markdown block format the AI expects.

import { test, expect } from "@playwright/test";
import {
  ASSERTION_TEMPLATES_BY_CATEGORY,
  renderTemplatesForCategory,
  buildTemplateBlockForPlan,
} from "../../src/ai/assertion-templates.ts";

test("templates exist for all critical categories", () => {
  const required = [
    "base_game",
    "bet_variation",
    "bet_boundary",
    "autoplay",
    "buy_feature",
    "free_spins",
    "ui_consistency",
    "performance",
  ];
  for (const cat of required) {
    expect(ASSERTION_TEMPLATES_BY_CATEGORY[cat], `missing templates for ${cat}`).toBeDefined();
    expect(ASSERTION_TEMPLATES_BY_CATEGORY[cat].length).toBeGreaterThanOrEqual(1);
  }
  // Multi-aspect categories should have ≥3 templates so AI sees variety
  for (const cat of ["bet_boundary", "autoplay", "ui_consistency"]) {
    expect(ASSERTION_TEMPLATES_BY_CATEGORY[cat].length).toBeGreaterThanOrEqual(3);
  }
});

test("each template has id, description, check_code", () => {
  for (const [cat, list] of Object.entries(ASSERTION_TEMPLATES_BY_CATEGORY)) {
    for (const t of list) {
      expect(t.id, `${cat}: missing id`).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(t.description, `${cat}/${t.id}: empty description`).toBeTruthy();
      expect(t.check_code, `${cat}/${t.id}: empty check_code`).toBeTruthy();
      // check_code must not contain semicolons (statements). Closure-IIFE OK.
      const stripped = t.check_code.replace(/`[^`]*`/g, ""); // strip backtick strings
      // Allow semicolons ONLY inside (() => { ... })() closures
      if (stripped.includes(";") && !/\(\(\)\s*=>\s*\{/.test(t.check_code)) {
        throw new Error(`${cat}/${t.id} has bare semicolon: ${t.check_code}`);
      }
    }
  }
});

test("multi-aspect coverage: bet_boundary templates reference 3+ distinct sources", () => {
  const list = ASSERTION_TEMPLATES_BY_CATEGORY.bet_boundary;
  const code = list.map((t) => t.check_code).join("\n");
  // Should reference: spin (server), screen (UI), warnings (engine state)
  expect(code).toMatch(/\bspin\b/);
  expect(code).toMatch(/\bscreen\b/);
  expect(code).toMatch(/\bwarnings\b/);
});

test("autoplay templates reference warnings about debounced/dropped clicks", () => {
  const list = ASSERTION_TEMPLATES_BY_CATEGORY.autoplay;
  const code = list.map((t) => t.check_code).join("\n");
  expect(code).toMatch(/debounced|debounce|popup may have blocked|no spin.*response/i);
});

test("renderTemplatesForCategory: returns markdown block for known category", () => {
  const rendered = renderTemplatesForCategory("bet_boundary");
  expect(rendered).toContain('category="bet_boundary"');
  expect(rendered).toContain("check_code");
  expect(rendered.length).toBeGreaterThan(200);
});

test("renderTemplatesForCategory: unknown category returns empty string", () => {
  expect(renderTemplatesForCategory("does_not_exist_xyz")).toBe("");
});

test("buildTemplateBlockForPlan: dedups categories", () => {
  const block = buildTemplateBlockForPlan(["base_game", "base_game", "autoplay", "base_game"]);
  const baseGameCount = (block.match(/category="base_game"/g) || []).length;
  expect(baseGameCount).toBe(1);
  expect(block).toContain('category="autoplay"');
});

test("buildTemplateBlockForPlan: empty plan → empty string", () => {
  expect(buildTemplateBlockForPlan([])).toBe("");
});

test("buildTemplateBlockForPlan: header included when any templates render", () => {
  const block = buildTemplateBlockForPlan(["bet_boundary"]);
  expect(block).toContain("PER-CATEGORY ASSERTION TEMPLATES");
});

// REGRESSION (2026-06-12) — freeSpinsRemaining direction is PROVIDER-SPECIFIC:
// PP counts UP (spin index in chain), others count DOWN. The old template
// asserted "decreases monotonically" → false-FAILed every PP FS chain
// (observed: clean 1→10 progression marked FAIL). The template must accept
// EITHER consistent direction and reject only erratic counters.
test("fs-counter-monotonic template is direction-agnostic", () => {
  const tpl = ASSERTION_TEMPLATES_BY_CATEGORY.free_spins.find((t) => t.id === "free-spins-counter-monotonic")!;
  expect(tpl).toBeTruthy();
  const run = (values: number[]): boolean => {
    const collector = { spins: values.map((n) => ({ isFreeSpin: true, freeSpinsRemaining: n })) };
    // eslint-disable-next-line no-new-func
    return new Function("collector", `return (${tpl.check_code});`)(collector) as boolean;
  };
  expect(run([2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(true); // PP up-count (the false-FAIL case)
  expect(run([10, 9, 8, 7, 6, 5])).toBe(true);          // classic down-count
  expect(run([3, 7, 2])).toBe(false);                   // erratic → real failure
  expect(run([5])).toBe(true);                          // single frame vacuous
});
