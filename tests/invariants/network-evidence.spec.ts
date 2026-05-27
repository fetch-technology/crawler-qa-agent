// INVARIANT — Network evidence + parser diagnostic schema
//
// CaseResult gained networkLogPath / networkSummary / parserDiagnostic fields
// on 2026-05-25. Verify shape contracts so the JSON written by the executor
// stays consumable by the dashboard.

import { test, expect } from "@playwright/test";
import type {
  CaseResult,
  NetworkLogEntry,
} from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

test("NetworkLogEntry: shape contract", () => {
  const e: NetworkLogEntry = {
    url: "https://pp.dev/gs2c/v3/gameService",
    method: "POST",
    status: 200,
    durationMs: 420,
    requestBody: "action=doSpin&c=0.025&l=1024&bl=0",
    responseBody: "sb=99998033.79&ba=99998033.29&tw=0",
    at: "2026-05-25T10:00:00Z",
    parsedAsSpin: true,
  };
  expect(e.parsedAsSpin).toBe(true);
  expect(e.responseBody).toContain("ba=99998033.29");
});

test("NetworkLogEntry: parsedAsSpin can be undefined (not yet evaluated)", () => {
  const e: NetworkLogEntry = {
    url: "https://pp.dev/gs2c/v3/gameService",
    method: "POST",
    status: 200,
    durationMs: 100,
    requestBody: null,
    responseBody: "small body",
    at: "2026-05-25T10:00:00Z",
  };
  expect(e.parsedAsSpin).toBeUndefined();
});

test("CaseResult.networkSummary: compact projection of network log", () => {
  const r: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: null,
    durationMs: 1000,
    networkLogPath: "fixtures/registry/vswaysmahwin2/case-evidence/x.network.jsonl",
    networkSummary: [
      { url: "https://pp.dev/gs2c", method: "POST", status: 200, durationMs: 420, parsedAsSpin: true },
      { url: "https://pp.dev/init", method: "POST", status: 200, durationMs: 80, parsedAsSpin: false },
    ],
  };
  expect(r.networkSummary?.length).toBe(2);
  expect(r.networkSummary?.[0].parsedAsSpin).toBe(true);
  expect(r.networkSummary?.[1].parsedAsSpin).toBe(false);
});

test("CaseResult.parserDiagnostic: flags mismatch when parsed bet ≠ expected", () => {
  const r: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "fail",
    actionsExecuted: 1,
    assertions: [],
    spin: { bet: 0, win: 0, balanceBefore: 100, balanceAfter: 99.5, state: "NORMAL", roundId: "r1" },
    durationMs: 1000,
    parserDiagnostic: {
      parserKind: "GenericParser",
      requestFields: { c: 0.025, l: 1024, bl: 0 },
      formulaUsed: "no `c` in request — parser cannot compute",
      parsedBet: 0,
      mismatch: true,
    },
  };
  expect(r.parserDiagnostic?.mismatch).toBe(true);
  expect(r.parserDiagnostic?.parserKind).toBe("GenericParser");
  expect(r.parserDiagnostic?.parsedBet).toBe(0);
});

test("CaseResult.parserDiagnostic: no mismatch when bet correct", () => {
  const r: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: { bet: 0.5, win: 0, balanceBefore: 100, balanceAfter: 99.5, state: "NORMAL", roundId: "r1" },
    durationMs: 1000,
    parserDiagnostic: {
      parserKind: "PragmaticParser",
      betMultiplier: 20,
      requestFields: { c: 0.025, l: 1024, bl: 0 },
      formulaUsed: "c × M = 0.025 × 20",
      parsedBet: 0.5,
      expectedBet: 0.5,
      mismatch: false,
    },
  };
  expect(r.parserDiagnostic?.mismatch).toBe(false);
  expect(r.parserDiagnostic?.expectedBet).toBe(0.5);
});

test("CaseResult: evidence fields are independent and all optional", () => {
  // A legacy run without any of the new fields still parses as CaseResult.
  const legacy: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: null,
    durationMs: 500,
  };
  expect(legacy.networkLogPath).toBeUndefined();
  expect(legacy.networkSummary).toBeUndefined();
  expect(legacy.parserDiagnostic).toBeUndefined();
});
