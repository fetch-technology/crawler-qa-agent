// INVARIANT — JSON Schema validator
//
// The minimal validator (src/pipeline/registry/schemas/index.ts) is the gate
// that ensures all config files conform to known shapes. If it has a bug,
// invalid data flows into the engine silently → mysterious failures.
//
// Tests cover the validator itself + each registered schema.

import { test, expect } from "@playwright/test";
import {
  validate,
  GAME_MECHANICS_SCHEMA,
  TIMING_CONFIG_SCHEMA,
  POPUP_KEYWORDS_SCHEMA,
  PARSER_CACHE_SCHEMA,
  UI_REGISTRY_SCHEMA,
  type Schema,
} from "../../src/pipeline/registry/schemas/index.js";

// === Validator primitives ===

test("string type rejects number", () => {
  const errs = validate(42, { type: "string" });
  expect(errs.length).toBe(1);
  expect(errs[0]!.message).toMatch(/expected string/);
});

test("number type rejects NaN", () => {
  const errs = validate(NaN, { type: "number" });
  expect(errs.length).toBeGreaterThan(0);
});

test("number with min/max", () => {
  expect(validate(5, { type: "number", min: 0, max: 10 } as Schema).length).toBe(0);
  expect(validate(-1, { type: "number", min: 0, max: 10 } as Schema).length).toBe(1);
  expect(validate(20, { type: "number", min: 0, max: 10 } as Schema).length).toBe(1);
});

test("enum constraint", () => {
  const sch: Schema = { type: "string", enum: ["a", "b", "c"] };
  expect(validate("a", sch).length).toBe(0);
  expect(validate("z", sch).length).toBe(1);
});

test("nullable allows null", () => {
  expect(validate(null, { type: "string", nullable: true } as Schema).length).toBe(0);
  expect(validate(null, { type: "string" } as Schema).length).toBe(1);
});

test("array items validated", () => {
  const sch: Schema = { type: "array", items: { type: "number" } };
  expect(validate([1, 2, 3], sch).length).toBe(0);
  expect(validate([1, "bad", 3], sch).length).toBe(1);
});

test("object required fields", () => {
  const sch: Schema = { type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "number" } } };
  expect(validate({ a: "x", b: 1 }, sch).length).toBe(0);
  expect(validate({ a: "x" }, sch).length).toBe(1);
});

test("object additionalProperties=false rejects extras", () => {
  const sch: Schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  expect(validate({ a: "x" }, sch).length).toBe(0);
  expect(validate({ a: "x", b: "extra" }, sch).length).toBe(1);
});

test("nested object validation", () => {
  const sch: Schema = {
    type: "object", required: ["outer"],
    properties: { outer: { type: "object", required: ["inner"], properties: { inner: { type: "number" } } } },
  };
  expect(validate({ outer: { inner: 1 } }, sch).length).toBe(0);
  expect(validate({ outer: { inner: "bad" } }, sch).length).toBe(1);
  expect(validate({ outer: {} }, sch).length).toBe(1);
});

// === Real registry schemas ===

test("GAME_MECHANICS_SCHEMA accepts valid ways game", () => {
  const data = {
    mechanic: "ways",
    betMultiplier: 20,
    waysOrLines: 1024,
    detectedAt: "2026-05-21T00:00:00Z",
    detectionMethod: "balance_derived",
  };
  expect(validate(data, GAME_MECHANICS_SCHEMA).length).toBe(0);
});

test("GAME_MECHANICS_SCHEMA rejects unknown mechanic enum", () => {
  const data = {
    mechanic: "fortunewheel", // not in enum
    betMultiplier: 20,
    waysOrLines: 1024,
    detectedAt: "2026-05-21T00:00:00Z",
    detectionMethod: "balance_derived",
  };
  const errs = validate(data, GAME_MECHANICS_SCHEMA);
  expect(errs.length).toBeGreaterThan(0);
  expect(errs[0]!.message).toMatch(/enum/);
});

test("TIMING_CONFIG_SCHEMA accepts partial overrides", () => {
  expect(validate({}, TIMING_CONFIG_SCHEMA).length).toBe(0);
  expect(validate({ spinResponseTimeoutMs: 5000 }, TIMING_CONFIG_SCHEMA).length).toBe(0);
});

test("TIMING_CONFIG_SCHEMA rejects negative timeout", () => {
  const errs = validate({ spinResponseTimeoutMs: -1 }, TIMING_CONFIG_SCHEMA);
  expect(errs.length).toBe(1);
});

test("POPUP_KEYWORDS_SCHEMA accepts empty arrays", () => {
  expect(validate({}, POPUP_KEYWORDS_SCHEMA).length).toBe(0);
  expect(validate({ interstitial: [], substate: [] }, POPUP_KEYWORDS_SCHEMA).length).toBe(0);
  expect(validate({ interstitial: ["custom kw"] }, POPUP_KEYWORDS_SCHEMA).length).toBe(0);
});

test("POPUP_KEYWORDS_SCHEMA rejects non-string in interstitial", () => {
  const errs = validate({ interstitial: ["ok", 42] }, POPUP_KEYWORDS_SCHEMA);
  expect(errs.length).toBe(1);
});

test("PARSER_CACHE_SCHEMA accepts known parser kinds", () => {
  expect(validate({ parser: "PragmaticParser", version: 1 }, PARSER_CACHE_SCHEMA).length).toBe(0);
  expect(validate({ parser: "GenericParser", version: 1 }, PARSER_CACHE_SCHEMA).length).toBe(0);
});

test("PARSER_CACHE_SCHEMA rejects unknown parser kind", () => {
  const errs = validate({ parser: "WeirdParser", version: 1 }, PARSER_CACHE_SCHEMA);
  expect(errs.length).toBeGreaterThan(0);
});

test("UI_REGISTRY_SCHEMA accepts map of UI elements", () => {
  const data = {
    spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1.0, detectedAt: "2026-05-21T00:00:00Z" },
    betPlus: { x: 50, y: 60, strategy: "ai_vision", confidence: 0.9, detectedAt: "2026-05-21T00:00:00Z" },
  };
  expect(validate(data, UI_REGISTRY_SCHEMA).length).toBe(0);
});

test("UI_REGISTRY_SCHEMA rejects confidence > 1", () => {
  const data = {
    spinButton: { x: 100, y: 200, strategy: "manual", confidence: 1.5, detectedAt: "2026-05-21T00:00:00Z" },
  };
  const errs = validate(data, UI_REGISTRY_SCHEMA);
  expect(errs.length).toBeGreaterThan(0);
});
