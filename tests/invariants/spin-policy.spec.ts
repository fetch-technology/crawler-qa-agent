// INVARIANT — translator SPIN POLICY resolution
//
// Pinned to prevent regression of the no-spin contamination bug seen on
// options-ambient-music-toggle case (translator emitted a final spin
// despite spin_count=0 + assertion `collector.spins.length === 0`).

import { test, expect } from "@playwright/test";
import { resolveSpinPolicy } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";

test("FORBIDDEN when assertion checks collector.spins.length === 0", () => {
  const r = resolveSpinPolicy({
    spinCount: 1, // even with spin_count > 0, negative-spin assertion wins
    customAssertions: [
      { check_code: "Array.isArray(collector.spins) && collector.spins.length === 0" },
    ],
  });
  expect(r.policy).toBe("FORBIDDEN");
  expect(r.reason).toMatch(/spins\.length === 0/);
});

test("FORBIDDEN when spin_count === 0", () => {
  const r = resolveSpinPolicy({ spinCount: 0 });
  expect(r.policy).toBe("FORBIDDEN");
  expect(r.reason).toMatch(/spin_count = 0/);
});

test("REQUIRED when spin_count > 0", () => {
  const r = resolveSpinPolicy({ spinCount: 5 });
  expect(r.policy).toBe("REQUIRED");
  expect(r.reason).toMatch(/spin_count = 5/);
});

test("REQUIRED when spin_count = 1 (single-spin case)", () => {
  const r = resolveSpinPolicy({ spinCount: 1 });
  expect(r.policy).toBe("REQUIRED");
});

test("OPTIONAL for pure-UI categories with no spin_count signal", () => {
  for (const category of ["options", "ui_consistency", "history", "paytable", "rules_consistency", "meta", "settings"]) {
    const r = resolveSpinPolicy({ category });
    expect(r.policy, `${category} should be OPTIONAL`).toBe("OPTIONAL");
  }
});

test("OPTIONAL default when no signals", () => {
  const r = resolveSpinPolicy({});
  expect(r.policy).toBe("OPTIONAL");
});

test("REQUIRED overrides UI category when spin_count > 0", () => {
  // ui_consistency case with spin_count=2 still needs spins to verify
  const r = resolveSpinPolicy({ category: "ui_consistency", spinCount: 2 });
  expect(r.policy).toBe("REQUIRED");
});

test("FORBIDDEN overrides UI category when assertion says no-spin", () => {
  const r = resolveSpinPolicy({
    category: "options",
    customAssertions: [{ check_code: "collector.spins.length === 0" }],
  });
  expect(r.policy).toBe("FORBIDDEN");
});

test("negative-spin pattern: tolerates whitespace variants", () => {
  for (const code of [
    "collector.spins.length===0",
    "collector.spins.length === 0",
    "collector.spins.length == 0",
    "Array.isArray(collector.spins) && collector.spins.length === 0",
  ]) {
    const r = resolveSpinPolicy({ customAssertions: [{ check_code: code }] });
    expect(r.policy, `should detect FORBIDDEN for: ${code}`).toBe("FORBIDDEN");
  }
});

test("negative-spin pattern: does NOT trigger for length > 0 or >= N", () => {
  for (const code of [
    "collector.spins.length > 0",
    "collector.spins.length >= 5",
    "collector.spins.length === 5",
  ]) {
    const r = resolveSpinPolicy({ customAssertions: [{ check_code: code }] });
    expect(r.policy, `should NOT be FORBIDDEN for: ${code}`).not.toBe("FORBIDDEN");
  }
});
