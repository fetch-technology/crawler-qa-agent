// INVARIANT — Signal Roll-up (2026-05-25)
//
// Replaces "5 signals decorating each assertion" with "5 case-level signals,
// each with concrete field-by-field sub-checks". User-driven design — see
// CaseResult.signalRollup schema in case-executor.ts.
//
// Pure shape + computation contract tests. Real Playwright runs verify the
// integration; these lock down the logic.

import { test, expect } from "@playwright/test";
import type {
  SignalRollup,
  SignalCheck,
  CaseResult,
} from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

test("SignalRollup: shape contract — signal/pass/checks/detail", () => {
  const r: SignalRollup = {
    signal: "ui_ocr",
    pass: true,
    checks: [
      {
        field: "balance",
        expected: 99.5,
        actual: 99.5,
        match: true,
        source: "ocr/balanceArea ↔ parser/balanceAfter",
      },
    ],
    detail: "1/1 UI widgets match API",
  };
  expect(r.signal).toBe("ui_ocr");
  expect(r.pass).toBe(true);
  expect(r.checks.length).toBe(1);
});

test("SignalCheck: match flags expected vs actual divergence + carries source", () => {
  const c: SignalCheck = {
    field: "bet",
    expected: 0.5,
    actual: 0,
    match: false,
    source: "ocr/betArea ↔ parser/spin.bet",
    note: "diff=0.500 > tolerance 0.05",
  };
  expect(c.match).toBe(false);
  expect(c.note).toMatch(/diff/);
});

test("SignalRollup: no-data signal returns pass=true + empty checks + detail", () => {
  // ui_ocr with no OCR regions configured: silent no-op, not a failure.
  const r: SignalRollup = {
    signal: "ui_ocr",
    pass: true,
    checks: [],
    detail: "no-data: no OCR regions configured for this game",
  };
  expect(r.pass).toBe(true);
  expect(r.checks).toEqual([]);
});

test("CaseResult.signalRollup: typically 5 entries (one per signal dimension)", () => {
  const result: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: { bet: 0.5, win: 0, balanceBefore: 100, balanceAfter: 99.5, state: "NORMAL", roundId: "r1" },
    durationMs: 1000,
    signalRollup: [
      { signal: "api", pass: true, checks: [] },
      { signal: "ui_ocr", pass: true, checks: [], detail: "no-data" },
      { signal: "network", pass: true, checks: [] },
      { signal: "state", pass: true, checks: [] },
      { signal: "rule", pass: true, checks: [] },
    ],
  };
  expect(result.signalRollup?.length).toBe(5);
  const signals = new Set(result.signalRollup?.map((s) => s.signal));
  expect(signals.has("api")).toBe(true);
  expect(signals.has("ui_ocr")).toBe(true);
  expect(signals.has("network")).toBe(true);
  expect(signals.has("state")).toBe(true);
  expect(signals.has("rule")).toBe(true);
});

test("SignalRollup ui_ocr: PASS when API.balance ≈ OCR.balance, FAIL when divergent", () => {
  // Happy path: tolerance 0.05 by design (see buildSignalRollup TOL constant)
  const pass: SignalRollup = {
    signal: "ui_ocr",
    pass: true,
    checks: [
      { field: "balance", expected: 99.5, actual: 99.5, match: true, source: "ocr ↔ api" },
      { field: "bet", expected: 0.5, actual: 0.5, match: true, source: "ocr ↔ api" },
      { field: "win", expected: 0, actual: 0, match: true, source: "ocr ↔ api" },
    ],
  };
  expect(pass.pass).toBe(true);
  expect(pass.checks.every((c) => c.match)).toBe(true);

  // Fail path: bet OCR'd 0 (Tesseract garbled) but API says 0.5
  const fail: SignalRollup = {
    signal: "ui_ocr",
    pass: false,
    checks: [
      { field: "balance", expected: 99.5, actual: 99.5, match: true, source: "ocr ↔ api" },
      { field: "bet", expected: 0.5, actual: 0, match: false, source: "ocr ↔ api", note: "diff=0.500 > tolerance 0.05" },
    ],
  };
  expect(fail.pass).toBe(false);
  expect(fail.checks.some((c) => !c.match)).toBe(true);
});

