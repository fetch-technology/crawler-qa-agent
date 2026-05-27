// INVARIANT — case-evidence package (2026-05-25)
//
// Verifies the CaseResult schema additions and behavior contracts:
//   1. CaseResult exposes ocrSnapshots / actionLog / screenshotPath
//      fields (TypeScript shape).
//   2. OcrSnapshot persists raw text + parsed value + bbox per region.
//   3. ActionLogEntry persists per-action kind + target + duration + success.
//
// Pure type/shape checks — does NOT run a live case (those require
// Playwright + headed Chrome, which belong in e2e suites).

import { test, expect } from "@playwright/test";
import type {
  CaseResult,
  OcrSnapshot,
  ActionLogEntry,
} from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

test("OcrSnapshot: shape contract — region/bbox/text/parsed/durationMs/bboxScreenshotPath", () => {
  const snap: OcrSnapshot = {
    region: "balance",
    bbox: { x: 100, y: 200, width: 150, height: 30 },
    text: "99998041.39",
    parsed: 99998041.39,
    durationMs: 850,
    bboxScreenshotPath: "fixtures/registry/vswaysmahwin2/case-evidence/x.balance.png",
  };
  expect(snap.region).toBe("balance");
  expect(snap.bbox.width).toBe(150);
  expect(snap.parsed).toBe(99998041.39);
  expect(snap.bboxScreenshotPath).toMatch(/\.balance\.png$/);
});

test("OcrSnapshot: bboxScreenshotPath is OPTIONAL (legacy snapshots had none)", () => {
  const legacy: OcrSnapshot = {
    region: "balance",
    bbox: { x: 0, y: 0, width: 50, height: 20 },
    text: "1.0",
    parsed: 1.0,
    durationMs: 100,
    // bboxScreenshotPath OMITTED — pre-2026-05-25 snapshots
  };
  expect(legacy.bboxScreenshotPath).toBeUndefined();
});

test("OcrSnapshot: parsed=null when OCR text couldn't be parsed", () => {
  const snap: OcrSnapshot = {
    region: "bet",
    bbox: { x: 100, y: 200, width: 60, height: 25 },
    text: "garbled |||",
    parsed: null,
    durationMs: 720,
  };
  expect(snap.parsed).toBeNull();
  // Dashboard renders red ✗ when parsed===null — invariant lets it.
});

test("OcrSnapshot: all 4 region values are accepted by type", () => {
  const regions: OcrSnapshot["region"][] = ["balance", "bet", "last_win", "free_spin_counter"];
  for (const r of regions) {
    const snap: OcrSnapshot = {
      region: r,
      bbox: { x: 0, y: 0, width: 50, height: 20 },
      text: "0",
      parsed: 0,
      durationMs: 100,
    };
    expect(snap.region).toBe(r);
  }
});

test("ActionLogEntry: shape contract — kind/target/durationMs/success", () => {
  const entry: ActionLogEntry = {
    kind: "click",
    target: "spinButton",
    durationMs: 240,
    success: true,
  };
  expect(entry.kind).toBe("click");
  expect(entry.target).toBe("spinButton");
  expect(entry.success).toBe(true);
});

test("ActionLogEntry: optional target (e.g. spin action)", () => {
  const entry: ActionLogEntry = {
    kind: "spin",
    durationMs: 3200,
    success: true,
  };
  expect(entry.target).toBeUndefined();
});

test("ActionLogEntry: failed action carries note", () => {
  const entry: ActionLogEntry = {
    kind: "click",
    target: "buyBonusButton",
    durationMs: 5000,
    success: false,
    note: "Element not in uiMap — translator skipped",
  };
  expect(entry.success).toBe(false);
  expect(entry.note).toMatch(/translator/);
});

test("CaseResult: evidence fields all optional (legacy results without evidence still parse)", () => {
  const legacy: CaseResult = {
    caseId: "x",
    name: "n",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: null,
    durationMs: 1000,
    // ocrSnapshots, actionLog, screenshotPath — all OMITTED
  };
  expect(legacy.ocrSnapshots).toBeUndefined();
  expect(legacy.actionLog).toBeUndefined();
  expect(legacy.screenshotPath).toBeUndefined();
});

test("CaseResult: evidence fields populated alongside legacy fields", () => {
  const rich: CaseResult = {
    caseId: "rich",
    name: "Rich evidence case",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 3,
    assertions: [],
    spin: { bet: 0.5, win: 0, balanceBefore: 100, balanceAfter: 99.5, state: "NORMAL", roundId: "r1" },
    spinsCount: 1,
    durationMs: 5000,
    screenshotPath: "fixtures/registry/vswaysmahwin2/case-evidence/rich.png",
    ocrSnapshots: [
      { region: "balance", bbox: { x: 290, y: 645, width: 148, height: 32 }, text: "99.50", parsed: 99.5, durationMs: 800 },
      { region: "bet", bbox: { x: 290, y: 672, width: 60, height: 25 }, text: "0.50", parsed: 0.5, durationMs: 750 },
    ],
    actionLog: [
      { kind: "click", target: "betMinus", durationMs: 120, success: true },
      { kind: "wait_ms", target: "1500ms", durationMs: 1505, success: true },
      { kind: "spin", durationMs: 3000, success: true },
    ],
  };
  expect(rich.ocrSnapshots?.length).toBe(2);
  expect(rich.actionLog?.length).toBe(3);
  expect(rich.screenshotPath).toMatch(/case-evidence/);
});

test("ActionLogEntry: slow action (>3s) is renderable — dashboard highlights via styling", () => {
  // Sanity that schema doesn't restrict duration upper-bound; dashboard
  // applies the slow-action highlight (orange) at >3000ms.
  const slowEntry: ActionLogEntry = {
    kind: "spin",
    durationMs: 18_500,
    success: true,
    note: "settled after 5 cascade frames",
  };
  expect(slowEntry.durationMs).toBeGreaterThan(3000);
  expect(slowEntry.note).toMatch(/cascade/);
});

test("Evidence-screenshot path uses case-evidence dir convention", () => {
  // Schema doesn't enforce the path — but the executor writes here so
  // dashboard's back-compat fallback works (new dir first, legacy dir second).
  const r: CaseResult = {
    caseId: "test",
    name: "x",
    category: "base_game",
    severity: "critical",
    status: "pass",
    actionsExecuted: 1,
    assertions: [],
    spin: null,
    durationMs: 500,
    screenshotPath: "fixtures/registry/vs20rnriches/case-evidence/test.png",
  };
  expect(r.screenshotPath).toContain("case-evidence");
  expect(r.screenshotPath).not.toContain("case-failures");
});
