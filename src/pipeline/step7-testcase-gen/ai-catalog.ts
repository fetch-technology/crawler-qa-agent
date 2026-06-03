// AI: called only during cold-start to generate RICH per-game test catalog
// (20-40 cases with executable invariants). Reuses legacy `generateTestCaseCatalog`
// which uses 2-pass PLAN → EXPAND prompting + Best Practices grounding.
//
// Input: new-pipeline registry artifacts (provider, features, ui-registry, network captures)
// Output: TestCaseCatalog with custom_assertions evaluated later by step9 custom-assertion-rule.

import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  generateTestCaseCatalog,
  type TestCaseCatalog,
} from "../../ai/test-catalog.js";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import { dirForGame } from "../registry/paths.js";
import { formatRegistryHierarchy, registryStats } from "../registry/hierarchy.js";
import type { ProviderCache, UiRegistry } from "../registry/types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { buildGameSpec } from "./build-game-spec.js";
import { loadAuxiliarySources } from "./auxiliary-sources.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { ocrRegions as ocrRegionsStore } from "../registry/ocr-regions.js";

export type AiCatalogInput = {
  gameSlug: string;
  provider: ProviderCache | null;
  uiMap: UiRegistry | null;
  features: FeatureRegistry | null;
  rounds: NetworkRound[];
  parser: BaseParser;
  spinApiUrl: string | null;
  /** Optional deep-extract output from cold-start step 4c. Concrete paytable
   *  multipliers, RTP, buy-option costs, etc., extracted from in-game info
   *  popups via Vision. Strongly improves catalog quality when available. */
  auxiliarySources?: {
    paytableMd: string | null;
    infoMd: string | null;
    buyOptionsMd: string | null;
    specialBetsMd: string | null;
    paytableJson: unknown | null;
    rulesJson: unknown | null;
  } | null;
};

export type AiCatalogOutput = {
  catalog: TestCaseCatalog | null;
  catalogJsonPath: string | null;
  reason?: string;
};

const CATALOG_FILE = "test-cases.json";

/**
 * Load the AI-generated catalog previously written by `generateAiCatalog`.
 * Returns null when missing/unreadable so callers can fall through gracefully.
 * Used by warm-start to wire CustomAssertionRule from a registry cached at
 * cold-start time.
 */
export async function loadAiCatalog(slug: string): Promise<TestCaseCatalog | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { dirForGame } = await import("../registry/paths.js");
  const file = path.join(dirForGame(slug), CATALOG_FILE);
  try {
    const raw = await readFile(file, "utf8");
    const catalog = JSON.parse(raw) as TestCaseCatalog;
    // Inject deterministic built-in cases (e.g. payout-integrity) at LOAD time
    // so they survive catalog regeneration and need no AI translation.
    const { appendBuiltinCases } = await import("./builtin-cases.js");
    return await appendBuiltinCases(catalog, slug);
  } catch {
    return null;
  }
}

