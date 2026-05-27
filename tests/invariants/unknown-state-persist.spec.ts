// INVARIANT — unknown-state signature persistence (Phase 8.5)
//
// Tests the persistSignature gate: confidence threshold, overwrite policy,
// schema validity. Does NOT call AI (that path is tested separately).

import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { persistSignature } from "../../src/pipeline/step14-unknown-state-learn/index.ts";

const TEST_SLUG_PREFIX = "__test-unknown-persist-";
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

test("rejects signature with confidence below threshold (default 0.7)", async () => {
  const slug = await setup("low-conf");
  const r = await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["free spin"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.5 });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/threshold/);
});

test("accepts signature with confidence ≥ threshold", async () => {
  const slug = await setup("good-conf");
  const r = await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["free spin"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.9 });
  expect(r.ok).toBe(true);
  expect(r.signatures?.FREE_SPIN).toBeDefined();
});

test("refuses to overwrite existing signature unless overwrite=true", async () => {
  const slug = await setup("overwrite");
  // First save
  await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["free spin"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.9 });
  // Second save without overwrite
  const r = await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["different keyword"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.9 });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/already exists/);
});

test("allows overwrite when overwrite=true", async () => {
  const slug = await setup("force-overwrite");
  await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["original"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.9 });
  const r = await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["replacement"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.9, overwrite: true });
  expect(r.ok).toBe(true);
});

test("custom minConfidence threshold honored", async () => {
  const slug = await setup("custom-thresh");
  const r = await persistSignature(slug, {
    state: "FREE_SPIN", ocrAny: ["kw"], suggestedHandler: "dismiss_center",
  }, { confidence: 0.6, minConfidence: 0.5 });
  expect(r.ok).toBe(true);
});
