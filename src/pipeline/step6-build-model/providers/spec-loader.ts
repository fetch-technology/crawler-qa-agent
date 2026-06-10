// Provider spec loader (Phase 9). Reads JSON from
// fixtures/registry/_providers/<name>.json + validates against schema.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "../../registry/paths.js";
import { validate as validateSchema, PROVIDER_SPEC_SCHEMA } from "../../registry/schemas/index.js";
import type { ProviderSpec, ParserOverlay } from "./spec-types.js";

const PROVIDER_DIR = "_providers";
const OVERLAY_FILE = "parser-overlay.json";

/** Load + validate a provider spec. Throws if invalid. */
export async function loadProviderSpec(providerName: string): Promise<ProviderSpec> {
  const file = path.join(dirForGame(PROVIDER_DIR), `${providerName.toLowerCase()}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`loadProviderSpec("${providerName}"): cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadProviderSpec("${providerName}"): invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = validateSchema(parsed, PROVIDER_SPEC_SCHEMA);
  if (errors.length > 0) {
    throw new Error(`loadProviderSpec("${providerName}"): schema validation failed:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
  }
  return parsed as ProviderSpec;
}

/** Best-effort load — returns null instead of throwing. Used as fallback path. */
export async function tryLoadProviderSpec(providerName: string): Promise<ProviderSpec | null> {
  try {
    return await loadProviderSpec(providerName);
  } catch {
    return null;
  }
}

/** Best-effort load of a game's per-game parser overlay
 *  (`fixtures/registry/<slug>/parser-overlay.json`). Returns null when absent
 *  or unreadable — the common case (no overlay learned yet) → parser uses the
 *  provider base spec unchanged. Never throws. */
export async function loadOverlay(gameSlug: string): Promise<ParserOverlay | null> {
  const file = path.join(dirForGame(gameSlug), OVERLAY_FILE);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ParserOverlay;
  } catch {
    return null;
  }
}
