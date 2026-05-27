// INVARIANT — FLAKY detector + history persistence
//
// Detector + storage are pure (history) + I/O (store). Tests verify:
//   - Disagreement across recent N runs → FLAKY
//   - Consistent pass / consistent fail → stable
//   - <FLAKY_MIN_HISTORY entries → can't decide (not flaky)
//   - INCONCLUSIVE / NEEDS_REVIEW don't count toward disagreement
//   - Store appends append-only + trims to MAX_HISTORY_ENTRIES

import { test, expect } from "@playwright/test";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";

import {
  detectFlaky,
  maybePromoteToFlaky,
  appendHistory,
  loadHistory,
  recentHistory,
  MAX_HISTORY_ENTRIES,
} from "../../src/pipeline/step8-run-scenarios/history/index.ts";
import type { HistoryEntry } from "../../src/pipeline/step8-run-scenarios/history/index.ts";

const TEST_SLUG_PREFIX = "__test-flaky-";
const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures", "registry");

let testSlugsCreated: string[] = [];

async function setup(suffix: string): Promise<string> {
  const slug = `${TEST_SLUG_PREFIX}${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(FIXTURES_ROOT, slug);
  await mkdir(dir, { recursive: true });
  testSlugsCreated.push(slug);
  return slug;
}

test.afterEach(async () => {
  for (const slug of testSlugsCreated) {
    await rm(path.join(FIXTURES_ROOT, slug), { recursive: true, force: true }).catch(() => undefined);
  }
  testSlugsCreated = [];
});

function entry(outcome: HistoryEntry["outcome"]): HistoryEntry {
  return {
    ranAt: new Date().toISOString(),
    outcome,
    status: outcome.startsWith("PASS") ? "pass" : outcome.startsWith("FAIL") ? "fail" : "skip",
    durationMs: 1000,
  };
}

// === detectFlaky pure logic ===

test("empty history → not flaky (too few runs)", () => {
  const v = detectFlaky([]);
  expect(v.flaky).toBe(false);
  expect(v.reason).toMatch(/0 runs/);
});

test("1 run → not flaky (need at least 3)", () => {
  const v = detectFlaky([entry("PASS_HIGH")]);
  expect(v.flaky).toBe(false);
});

test("3 consistent passes → not flaky", () => {
  const v = detectFlaky([entry("PASS_HIGH"), entry("PASS_HIGH"), entry("PASS_LOW")]);
  expect(v.flaky).toBe(false);
  expect(v.reason).toMatch(/consistent pass/);
});

test("3 consistent fails → not flaky", () => {
  const v = detectFlaky([entry("FAIL_HIGH"), entry("FAIL_LOW"), entry("FAIL_HIGH")]);
  expect(v.flaky).toBe(false);
  expect(v.reason).toMatch(/consistent fail/);
});

test("pass + fail mix → FLAKY", () => {
  const v = detectFlaky([entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH")]);
  expect(v.flaky).toBe(true);
  expect(v.reason).toMatch(/pass.*fail/);
});

test("PASS_LOW + FAIL_LOW counted as pass/fail families (still flaky)", () => {
  const v = detectFlaky([entry("PASS_LOW"), entry("FAIL_LOW"), entry("PASS_HIGH")]);
  expect(v.flaky).toBe(true);
});

test("INCONCLUSIVE runs don't count toward disagreement", () => {
  const v = detectFlaky([entry("INCONCLUSIVE"), entry("INCONCLUSIVE"), entry("INCONCLUSIVE")]);
  expect(v.flaky).toBe(false);
});

test("only inspects last FLAKY_WINDOW entries (older history ignored)", () => {
  // 10 entries: 5 fails followed by 5 passes (latest). Should not be flaky (consistent latest)
  const hist: HistoryEntry[] = [
    ...Array(5).fill(entry("FAIL_HIGH")),
    ...Array(5).fill(entry("PASS_HIGH")),
  ];
  const v = detectFlaky(hist);
  expect(v.flaky).toBe(false);
  expect(v.reason).toMatch(/consistent pass/);
});

// === maybePromoteToFlaky ===

test("fresh PASS + flaky history → promoted to FLAKY", () => {
  const history: HistoryEntry[] = [
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_LOW"),
  ];
  const promoted = maybePromoteToFlaky("PASS_HIGH", history);
  expect(promoted).toBe("FLAKY");
});

test("fresh PASS + stable history → keeps PASS", () => {
  const history: HistoryEntry[] = [
    entry("PASS_HIGH"), entry("PASS_HIGH"), entry("PASS_LOW"),
  ];
  expect(maybePromoteToFlaky("PASS_HIGH", history)).toBe("PASS_HIGH");
});

test("fresh INCONCLUSIVE never promoted to FLAKY", () => {
  const history: HistoryEntry[] = [
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"),
  ];
  expect(maybePromoteToFlaky("INCONCLUSIVE", history)).toBe("INCONCLUSIVE");
});

test("fresh NEEDS_REVIEW never promoted", () => {
  const history: HistoryEntry[] = [
    entry("PASS_HIGH"), entry("FAIL_HIGH"), entry("PASS_HIGH"),
  ];
  expect(maybePromoteToFlaky("NEEDS_REVIEW", history)).toBe("NEEDS_REVIEW");
});

// === History persistence ===

test("appendHistory creates new log file on first call", async () => {
  const slug = await setup("append-new");
  await appendHistory(slug, "case-1", entry("PASS_HIGH"));
  const entries = await loadHistory(slug, "case-1");
  expect(entries.length).toBe(1);
  expect(entries[0]!.outcome).toBe("PASS_HIGH");
});

test("appendHistory appends multiple entries in order", async () => {
  const slug = await setup("multi-append");
  await appendHistory(slug, "case-1", entry("PASS_HIGH"));
  await appendHistory(slug, "case-1", entry("FAIL_HIGH"));
  await appendHistory(slug, "case-1", entry("PASS_LOW"));
  const entries = await loadHistory(slug, "case-1");
  expect(entries.length).toBe(3);
  expect(entries.map((e) => e.outcome)).toEqual(["PASS_HIGH", "FAIL_HIGH", "PASS_LOW"]);
});

test("loadHistory returns [] when log missing", async () => {
  const slug = await setup("no-log");
  const entries = await loadHistory(slug, "nonexistent-case");
  expect(entries).toEqual([]);
});

test("recentHistory returns last N entries", async () => {
  const slug = await setup("recent");
  for (let i = 0; i < 7; i++) {
    await appendHistory(slug, "case-1", entry(i % 2 === 0 ? "PASS_HIGH" : "FAIL_HIGH"));
  }
  const recent = await recentHistory(slug, "case-1", 3);
  expect(recent.length).toBe(3);
});

test("history trims to MAX_HISTORY_ENTRIES when exceeded", async () => {
  const slug = await setup("trim");
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
    await appendHistory(slug, "case-1", entry("PASS_HIGH"));
  }
  const entries = await loadHistory(slug, "case-1");
  expect(entries.length).toBe(MAX_HISTORY_ENTRIES);
});

test("multiple cases stored in separate files", async () => {
  const slug = await setup("multi-case");
  await appendHistory(slug, "case-A", entry("PASS_HIGH"));
  await appendHistory(slug, "case-B", entry("FAIL_HIGH"));
  expect((await loadHistory(slug, "case-A")).length).toBe(1);
  expect((await loadHistory(slug, "case-B")).length).toBe(1);
  expect((await loadHistory(slug, "case-A"))[0]!.outcome).toBe("PASS_HIGH");
  expect((await loadHistory(slug, "case-B"))[0]!.outcome).toBe("FAIL_HIGH");
});

test("case IDs with special chars are sanitized in filename", async () => {
  const slug = await setup("special");
  await appendHistory(slug, "case/with:weird*chars", entry("PASS_HIGH"));
  const entries = await loadHistory(slug, "case/with:weird*chars");
  expect(entries.length).toBe(1);
});
