// INVARIANT — Knowledge Compiler determinism + cross-validation
//
// The compiler is the bridge between raw configs and engine. It MUST:
//   1. Be deterministic — same source files → same output (modulo `compiledAt`)
//   2. Detect source changes via sourceHashes
//   3. Cross-validate config consistency, surface warnings + errors
//   4. Apply defaults so engine never sees missing fields
//
// If broken: engine consumes stale/inconsistent configs → mysterious failures.

import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { compileKnowledge, isCompiledKnowledgeFresh } from "../../src/pipeline/knowledge/compiler.js";

const TEST_SLUG_PREFIX = "__test-knowledge-compiler-";
const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures", "registry");

let testSlugsCreated: string[] = [];

async function setup(suffix: string, files: Record<string, unknown>): Promise<string> {
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

test("compileKnowledge returns object with expected top-level fields", async () => {
  const slug = await setup("minimal", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "_meta.json": { schemaVersion: 1, createdAt: new Date().toISOString(), gameUrl: "https://x.example/" },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.schemaVersion).toBe(1);
  expect(knowledge.gameSlug).toBe(slug);
  expect(knowledge.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(typeof knowledge.sourceHashes).toBe("object");
  expect(knowledge.timing).toBeDefined();
  expect(knowledge.betControls).toBeDefined();
  expect(knowledge.popupKeywords).toBeDefined();
  expect(knowledge.subStateHints).toBeDefined();
});

test("compileKnowledge applies timing defaults when no timing-config.json", async () => {
  const slug = await setup("defaults", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.timing.spinResponseTimeoutMs).toBe(15000);
  expect(knowledge.timing.postActionSettleMs).toBe(10000);
  expect(knowledge.timing.maxSpinRetries).toBe(2);
});

test("compileKnowledge merges timing overrides", async () => {
  const slug = await setup("override", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "timing-config.json": { spinResponseTimeoutMs: 30000 },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.timing.spinResponseTimeoutMs).toBe(30000);
  expect(knowledge.timing.postActionSettleMs).toBe(10000); // unaffected
});

test("compileKnowledge derives bet formula description from mechanics", async () => {
  const slug = await setup("mechanic", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "game-mechanics.json": {
      mechanic: "ways",
      betMultiplier: 20,
      waysOrLines: 1024,
      detectedAt: new Date().toISOString(),
      detectionMethod: "balance_derived",
    },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.derived.betFormulaDescription).toMatch(/c × 20.*ways/);
});

test("compileKnowledge produces 'naive' bet formula description without mechanics", async () => {
  const slug = await setup("no-mechanic", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.derived.betFormulaDescription).toMatch(/naive/);
});

test("cross-validation: missing spinButton with non-empty ui-registry → ERROR", async () => {
  const slug = await setup("no-spin-button", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "ui-registry.json": {
      betPlus: { x: 100, y: 200, strategy: "manual", confidence: 1.0, detectedAt: new Date().toISOString() },
    },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.errors.length).toBeGreaterThan(0);
  expect(knowledge.errors.join(" ")).toMatch(/spinButton/);
});

test("cross-validation: missing parser.json → WARNING (not error)", async () => {
  const slug = await setup("no-parser", {
    "ui-registry.json": {
      spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1.0, detectedAt: new Date().toISOString() },
    },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.warnings.join(" ")).toMatch(/parser\.json/);
  expect(knowledge.errors.length).toBe(0);
});

test("cross-validation: mechanic='unknown' → WARNING", async () => {
  const slug = await setup("unknown-mechanic", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "ui-registry.json": {
      spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1.0, detectedAt: new Date().toISOString() },
    },
    "game-mechanics.json": {
      mechanic: "unknown",
      betMultiplier: 5,
      waysOrLines: 0,
      detectedAt: new Date().toISOString(),
      detectionMethod: "fallback",
    },
  });
  const knowledge = await compileKnowledge(slug);
  expect(knowledge.warnings.join(" ")).toMatch(/mechanic.*unknown/);
});

test("determinism: same source files → same sourceHashes", async () => {
  const slug = await setup("deterministic", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "timing-config.json": { spinResponseTimeoutMs: 12000 },
  });
  const a = await compileKnowledge(slug);
  const b = await compileKnowledge(slug);
  // sourceHashes object must be identical
  expect(a.sourceHashes).toEqual(b.sourceHashes);
  // Engine-relevant fields too
  expect(a.timing).toEqual(b.timing);
  expect(a.ui).toEqual(b.ui);
});

test("isCompiledKnowledgeFresh: true when source unchanged", async () => {
  const slug = await setup("fresh", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const k = await compileKnowledge(slug);
  const fresh = await isCompiledKnowledgeFresh(slug, k);
  expect(fresh).toBe(true);
});

test("isCompiledKnowledgeFresh: false when a source file changes", async () => {
  const slug = await setup("stale", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const k = await compileKnowledge(slug);
  // Mutate source
  await writeFile(
    path.join(FIXTURES_ROOT, slug, "parser.json"),
    JSON.stringify({ parser: "GenericParser", version: 1 }, null, 2),
  );
  const fresh = await isCompiledKnowledgeFresh(slug, k);
  expect(fresh).toBe(false);
});

test("isCompiledKnowledgeFresh: false when new config file added", async () => {
  const slug = await setup("new-file", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const k = await compileKnowledge(slug);
  // Add a new config file
  await writeFile(
    path.join(FIXTURES_ROOT, slug, "timing-config.json"),
    JSON.stringify({ spinResponseTimeoutMs: 99000 }, null, 2),
  );
  const fresh = await isCompiledKnowledgeFresh(slug, k);
  expect(fresh).toBe(false);
});
