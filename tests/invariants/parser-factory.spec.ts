// INVARIANT — parser factory auto-loads bet formula from registry
//
// `createParserForGame(slug)` is the single construction path. It must:
//   1. Load parser kind from parser.json
//   2. Load betMultiplier from game-mechanics.json (if present)
//   3. Apply multiplier to the parser before returning
//   4. Fall back gracefully when game-mechanics.json absent (naive formula)
//   5. Honor explicit overrides (parserKind, skipBetMultiplier)
//
// If broken: ways games (vswaysmahwin2) silently get bet = c × waysCount
// (460.8) instead of c × 20 (9.0) — manifests as cumulative balance
// assertions failing without obvious cause.
//
// Test approach: writes temporary game registries under fixtures/registry/
// using a "__test-" slug prefix, cleans up in afterEach. Cannot use a tempdir
// because src/pipeline/registry/paths.ts resolves ROOT at module-load time.

import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createParserForGame } from "../../src/pipeline/step6-build-model/parser-factory.js";
import { ppRequestBody, ppResponseBody } from "./helpers.js";

// PP-specific built-in parser registration must be triggered.
import "../../src/pipeline/step6-build-model/index.js";

const TEST_SLUG_PREFIX = "__test-parser-factory-";
const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures", "registry");
const URL = "https://example.pragmatic.example/gs2c/v3/gameService";

let testSlugsCreated: string[] = [];

async function setupGame(suffix: string, files: Record<string, unknown>): Promise<string> {
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

test("loads PragmaticParser when parser.json says PragmaticParser", async () => {
  const slug = await setupGame("pp", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
  });
  const parser = await createParserForGame(slug);
  expect(parser.kind).toBe("PragmaticParser");
});

test("loads GenericParser when parser.json says GenericParser", async () => {
  const slug = await setupGame("generic", {
    "parser.json": { parser: "GenericParser", version: 1 },
  });
  const parser = await createParserForGame(slug);
  expect(parser.kind).toBe("GenericParser");
});

test("throws when parser.json missing and no override", async () => {
  await expect(createParserForGame(`${TEST_SLUG_PREFIX}nonexistent`)).rejects.toThrow(/No parser\.json/);
});

test("parserKind override skips parser.json load", async () => {
  // No registry written — override must work without disk
  const parser = await createParserForGame(`${TEST_SLUG_PREFIX}no-registry`, { parserKind: "PragmaticParser" });
  expect(parser.kind).toBe("PragmaticParser");
});

test("auto-applies betMultiplier from game-mechanics.json (ways game)", async () => {
  const slug = await setupGame("ways", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "game-mechanics.json": {
      mechanic: "ways",
      betMultiplier: 20,
      waysOrLines: 1024,
      detectedAt: new Date().toISOString(),
      detectionMethod: "balance_derived",
    },
  });
  const parser = await createParserForGame(slug);
  const req = ppRequestBody({ action: "doSpin", c: 0.45, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppResponseBody({ bb: 100, ba: 91, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s" });
  const r = parser.parseSpinPair!(req, res, URL);
  expect(r.bet).toBe(9); // 0.45 × 20 (NOT 0.45 × 1024 = 460.8)
});

test("auto-applies betMultiplier (lines game with M=20 == l)", async () => {
  const slug = await setupGame("lines", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "game-mechanics.json": {
      mechanic: "lines",
      betMultiplier: 20,
      waysOrLines: 20,
      detectedAt: new Date().toISOString(),
      detectionMethod: "balance_derived",
    },
  });
  const parser = await createParserForGame(slug);
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppResponseBody({ bb: 100, ba: 90, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s" });
  const r = parser.parseSpinPair!(req, res, URL);
  expect(r.bet).toBe(10); // 0.5 × 20
});

test("falls back to naive formula when game-mechanics.json absent", async () => {
  const slug = await setupGame("no-mechanics", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    // No game-mechanics.json
  });
  const parser = await createParserForGame(slug);
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppResponseBody({ bb: 100, ba: 90, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s" });
  const r = parser.parseSpinPair!(req, res, URL);
  expect(r.bet).toBe(10); // c × l = 0.5 × 20 (naive, no multiplier override)
});

test("skipBetMultiplier=true ignores game-mechanics.json", async () => {
  const slug = await setupGame("skip", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "game-mechanics.json": {
      mechanic: "ways",
      betMultiplier: 20,
      waysOrLines: 1024,
      detectedAt: new Date().toISOString(),
      detectionMethod: "balance_derived",
    },
  });
  const parser = await createParserForGame(slug, { skipBetMultiplier: true });
  const req = ppRequestBody({ action: "doSpin", c: 0.45, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppResponseBody({ bb: 100, ba: 91, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s" });
  const r = parser.parseSpinPair!(req, res, URL);
  expect(r.bet).toBe(460.8); // naive c × l, multiplier NOT applied
});

test("ignores betMultiplier <= 0 (treated as missing)", async () => {
  const slug = await setupGame("bad-mechanics", {
    "parser.json": { parser: "PragmaticParser", version: 1 },
    "game-mechanics.json": {
      mechanic: "unknown",
      betMultiplier: 0, // invalid
      waysOrLines: 20,
      detectedAt: new Date().toISOString(),
      detectionMethod: "balance_derived",
    },
  });
  const parser = await createParserForGame(slug);
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppResponseBody({ bb: 100, ba: 90, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s" });
  const r = parser.parseSpinPair!(req, res, URL);
  expect(r.bet).toBe(10); // falls back to naive c × l
});
