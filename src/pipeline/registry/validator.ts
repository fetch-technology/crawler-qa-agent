// Registry validator — runs JSON Schema check on each registry store file.
// Phase 7.2. Hooked into io.ts load path (warns on schema mismatch) and
// exposed via CLI `npm run validate:registry -- --game <slug>`.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dirForGame, REGISTRY_FILES } from "./paths.js";
import { SCHEMA_BY_KEY, validate, type ValidationError } from "./schemas/index.js";

export type FileValidationResult = {
  key: string;
  file: string;
  exists: boolean;
  ok: boolean;
  errors: ValidationError[];
};

export type RegistryValidationReport = {
  slug: string;
  total: number;
  ok: number;
  failed: number;
  files: FileValidationResult[];
};

/**
 * Validate every registry file for a game against its schema. Files without
 * a schema (e.g., test-cases.yaml) are skipped. Missing files (= store not
 * yet populated) are reported as `exists: false, ok: true` (not an error).
 */
export async function validateRegistry(gameSlug: string): Promise<RegistryValidationReport> {
  const dir = dirForGame(gameSlug);
  const results: FileValidationResult[] = [];

  for (const [key, fname] of Object.entries(REGISTRY_FILES)) {
    const schema = SCHEMA_BY_KEY[key];
    if (!schema) continue; // No schema → skip (e.g. testcases.yaml, ui-graph)
    const file = path.join(dir, fname);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      results.push({ key, file: fname, exists: false, ok: true, errors: [] });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      results.push({
        key,
        file: fname,
        exists: true,
        ok: false,
        errors: [{ path: "$", message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` }],
      });
      continue;
    }
    const errors = validate(parsed, schema);
    results.push({ key, file: fname, exists: true, ok: errors.length === 0, errors });
  }

  const ok = results.filter((r) => r.ok).length;
  return {
    slug: gameSlug,
    total: results.length,
    ok,
    failed: results.length - ok,
    files: results,
  };
}

/**
 * Validate every game in fixtures/registry/. Returns array of per-game reports.
 * Useful for CI smoke + post-migration audit.
 */
export async function validateAllRegistries(): Promise<RegistryValidationReport[]> {
  const root = path.resolve(process.cwd(), "fixtures", "registry");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const reports: RegistryValidationReport[] = [];
  for (const slug of entries) {
    // Skip test fixtures (provider configs handled separately by validateProviders)
    if (slug.startsWith("__test-")) continue;
    if (slug === "_providers") {
      reports.push(await validateProviders());
      continue;
    }
    if (slug.startsWith("_")) continue;
    reports.push(await validateRegistry(slug));
  }
  return reports;
}

/** Validate ALL provider spec files in _providers/. */
export async function validateProviders(): Promise<RegistryValidationReport> {
  const { PROVIDER_SPEC_SCHEMA } = await import("./schemas/index.js");
  const dir = path.resolve(process.cwd(), "fixtures", "registry", "_providers");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { slug: "_providers", total: 0, ok: 0, failed: 0, files: [] };
  }
  const results: FileValidationResult[] = [];
  for (const fname of files) {
    const file = path.join(dir, fname);
    let raw: string;
    let parsed: unknown;
    try {
      raw = await readFile(file, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      results.push({ key: "providerSpec", file: fname, exists: true, ok: false, errors: [{ path: "$", message: `parse error: ${err instanceof Error ? err.message : String(err)}` }] });
      continue;
    }
    const errors = validate(parsed, PROVIDER_SPEC_SCHEMA);
    results.push({ key: "providerSpec", file: fname, exists: true, ok: errors.length === 0, errors });
  }
  const ok = results.filter((r) => r.ok).length;
  return { slug: "_providers", total: results.length, ok, failed: results.length - ok, files: results };
}

/**
 * Format a report as human-readable text. Compact summary + per-file errors.
 */
export function formatReport(report: RegistryValidationReport): string {
  const lines: string[] = [];
  lines.push(`[validate] ${report.slug}: ${report.ok}/${report.total} files OK${report.failed > 0 ? ` (${report.failed} FAIL)` : ""}`);
  for (const file of report.files) {
    if (file.ok) continue;
    if (!file.exists) continue; // Missing files aren't errors
    lines.push(`  ✗ ${file.file}`);
    for (const err of file.errors) {
      lines.push(`      ${err.path}: ${err.message}`);
    }
  }
  return lines.join("\n");
}
