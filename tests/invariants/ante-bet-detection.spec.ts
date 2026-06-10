// Ante state is decided PURELY by the total bet (OFF = smaller, ON = larger;
// ante inflates ~1.25×). These tests pin the two pure decision helpers that
// drive ensureAnteOff's toggle-probe, so the "reports OFF but game is ON"
// class of bug (pixel-diff false positives) can't regress.

import { test, expect } from "@playwright/test";
import { classifyBetRatio, planAnteToggle } from "../../src/pipeline/step2-detect-ui/ante-normalize.js";

test("classifyBetRatio: ante ON inflates bet → 'on'", () => {
  expect(classifyBetRatio(0.5, 0.4)).toBe("on");   // 1.25× ante surcharge
  expect(classifyBetRatio(0.75, 0.6)).toBe("on");  // 1.25×
  expect(classifyBetRatio(0.8, 0.4)).toBe("on");   // 2×
});

test("classifyBetRatio: bet matches recorded OFF bet → 'off'", () => {
  expect(classifyBetRatio(0.4, 0.4)).toBe("off");
  expect(classifyBetRatio(0.4, 0.4001)).toBe("off"); // tiny OCR jitter
  expect(classifyBetRatio(0.41, 0.4)).toBe("off");   // within 5%
});

test("classifyBetRatio: ambiguous mid-band / invalid → 'unknown'", () => {
  expect(classifyBetRatio(0.43, 0.4)).toBe("unknown"); // 1.075× — between thresholds
  expect(classifyBetRatio(0, 0.4)).toBe("unknown");
  expect(classifyBetRatio(0.4, 0)).toBe("unknown");
});

test("planAnteToggle: click lowered the bet → after is OFF", () => {
  const p = planAnteToggle(0.5, 0.4, 0.02);
  expect(p.kind).toBe("changed");
  expect(p.kind === "changed" && p.afterIsOff).toBe(true);
});

test("planAnteToggle: click raised the bet → after is ON (toggle back)", () => {
  const p = planAnteToggle(0.4, 0.5, 0.02);
  expect(p.kind).toBe("changed");
  expect(p.kind === "changed" && p.afterIsOff).toBe(false);
});

test("planAnteToggle: bet unchanged → wrong coord / needs confirm", () => {
  expect(planAnteToggle(0.4, 0.4, 0.02).kind).toBe("no-change");
  expect(planAnteToggle(0.4, 0.4005, 0.02).kind).toBe("no-change"); // < 2% jitter
});

test("planAnteToggle: unreadable bet on either side", () => {
  expect(planAnteToggle(null, 0.4, 0.02).kind).toBe("unreadable");
  expect(planAnteToggle(0.4, null, 0.02).kind).toBe("unreadable");
  expect(planAnteToggle(0, 0.4, 0.02).kind).toBe("unreadable");
});
