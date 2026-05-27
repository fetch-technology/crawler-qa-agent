// INVARIANT — OCR coverage rendering for AI catalog EXPAND prompt
//
// Tests the renderer that tells AI which `screen.X` fields actually have
// OCR bbox configured for this game, so AI doesn't generate silent-no-op
// `screen.X` assertions for unconfigured regions.

import { test, expect } from "@playwright/test";
import { renderOcrCoverageBlock } from "../../src/ai/test-catalog.ts";

test("all configured: block emphasizes including screen.X assertions", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: true,
    betArea: true,
    winArea: true,
    freeSpinCounter: true,
  });
  expect(out).toContain("=== OCR COVERAGE FOR THIS GAME ===");
  // All marked ✓
  expect(out.match(/✓/g)?.length).toBe(4);
  expect(out).not.toMatch(/✗/);
  // Tells AI to INCLUDE
  expect(out).toMatch(/INCLUDE at least/i);
  // Doesn't tell AI to skip ui_consistency
  expect(out).not.toMatch(/skip the.*ui_consistency.*entirely/i);
});

test("none configured: block tells AI to skip screen.X entirely", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: false,
    betArea: false,
    winArea: false,
    freeSpinCounter: false,
  });
  expect(out.match(/✗/g)?.length).toBe(4);
  expect(out).not.toMatch(/✓/);
  // Explicit "skip" / "no" guidance
  expect(out).toMatch(/skip the .*ui_consistency/i);
  expect(out).toMatch(/Do NOT generate any/i);
});

test("partial: only configured fields listed as allowed references", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: true,
    betArea: false,
    winArea: true,
    freeSpinCounter: false,
  });
  expect(out).toMatch(/PARTIAL coverage/i);
  // Configured fields are mentioned positively
  expect(out).toContain("screen.balance");
  expect(out).toContain("screen.last_win");
  // Unconfigured fields appear in the "NOT configured" list
  expect(out).toContain("screen.bet");
  // And explicit instruction not to reference them
  expect(out).toMatch(/NEVER reference the unconfigured/i);
});

test("partial: balance only", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: true,
    betArea: false,
    winArea: false,
    freeSpinCounter: false,
  });
  expect(out).toMatch(/PARTIAL/i);
  // Configured list: only screen.balance
  const configuredLine = out.split("\n").find((l) => l.includes("configured") && l.includes("screen.balance"));
  expect(configuredLine).toBeTruthy();
});

test("each region row contains both icon and runtime-effect note", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: true,
    betArea: false,
    winArea: true,
    freeSpinCounter: false,
  });
  expect(out).toMatch(/✓ balanceArea.*screen\.balance.*OCR runs/);
  expect(out).toMatch(/✗ betArea.*screen\.bet.*ALWAYS be null/);
  expect(out).toMatch(/✓ winArea.*screen\.last_win.*OCR runs/);
  expect(out).toMatch(/✗ freeSpinCounter.*ALWAYS be null/);
});

test("block is non-empty and ASCII-safe for prompt injection", () => {
  const out = renderOcrCoverageBlock({
    balanceArea: true,
    betArea: true,
    winArea: false,
    freeSpinCounter: false,
  });
  expect(out.length).toBeGreaterThan(200);
  // No real HTML tags (but `<slug>` placeholder in path strings is fine)
  expect(out).not.toMatch(/<(div|span|p|br|table)[^>]*>/i);
  expect(out).not.toMatch(/\x00/);
});

test("AI guidance differs for full vs none vs partial coverage", () => {
  const full = renderOcrCoverageBlock({ balanceArea: true, betArea: true, winArea: true, freeSpinCounter: true });
  const none = renderOcrCoverageBlock({ balanceArea: false, betArea: false, winArea: false, freeSpinCounter: false });
  const partial = renderOcrCoverageBlock({ balanceArea: true, betArea: false, winArea: false, freeSpinCounter: false });

  // Each variant has different critical-rule wording so AI gets different guidance
  expect(full).not.toBe(none);
  expect(full).not.toBe(partial);
  expect(none).not.toBe(partial);

  // "INCLUDE" guidance only in full
  expect(full).toMatch(/INCLUDE at least/);
  expect(none).not.toMatch(/INCLUDE at least/);
  expect(partial).not.toMatch(/INCLUDE at least/);

  // "Do NOT generate" only in none
  expect(none).toMatch(/Do NOT generate any/i);
  expect(full).not.toMatch(/Do NOT generate any/i);
});
