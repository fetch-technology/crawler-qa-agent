import { test, expect } from "@playwright/test";
import {
  STANDARD_CASE_TEMPLATES,
  instantiateTemplate,
  validateCaseTemplates,
} from "../../src/pipeline/step7-testcase-gen/case-templates.ts";

test("standard templates include QA-required slot coverage cases", () => {
  const ids = new Set(STANDARD_CASE_TEMPLATES.map((c) => c.id));
  const required = [
    "launch-mid-spin-disconnect-recovery",
    "bet-minimum-matches-rule",
    "bet-maximum-matches-rule",
    "bet-persists-after-spin",
    "bet-locked-mid-spin",
    "spin-blocked-if-bet-exceeds-balance",
    "base-balance-never-negative",
    "max-win-cap-enforced",
    "ante-toggle-changes-stake",
    "ante-off-restores-stake",
    "ante-on-buy-feature-disabled",
    "autoplay-50-min-bet",
    "autoplay-50-max-bet",
    "autoplay-turbo-50",
    "autoplay-quick-spin-50",
    "autoplay-manual-stop",
    "free-spins-no-bet-deducted",
    "buy-feature-trigger-spin-valid",
    "buy-feature-no-bet-deducted-during-feature",
    "buy-feature-cancel-vs-confirm",
    "buy-feature-blocked-insufficient-funds",
    "buy-feature-disabled-when-ante-on",
  ];
  for (const id of required) expect(ids.has(id), id).toBe(true);
});

test("template assertion code substitutes numeric bet tokens safely", () => {
  const tpl = STANDARD_CASE_TEMPLATES.find((c) => c.id === "bet-minimum-matches-rule");
  expect(tpl).toBeTruthy();
  const instantiated = instantiateTemplate(tpl!, { betMin: 0.4, betMax: 100, defaultBet: 1 });
  const code = instantiated.custom_assertions?.[0]?.check_code ?? "";
  expect(code).toContain("const expected = 0.4");
  expect(code).not.toContain("{{betMin}}");
});

test("template assertion code uses null for unresolved numeric tokens", () => {
  const tpl = STANDARD_CASE_TEMPLATES.find((c) => c.id === "bet-maximum-matches-rule");
  expect(tpl).toBeTruthy();
  const instantiated = instantiateTemplate(tpl!, {});
  const code = instantiated.custom_assertions?.[0]?.check_code ?? "";
  expect(code).toContain("const expected = null");
  expect(code).not.toContain("{{betMax}}");
});

test("editable template validator rejects empty or duplicate template sets", () => {
  expect(validateCaseTemplates([]).ok).toBe(false);
  const one = STANDARD_CASE_TEMPLATES[0]!;
  const dup = validateCaseTemplates([one, { ...one }]);
  expect(dup.ok).toBe(false);
  if (!dup.ok) expect(dup.reason).toContain("duplicate");
});

test("editable template validator accepts the built-in template set", () => {
  expect(validateCaseTemplates(STANDARD_CASE_TEMPLATES).ok).toBe(true);
});
