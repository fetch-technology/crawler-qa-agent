// INVARIANT — Catalog assertion status/state literal validation
//
// The engine only ever emits `status === "RESOLVED"` and `state` ∈ the
// SpinState union (NORMAL / FREE_SPIN / BONUS / GAMBLE / RETRIGGER /
// END_BONUS). AI-authored assertions frequently invent terminal words like
// 'completed' / 'success' / 'finished' — e.g.
//   collector.spins.every(s => s.status === 'completed' || s.state === 'finished')
// which can NEVER be true → a guaranteed false-FAIL on every run, on every
// game. The validator MUST reject these at authoring time so they get
// regenerated against the real vocabulary, and MUST NOT flag real values.

import { test, expect } from "@playwright/test";
import { validateStatusStateLiterals } from "../../src/ai/catalog-validator.ts";

test("REGRESSION (swordofares all-spins-completed): hallucinated status/state literals are flagged", () => {
  const code =
    "collector.spins.every(s => s.status === 'completed' || s.status === 'success' || s.state === 'completed' || s.state === 'finished')";
  const msgs = validateStatusStateLiterals(code);
  // 4 bad literals → 4 messages.
  expect(msgs.length).toBe(4);
  expect(msgs.join(" ")).toContain("never emits");
});

test("real values are NOT flagged", () => {
  expect(validateStatusStateLiterals("collector.spins.every(s => s.status === 'RESOLVED')")).toEqual([]);
  expect(validateStatusStateLiterals("collector.spins.every(s => s.state === 'NORMAL' || s.state === 'FREE_SPIN')")).toEqual([]);
  expect(validateStatusStateLiterals("spin.state === 'BONUS'")).toEqual([]);
});

test("reverse ordering ('literal' === s.status) is also flagged", () => {
  expect(validateStatusStateLiterals("'completed' === s.status").length).toBe(1);
  expect(validateStatusStateLiterals("'RESOLVED' === s.status")).toEqual([]);
});

test("non-status/state literals are ignored (no false positives)", () => {
  // betAmount / category / arbitrary strings must not be touched.
  expect(validateStatusStateLiterals("collector.spins.every(s => s.betAmount === 40)")).toEqual([]);
  expect(validateStatusStateLiterals("s.roundId === 'req-1-1'")).toEqual([]);
  expect(validateStatusStateLiterals("warnings.every(w => w.kind === 'completed')")).toEqual([]);
});

test("mixed real + bad → only the bad literal is flagged", () => {
  const code = "collector.spins.every(s => s.state === 'FREE_SPIN' || s.state === 'finished')";
  const msgs = validateStatusStateLiterals(code);
  expect(msgs.length).toBe(1);
  expect(msgs[0]).toContain('"finished"');
});

// Phase fix #2 — typeof type-checks vs value compares.
test("typeof state === 'string' is a VALID type check (not flagged)", () => {
  expect(validateStatusStateLiterals('typeof spin.state === "string"')).toEqual([]);
  expect(validateStatusStateLiterals('typeof spin.status === "string"')).toEqual([]);
});

test("typeof state === 'object' is flagged (string-enum can never be object → always false)", () => {
  const msgs = validateStatusStateLiterals('typeof spin.state === "object"');
  expect(msgs.length).toBe(1);
  expect(msgs[0]).toContain("always false");
});

test("typeof state === 'number' is flagged too", () => {
  expect(validateStatusStateLiterals('typeof spin.status === "number"').length).toBe(1);
});
