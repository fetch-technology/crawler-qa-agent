// Knowledge Compiler — reads raw registry configs, applies defaults +
// resolutions, runs cross-validation, returns single immutable bundle.
//
// Phase 7.3. Engine refactor TBD (initially CompiledKnowledge is informational
// — old code paths still work). Once engine code switches to consuming
// CompiledKnowledge directly, raw config loads in case-executor / parser /
// etc. become unnecessary.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame, REGISTRY_FILES } from "../registry/paths.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { providerCache } from "../registry/provider-cache.js";
import { apiMapping } from "../registry/api-mapping.js";
import { fieldMapping } from "../registry/field-mapping.js";
import { parserCache } from "../registry/parser-cache.js";
import { gameMechanics } from "../registry/game-mechanics.js";
import { resolveTimingConfig } from "../registry/timing-config.js";
import { resolveBetControls } from "../registry/bet-controls.js";
import { resolvePopupKeywords } from "../registry/popup-keywords.js";
import { resolveSubStateHints } from "../registry/sub-state-hints.js";
import type { CompiledKnowledge } from "./types.js";
import { COMPILE_SOURCE_KEYS } from "./types.js";

/** Read + hash a source file. Returns null hash if file missing. */
async function hashFile(slug: string, key: keyof typeof REGISTRY_FILES): Promise<string | null> {
  const file = path.join(dirForGame(slug), REGISTRY_FILES[key]);
  try {
    const raw = await readFile(file, "utf8");
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Compile knowledge for a game. Returns a fully-populated CompiledKnowledge
 * with defaults applied. Cross-validation runs at the end; consult
 * `result.errors` before consuming.
 */
export async function compileKnowledge(gameSlug: string): Promise<CompiledKnowledge> {
  // Hashes for cache invalidation
  const sourceHashes: Record<string, string> = {};
  for (const key of COMPILE_SOURCE_KEYS) {
    const h = await hashFile(gameSlug, key);
    if (h !== null) sourceHashes[key] = h;
  }

  // Load all raw configs in parallel
  const [
    ui, provider, api, fields, parser, mechanics,
    timing, betControls, popupKeywords, subStateHints,
  ] = await Promise.all([
    uiRegistry.load(gameSlug),
    providerCache.load(gameSlug),
    apiMapping.load(gameSlug),
    fieldMapping.load(gameSlug),
    parserCache.load(gameSlug),
    gameMechanics.load(gameSlug),
    resolveTimingConfig(gameSlug),
    resolveBetControls(gameSlug),
    resolvePopupKeywords(gameSlug),
    resolveSubStateHints(gameSlug),
  ]);

  // === Derived fields ===
  const derived = computeDerived(mechanics);

  // === Cross-validate ===
  const { warnings, errors } = crossValidate({ ui, api, parser, mechanics, fields });

  return {
    schemaVersion: 1,
    sourceHashes,
    compiledAt: new Date().toISOString(),
    gameSlug,
    ui: ui ?? {},
    provider,
    api,
    fields,
    parser,
    mechanics,
    timing,
    betControls,
    popupKeywords: {
      interstitial: popupKeywords.interstitial,
      substate: popupKeywords.substate,
    },
    subStateHints,
    derived,
    warnings,
    errors,
  };
}

function computeDerived(mechanics: import("../registry/types.js").GameMechanics | null) {
  if (!mechanics || mechanics.betMultiplier <= 0) {
    return { betLadder: [], betFormulaDescription: "c × l (naive)" };
  }
  const M = mechanics.betMultiplier;
  return {
    betLadder: [],
    betFormulaDescription: `c × ${M} (mechanic=${mechanics.mechanic})`,
  };
}

/** Cross-config consistency checks. Returns warnings (soft) + errors (hard). */
function crossValidate(args: {
  ui: import("../registry/types.js").UiRegistry | null;
  api: import("../registry/types.js").ApiMapping | null;
  parser: import("../registry/types.js").ParserCache | null;
  mechanics: import("../registry/types.js").GameMechanics | null;
  fields: import("../registry/types.js").FieldMapping | null;
}): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!args.parser) {
    warnings.push("parser.json missing — engine will use GenericParser fallback");
  }
  if (!args.api?.spinApi?.url) {
    warnings.push("api-mapping.spinApi.url missing — spin response detection unreliable");
  }
  if (!args.ui || Object.keys(args.ui).length === 0) {
    warnings.push("ui-registry empty — case execution requires at least spinButton");
  } else if (!args.ui.spinButton) {
    errors.push("ui-registry has entries but no spinButton — all spin actions will throw");
  }
  if (args.mechanics && args.mechanics.mechanic === "unknown") {
    warnings.push(`game-mechanics.mechanic = "unknown" — bet formula may be wrong for ways/cluster games`);
  }
  if (args.mechanics && args.mechanics.betMultiplier === 0) {
    warnings.push("game-mechanics.betMultiplier = 0 — parser will fall back to naive c × l");
  }

  return { warnings, errors };
}

/**
 * Determine if a previously-compiled knowledge is still valid by comparing
 * source hashes. Returns true if EVERY source file's current hash matches
 * the cached hash (or both are absent).
 */
export async function isCompiledKnowledgeFresh(
  gameSlug: string,
  cached: CompiledKnowledge,
): Promise<boolean> {
  for (const key of COMPILE_SOURCE_KEYS) {
    // Normalize missing files: cached map only stores hashes for files that
    // existed at compile time, so undefined ≡ null ≡ "file was absent".
    const cachedHash = cached.sourceHashes[key] ?? null;
    const currentHash = await hashFile(gameSlug, key);
    if (cachedHash !== currentHash) return false;
  }
  return true;
}
