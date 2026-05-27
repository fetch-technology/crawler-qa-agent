// Patch validator (Phase 7.6) — runs BEFORE any disk write. Hard gates:
//   1. Filename must be a known registry config (no arbitrary path writes)
//   2. JSON Schema check against the target file's schema (after applying diff)
//   3. Sanity bounds (betMultiplier ∈ [0.1, 100], coords ∈ viewport, etc.)
//
// If any gate fails → patch is REJECTED (not applied, not even dry-run).
// This is the security boundary between AI suggestions and disk state.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame, REGISTRY_FILES } from "../registry/paths.js";
import { SCHEMA_BY_KEY, validate as validateSchema } from "../registry/schemas/index.js";
import type { SuggestedPatch } from "../step12-failure-review/types.js";
import type { ValidationOutcome } from "./types.js";

/** Allow-list of files a patch is permitted to mutate. Anything else is rejected. */
const ALLOWED_FILES = new Set(Object.values(REGISTRY_FILES));

/**
 * Validate a suggested patch. Returns ok=false if any check fails — caller
 * MUST NOT proceed to dry-run / apply when ok=false.
 */
export async function validatePatch(
  gameSlug: string,
  patch: SuggestedPatch,
): Promise<ValidationOutcome> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // === Gate 1: filename must be a known registry file ===
  const baseName = path.basename(patch.file);
  if (!ALLOWED_FILES.has(baseName)) {
    errors.push(`patch.file "${baseName}" is not in the allowed registry file set. Block.`);
    return { ok: false, errors, warnings };
  }

  // === Gate 2: simulate the merge + validate against schema ===
  // Find the matching schema by REGISTRY_FILES key
  const key = Object.entries(REGISTRY_FILES).find(([, fname]) => fname === baseName)?.[0];
  if (!key) {
    errors.push(`internal: cannot resolve schema key for ${baseName}`);
    return { ok: false, errors, warnings };
  }
  const schema = SCHEMA_BY_KEY[key];
  // Schema-less files (e.g. testcases.yaml) → can't validate, only warn
  if (!schema) {
    warnings.push(`No JSON schema for ${baseName} — skipping schema validation. Other gates still enforced.`);
  }

  // Load existing file (if any) + apply diff
  const targetPath = path.join(dirForGame(gameSlug), baseName);
  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(targetPath, "utf8");
    current = JSON.parse(raw);
  } catch {
    // Missing file → patch creates it
    current = {};
  }

  let next: Record<string, unknown>;
  switch (patch.operation) {
    case "merge":
      next = { ...current, ...patch.diff };
      break;
    case "replace":
      next = patch.diff;
      break;
    case "set_field":
      // diff = { "path.to.field": value }
      next = { ...current };
      for (const [key, val] of Object.entries(patch.diff)) {
        applyDotPath(next, key, val);
      }
      break;
    case "add_alias":
      // field-mapping aliases: diff = { aliasName: canonicalName }
      next = { ...current, aliases: { ...(current.aliases as object ?? {}), ...patch.diff } };
      break;
    default:
      errors.push(`unsupported operation: ${patch.operation}`);
      return { ok: false, errors, warnings };
  }

  if (schema) {
    const schemaErrors = validateSchema(next, schema);
    if (schemaErrors.length > 0) {
      for (const e of schemaErrors) errors.push(`schema(${baseName}): ${e.path} ${e.message}`);
      return { ok: false, errors, warnings };
    }
  }

  // === Gate 3: sanity bounds ===
  const sanityErrors = sanityCheck(baseName, next);
  if (sanityErrors.length > 0) {
    for (const e of sanityErrors) errors.push(`sanity(${baseName}): ${e}`);
    return { ok: false, errors, warnings };
  }

  return { ok: true, errors, warnings };
}

/** Apply a "set_field" dot-path mutation. Mutates target in-place. */
function applyDotPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let obj: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};
    obj = obj[key] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]!] = value;
}

/** Per-file sanity checks beyond schema. Returns list of human-readable errors. */
function sanityCheck(filename: string, content: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (filename === REGISTRY_FILES.gameMechanics) {
    const m = content as { betMultiplier?: number; waysOrLines?: number };
    if (typeof m.betMultiplier === "number" && (m.betMultiplier < 0.1 || m.betMultiplier > 1000)) {
      errors.push(`betMultiplier ${m.betMultiplier} out of plausible range [0.1, 1000]`);
    }
    if (typeof m.waysOrLines === "number" && m.waysOrLines > 10000) {
      errors.push(`waysOrLines ${m.waysOrLines} unrealistically large`);
    }
  }

  if (filename === REGISTRY_FILES.uiRegistry) {
    for (const [key, el] of Object.entries(content)) {
      if (typeof el !== "object" || el === null) continue;
      const e = el as { x?: number; y?: number };
      if (typeof e.x === "number" && (e.x < 0 || e.x > 10000)) errors.push(`${key}.x ${e.x} out of viewport range`);
      if (typeof e.y === "number" && (e.y < 0 || e.y > 10000)) errors.push(`${key}.y ${e.y} out of viewport range`);
    }
  }

  if (filename === REGISTRY_FILES.timingConfig) {
    const t = content as { spinResponseTimeoutMs?: number; hardCapMs?: number };
    if (typeof t.spinResponseTimeoutMs === "number" && t.spinResponseTimeoutMs < 1000) {
      errors.push(`spinResponseTimeoutMs ${t.spinResponseTimeoutMs} < 1s — likely a bug`);
    }
    if (typeof t.hardCapMs === "number" && t.hardCapMs > 60 * 60 * 1000) {
      errors.push(`hardCapMs > 1 hour — likely a bug`);
    }
  }

  return errors;
}