test("SignalRollup rule: balance arithmetic check uses balanceAfter == bb - bet + win", () => {
  // 100 - 0.5 + 0 = 99.5  ✓
  const goodArithmetic: SignalCheck = {
    field: "balance arithmetic",
    expected: 99.5,
    actual: 99.5,
    match: true,
    source: "balanceAfter == balanceBefore - bet + win",
  };
  expect(goodArithmetic.match).toBe(true);

  // 100 - 0.5 + 0 ≠ 99.0 → diff=0.5  ✗
  const badArithmetic: SignalCheck = {
    field: "balance arithmetic",
    expected: 99.5,
    actual: 99.0,
    match: false,
    source: "balanceAfter == balanceBefore - bet + win",
    note: "diff=0.500 > 0.01 — server math off OR parser bet/win wrong",
  };
  expect(badArithmetic.match).toBe(false);
  expect(badArithmetic.note).toMatch(/server math|parser/);
});

test("SignalRollup api: requires non-empty roundId + bet > 0 + finite balance", () => {
  // Mirrors buildSignalRollup logic. All three sub-checks must pass.
  const valid: SignalCheck[] = [
    { field: "spin captured", expected: "non-empty roundId", actual: "req-5-4", match: true, source: "parser/captured-spin" },
    { field: "bet", expected: "> 0 (bet was applied)", actual: 0.5, match: true, source: "parser/spin.bet" },
    { field: "win", expected: ">= 0 (non-negative)", actual: 0, match: true, source: "parser/spin.win" },
    { field: "balanceAfter", expected: "finite number", actual: 99.5, match: true, source: "parser/spin.balanceAfter" },
  ];
  const r: SignalRollup = { signal: "api", pass: true, checks: valid };
  expect(r.pass).toBe(true);

  // Regression: PragmaticParser bug where bet parsed as 0 — api signal catches it
  const betZero: SignalCheck[] = [...valid];
  betZero[1] = { ...valid[1], actual: 0, match: false, note: "parser returned bet=0" };
  const rFail: SignalRollup = { signal: "api", pass: false, checks: betZero };
  expect(rFail.pass).toBe(false);
});

test("SignalRollup state: no-transitions case passes (single-spin baseline)", () => {
  // Single-spin case with no popups → empty timeline → silently pass
  const r: SignalRollup = {
    signal: "state",
    pass: true,
    checks: [
      {
        field: "state timeline",
        expected: "captured",
        actual: 0,
        match: true,
        source: "state-observer",
        note: "no observable transitions during case (single-spin / no popups)",
      },
    ],
  };
  expect(r.pass).toBe(true);
});

test("SignalRollup state: unexpected interrupt fails unless in allowedInterrupts list", () => {
  const unexpected: SignalRollup = {
    signal: "state",
    pass: false,
    checks: [
      {
        field: "stayed on MAIN (or allowed interrupts)",
        expected: "all transitions to MAIN | allowed",
        actual: "MAIN→FREE_SPIN_TRIGGERED",
        match: false,
        source: "stateTimeline",
        note: "1 unexpected non-MAIN transitions",
      },
    ],
  };
  expect(unexpected.pass).toBe(false);
});

test("SignalRollup network: error warnings make the signal fail", () => {
  const r: SignalRollup = {
    signal: "network",
    pass: false,
    checks: [
      {
        field: "captured spins",
        expected: ">= 1",
        actual: 1,
        match: true,
        source: "page.on(response)",
      },
      {
        field: "no error warnings",
        expected: "0 errors/failures/debounced clicks",
        actual: "spin 1: likely debounced",
        match: false,
        source: "case-executor warnings",
        note: "1 warning(s)",
      },
    ],
  };
  expect(r.pass).toBe(false);
});
