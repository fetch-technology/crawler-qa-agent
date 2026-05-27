// INVARIANT — Patch Validator (Phase 7.6)
//
// Patch validator is the SECURITY BOUNDARY between AI suggestions and disk.
// It MUST:
//   1. Reject patches targeting unknown / arbitrary files
//   2. Reject patches that would produce schema-invalid output
//   3. Reject patches that violate sanity bounds (out-of-range values)
//   4. ALLOW well-formed patches to known registry files
//
// If broken: AI can mutate engine-poisoning configs, escape allowed paths,
// or write garbage that crashes the engine.

import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validatePatch, applyPatch, revertPatch } from "../../src/pipeline/step13-patch-apply/index.js";

const TEST_SLUG_PREFIX = "__test-patch-validator-";
const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures", "registry");

let testSlugsCreated: string[] = [];

async function setup(suffix: string, files: Record<string, unknown> = {}): Promise<string> {
  const slug = `${TEST_SLUG_PREFIX}${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(FIXTURES_ROOT, slug);
  await mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
  }
  testSlugsCreated.push(slug);
  return slug;
}

test.afterEach(async () => {
  for (const slug of testSlugsCreated) {
    await rm(path.join(FIXTURES_ROOT, slug), { recursive: true, force: true }).catch(() => undefined);
  }
  testSlugsCreated = [];
});

// === Gate 1: filename allow-list ===

test("rejects patch targeting file outside REGISTRY_FILES", async () => {
  const slug = await setup("disallowed-file");
  const result = await validatePatch(slug, {
    file: "arbitrary.json",
    operation: "merge",
    diff: { x: 1 },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/not in the allowed/);
});

test("rejects patch with traversal attempt in filename", async () => {
  const slug = await setup("traversal");
  const result = await validatePatch(slug, {
    file: "../../../etc/passwd",
    operation: "merge",
    diff: { x: 1 },
  });
  expect(result.ok).toBe(false);
});

// === Gate 2: schema validation ===

test("rejects patch that would produce schema-invalid game-mechanics", async () => {
  const slug = await setup("bad-mechanics", {
    "game-mechanics.json": {
      mechanic: "lines", betMultiplier: 20, waysOrLines: 20,
      detectedAt: new Date().toISOString(), detectionMethod: "balance_derived",
    },
  });
  // Patch wants to set mechanic to value outside enum
  const result = await validatePatch(slug, {
    file: "game-mechanics.json",
    operation: "merge",
    diff: { mechanic: "fortunewheel" },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/schema|enum/);
});

test("accepts well-formed game-mechanics merge", async () => {
  const slug = await setup("good-mechanics", {
    "game-mechanics.json": {
      mechanic: "lines", betMultiplier: 20, waysOrLines: 20,
      detectedAt: new Date().toISOString(), detectionMethod: "balance_derived",
    },
  });
  const result = await validatePatch(slug, {
    file: "game-mechanics.json",
    operation: "merge",
    diff: { betMultiplier: 25 },
  });
  expect(result.ok).toBe(true);
});

// === Gate 3: sanity bounds ===

test("rejects betMultiplier > 1000 (sanity)", async () => {
  const slug = await setup("sanity-mul", {
    "game-mechanics.json": {
      mechanic: "lines", betMultiplier: 20, waysOrLines: 20,
      detectedAt: new Date().toISOString(), detectionMethod: "balance_derived",
    },
  });
  const result = await validatePatch(slug, {
    file: "game-mechanics.json",
    operation: "merge",
    diff: { betMultiplier: 99999 },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/range|plausible/);
});

test("rejects UI coord > 10000 (sanity)", async () => {
  const slug = await setup("sanity-coord", {
    "ui-registry.json": {
      spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1, detectedAt: "" },
    },
  });
  const result = await validatePatch(slug, {
    file: "ui-registry.json",
    operation: "merge",
    diff: { spinButton: { x: 99999, y: 200, strategy: "manual", confidence: 1, detectedAt: "" } },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/viewport/);
});

test("rejects spinResponseTimeoutMs < 1s (likely typo)", async () => {
  const slug = await setup("sanity-timing");
  const result = await validatePatch(slug, {
    file: "timing-config.json",
    operation: "merge",
    diff: { spinResponseTimeoutMs: 500 },
  });
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toMatch(/<.*1s/);
});

// === apply + revert lifecycle ===

test("applyPatch writes new content + audit log", async () => {
  const slug = await setup("apply", {
    "game-mechanics.json": {
      mechanic: "lines", betMultiplier: 20, waysOrLines: 20,
      detectedAt: new Date().toISOString(), detectionMethod: "balance_derived",
    },
  });
  const patch = { file: "game-mechanics.json", operation: "merge" as const, diff: { betMultiplier: 25 } };
  const validation = await validatePatch(slug, patch);
  expect(validation.ok).toBe(true);

  const applied = await applyPatch({
    gameSlug: slug,
    caseId: "test-case",
    review: { classification: "wrong_bet_formula", confidence: 0.9, reason: "test", meta: { durationMs: 0 } },
    patch,
    validation,
    dryRun: null,
  });
  expect(applied.ok).toBe(true);
  expect(applied.auditLogPath).toBeDefined();

  // Verify content changed
  const { readFile } = await import("node:fs/promises");
  const updated = JSON.parse(await readFile(path.join(FIXTURES_ROOT, slug, "game-mechanics.json"), "utf8"));
  expect(updated.betMultiplier).toBe(25);
});

test("revertPatch restores prevContent from audit log", async () => {
  const slug = await setup("revert", {
    "game-mechanics.json": {
      mechanic: "lines", betMultiplier: 20, waysOrLines: 20,
      detectedAt: new Date().toISOString(), detectionMethod: "balance_derived",
    },
  });
  const patch = { file: "game-mechanics.json", operation: "merge" as const, diff: { betMultiplier: 25 } };
  const validation = await validatePatch(slug, patch);
  const applied = await applyPatch({
    gameSlug: slug,
    caseId: "test-case",
    review: { classification: "wrong_bet_formula", confidence: 0.9, reason: "test", meta: { durationMs: 0 } },
    patch,
    validation,
    dryRun: null,
  });
  expect(applied.ok).toBe(true);

  // Now revert
  const reverted = await revertPatch(applied.auditLogPath!);
  expect(reverted.ok).toBe(true);

  // Content should be back to 20
  const { readFile } = await import("node:fs/promises");
  const final = JSON.parse(await readFile(path.join(FIXTURES_ROOT, slug, "game-mechanics.json"), "utf8"));
  expect(final.betMultiplier).toBe(20);
});
