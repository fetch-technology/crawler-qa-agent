// INVARIANT — detectCascade resolution order
//
// Bug 2026-05-25: warm-start called detectCascade(null, "Generic") for
// vswaysmahwin2 (mis-classified provider). Result: cascade=false → simulate
// fired plain doSpin loop → ~19% of requests came back as na=c (cascade
// pending from prior spin) and were skipped → 1000 attempts → ~811 spins.
//
// Fix: when rounds is null but slug provided, detectCascade reads the
// pipeline-captured network.jsonl from registry and scans response bodies for
// cascade markers. Data-driven beats provider hint.

import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCascade } from "../../src/pipeline/step8-run-scenarios/detect-cascade.ts";

function withSlugCapture(slug: string, networkJsonl: string, fn: () => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "detect-cascade-"));
  const cwd = process.cwd();
  try {
    process.chdir(tmp);
    mkdirSync(join("fixtures", "registry", slug, "network"), { recursive: true });
    writeFileSync(
      join("fixtures", "registry", slug, "network", "network.jsonl"),
      networkJsonl,
    );
    fn();
  } finally {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

function round(index: number, responseBody: string) {
  return JSON.stringify({
    index,
    requests: [],
    responses: [
      { url: "https://x/spin", status: 200, headers: {}, body: responseBody, timing: { startedAt: 0, finishedAt: 1 } },
    ],
    wsFrames: [],
    screenshots: [],
  });
}

test("rounds provided + na=c marker → cascade=true", () => {
  expect(
    detectCascade(
      [{ index: 0, requests: [], responses: [{ url: "x", status: 200, headers: {}, body: "tw=1&na=c", timing: { startedAt: 0, finishedAt: 1 } }], wsFrames: [], screenshots: [] }],
      "Generic",
    ),
  ).toBe(true);
});

test("rounds provided + no cascade markers → cascade=false even with Pragmatic hint", () => {
  // Real captures beat provider hint: PP classic 5-reel paylines games should
  // not run cascade mode even though provider==Pragmatic.
  expect(
    detectCascade(
      [{ index: 0, requests: [], responses: [{ url: "x", status: 200, headers: {}, body: "tw=0&na=s&balance=99.5", timing: { startedAt: 0, finishedAt: 1 } }], wsFrames: [], screenshots: [] }],
      "Pragmatic",
    ),
  ).toBe(false);
});

test("rounds null + slug missing + Pragmatic hint → true (provider fallback)", () => {
  expect(detectCascade(null, "Pragmatic")).toBe(true);
});

test("rounds null + slug missing + Generic hint → false", () => {
  expect(detectCascade(null, "Generic")).toBe(false);
});

test("WARM-START regression: rounds=null + Generic provider + registry has na=c → cascade=true (slug fallback)", () => {
  // This is the exact production bug: vswaysmahwin2 saved as "Generic" but
  // network.jsonl contains real na=c markers. Without the slug fallback
  // detectCascade returned false → simulate skipped cascade mode → 189
  // wasted doSpin attempts.
  const jsonl = [round(0, "tw=0&na=s&balance=100"), round(1, "tw=0.5&na=c&balance=99.5"), round(2, "tw=2.5&na=s&balance=102")].join("\n");
  withSlugCapture("vswaysmahwin2", jsonl, () => {
    expect(detectCascade(null, "Generic", { slug: "vswaysmahwin2" })).toBe(true);
  });
});

test("rounds=null + slug points to capture with NO cascade markers → false", () => {
  const jsonl = [round(0, "tw=0&na=s"), round(1, "tw=1&na=s")].join("\n");
  withSlugCapture("vs20classic", jsonl, () => {
    expect(detectCascade(null, "Pragmatic", { slug: "vs20classic" })).toBe(false);
  });
});

test("rounds=null + slug missing on disk + Pragmatic hint → fallback to provider (true)", () => {
  // No registry file → readNetworkRounds returns [] → falls through to
  // provider hint, which says Pragmatic → cascade=true.
  expect(detectCascade(null, "Pragmatic", { slug: "does-not-exist" })).toBe(true);
});

test("rs_t=1 tier flag is also a cascade marker", () => {
  expect(
    detectCascade(
      [{ index: 0, requests: [], responses: [{ url: "x", status: 200, headers: {}, body: "tw=1&rs_t=1", timing: { startedAt: 0, finishedAt: 1 } }], wsFrames: [], screenshots: [] }],
      null,
    ),
  ).toBe(true);
});

test("stf=tumbl: trail marker is also a cascade marker", () => {
  expect(
    detectCascade(
      [{ index: 0, requests: [], responses: [{ url: "x", status: 200, headers: {}, body: "tw=1&stf=tumbl:abc", timing: { startedAt: 0, finishedAt: 1 } }], wsFrames: [], screenshots: [] }],
      null,
    ),
  ).toBe(true);
});