export async function generateAiCatalog(input: AiCatalogInput): Promise<AiCatalogOutput> {
  // Parse all captured spin responses into NormalizedSpinResult[] so we can derive
  // bet_mechanics + sample_spin_response_shape.
  const parsedSpins: NormalizedSpinResult[] = [];
  const rawSamples: unknown[] = [];
  for (const round of input.rounds) {
    for (const res of round.responses) {
      if (!res.body) continue;
      if (!input.parser.canParseResponse(res.body, res.url)) continue;
      try {
        parsedSpins.push(input.parser.parseResponse(res.body));
        // Also keep raw payload for catalog generator
        try {
          rawSamples.push(JSON.parse(res.body));
        } catch {
          rawSamples.push(res.body);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Degraded mode: even with 0 parsed spins we can produce a baseline catalog
  // from provider + detected features alone. Cases will lack bet-specific
  // numbers but still cover universal categories (smoke, performance, meta).
  if (parsedSpins.length === 0) {
    console.log(
      "[step7/ai-catalog] degraded mode — no parseable spin samples; generating from provider + features only",
    );
  }

  // C1: load paytable from registry (deep-extract may have populated it).
  // Hydrates GameSpec.symbols[] from concrete OCR'd data instead of leaving
  // it empty with a "not extracted" caveat.
  const paytableData = await paytableStore.load(input.gameSlug).catch(() => null);
  // QA spec override (game-spec-override.json) — pinned bet ladder /
  // min / max / default. Applied inside buildGameSpec → catalog AI sees
  // QA-corrected values. When file missing, no-op (auto-derived used).
  const { gameSpecOverride } = await import("../registry/game-spec-override.js");
  const ov = await gameSpecOverride.load(input.gameSlug).catch(() => null);
  const betOverride = ov ? {
    baseBet: ov.defaultBet,
    betLadder: ov.betLadder,
    betMin: ov.betMin,
    betMax: ov.betMax,
  } : undefined;
  const gameSpec = buildGameSpec({
    gameSlug: input.gameSlug,
    provider: input.provider,
    uiMap: input.uiMap,
    features: input.features,
    parsedSpins,
    spinApiUrl: input.spinApiUrl,
    paytable: paytableData,
    betOverride,
  });

  // Build minimal rules markdown from provider + features.
  const rulesMarkdown = buildRulesMarkdown(input, parsedSpins);

  // Auto-load auxiliary sources (options.json, paytable.md, config response)
  // from registry → legacy fixtures → synthesized fallback.
  const observedBets = Array.from(new Set(parsedSpins.map((s) => s.bet).filter((b) => b > 0)));
  const aux = loadAuxiliarySources({
    gameSlug: input.gameSlug,
    provider: input.provider,
    uiMap: input.uiMap,
    features: input.features,
    observedBets,
  });
  console.log(`[step7/ai-catalog] auxiliary sources: ${aux.source}`);

  // Prefer deep-extracted paytable over auto-loaded fallback when both exist.
  const paytableMarkdown = input.auxiliarySources?.paytableMd ?? aux.paytableMarkdown;

  // Load OCR coverage so EXPAND prompt knows which screen.X fields will
  // actually receive data at runtime. AI uses this to skip null-no-op
  // assertions for unconfigured regions.
  const ocrRegionsData = await ocrRegionsStore.load(input.gameSlug).catch(() => null);
  const ocrCoverage = {
    balanceArea: Boolean(ocrRegionsData?.balanceArea),
    betArea: Boolean(ocrRegionsData?.betArea),
    winArea: Boolean(ocrRegionsData?.winArea),
    freeSpinCounter: Boolean(ocrRegionsData?.freeSpinCounter),
  };
  const ocrSummary = Object.entries(ocrCoverage).filter(([, v]) => v).map(([k]) => k).join(",");
  console.log(`[step7/ai-catalog] OCR coverage: [${ocrSummary || "none"}]`);

  let catalog: TestCaseCatalog;
  try {
    catalog = await generateTestCaseCatalog({
      gameSpec,
      rulesMarkdown,
      optionsJson: aux.optionsJson,
      sampleSpinResponses: rawSamples.slice(0, 8),
      configResponse: aux.configResponse,
      paytableMarkdown,
      auxiliarySources: input.auxiliarySources ?? null,
      ocrCoverage,
    });
  } catch (err) {
    return {
      catalog: null,
      catalogJsonPath: null,
      reason: `AI catalog generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const dir = dirForGame(input.gameSlug);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, CATALOG_FILE);
  await writeFile(filePath, JSON.stringify(catalog, null, 2) + "\n", "utf8");

  // Auto-clear STALE run results for the (re)defined cases. Re-generating a
  // catalog redefines each case's assertions, so a prior pass/fail for the
  // same caseId is meaningless. Delete the persisted result + run-history so
  // the dashboard shows "not run yet" instead of stale verdicts.
  await clearStaleCaseResults(dir, catalog.cases.map((c) => c.id));

  return { catalog, catalogJsonPath: filePath };
}

/** Delete stale artifacts after a catalog (re)gen: per-case result.json +
 *  case-history, AND the translated-actions cache (test-cases.actions.json).
 *  Re-gen redefines every case's setup + assertions, so cached actions/results
 *  are stale; clearing forces fresh translation + a clean "not run yet" state. */
async function clearStaleCaseResults(gameDir: string, caseIds: string[]): Promise<void> {
  let cleared = 0;
  for (const id of caseIds) {
    const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const targets = [
      path.join(gameDir, "case-evidence", `${safe}.result.json`),
      path.join(gameDir, "case-history", `${safe}.jsonl`),
    ];
    for (const t of targets) {
      try {
        await rm(t); // no force → throws ENOENT when absent, so we only count real deletes
        cleared++;
      } catch {
        // ignore — file didn't exist
      }
    }
  }
  // Wipe the whole translated-actions cache — every case was redefined, so any
  // cached action list is for an old setup. Fresh translation runs next.
  try {
    await rm(path.join(gameDir, "test-cases.actions.json"));
    cleared++;
  } catch {
    // ignore — no cache yet (first generation)
  }
  if (cleared > 0) {
    console.log(`[step7/ai-catalog] cleared ${cleared} stale artifact(s) (results/history/actions-cache) for ${caseIds.length} regenerated case(s)`);
  }
}

function buildRulesMarkdown(input: AiCatalogInput, spins: NormalizedSpinResult[]): string {
  const lines: string[] = [];
  lines.push(`# ${input.provider?.gameName ?? input.gameSlug} — observed rules summary`);
  lines.push("");
  lines.push(`Provider: ${input.provider?.provider ?? "Unknown"}`);
  lines.push(`Platform: ${input.provider?.platform ?? "Unknown"}`);
  lines.push("");
  lines.push("## UI Registry — Verified Element Hierarchy");
  if (input.uiMap) {
    const stats = registryStats(input.uiMap);
    lines.push(
      `Total: ${stats.total} | Verified: ${stats.verified} | Pending: ${stats.pending} | Rejected: ${stats.rejected} | Human-verified: ${stats.humanVerified}`,
    );
    lines.push("");
    lines.push("Tree of clickable elements (only verified/pending; rejected excluded). Keys with `__` are nested sub-state elements — to interact you must walk the ancestor path. Entries marked `[human-verified]` have human-confirmed coordinates and are HIGHLY trusted.");
    lines.push("");
    lines.push("```");
    lines.push(formatRegistryHierarchy(input.uiMap, { includeRejected: false }));
    lines.push("```");
  } else {
    lines.push("- (no UI map)");
  }
  lines.push("");
  lines.push("## Detected features");
  if (input.features) {
    for (const [name, info] of Object.entries(input.features.features)) {
      if (info?.present) {
        lines.push(
          `- **${name}** (confidence ${info.confidence.toFixed(2)}, sources: ${info.sources.join("+")})`,
        );
      }
    }
  }
  lines.push("");
  lines.push("## Observed bet mechanics");
  const bets = Array.from(new Set(spins.map((s) => s.bet).filter((b) => b > 0))).sort(
    (a, b) => a - b,
  );
  lines.push(`- Bets observed (USD): ${bets.length > 0 ? bets.join(", ") : "(none)"}`);
  lines.push(`- Balance range: ${spins.map((s) => s.balanceAfter).join(", ").slice(0, 200)}`);
  lines.push("");
  lines.push("## Cascade behaviour");
  const cascadeCount = spins.filter((s) => s.cascadeFrames.length > 0).length;
  lines.push(`- ${cascadeCount}/${spins.length} spins have cascade frames recorded`);
  return lines.join("\n");
}
