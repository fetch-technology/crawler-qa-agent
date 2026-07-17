// Phase: generate-catalog — pure I/O, no browser. Loads everything the AI
// catalog generator needs from disk, calls generateAiCatalog, persists the
// output. Replaces the historical pattern of cold-start subprocess +
// browser re-launch just to regenerate test-cases.json.
//
// Dashboard's "Generate Cases" button calls this in-process via the new
// /api/qa/manual/generate-catalog endpoint — bypasses HTTP proxy timeout +
// browser overhead entirely. Cold-start CLI also calls this for its step 7
// (future Session 2 — currently still has its own inline call).
//
// Required disk inputs (caller's job to populate via Auto-Onboard or
// cold-start phases 1-6):
//   - ui-registry.json
//   - provider-cache.json
//   - feature-registry.json
//   - api-mapping.json (for spinApiUrl)
//   - parser.json (created lazily by createParserForGame's provider fallback)
//   - network/network.jsonl (canonical NetworkRound) AND/OR
//     case-evidence/*.network.jsonl (per-case format — both supported)
//   - auxiliary-sources/*.md+.json (from prior deep-extract — optional but
//     strongly recommended for catalog quality)
//
// Missing inputs degrade gracefully:
//   - No rounds → degraded mode (catalog still generates from provider + UI)
//   - No aux sources → catalog falls back to synthesized rules
//   - No provider → throws (provider detect MUST have run)

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { generateAiCatalog, loadRawCatalog, saveCatalog } from "../step7-testcase-gen/ai-catalog.js";
import { applyTemplateSet } from "../step7-testcase-gen/case-templates.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { providerCache } from "../registry/provider-cache.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { apiMapping } from "../registry/api-mapping.js";
import { gameSpecOverride } from "../registry/game-spec-override.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import { dirForGame } from "../registry/paths.js";
import type { NetworkRound, CapturedRequest, CapturedResponse } from "../step3-capture-network/types.js";
import type { UiRegistry, ProviderCache } from "../registry/types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { PhaseResult } from "./types.js";

export type PhaseGenerateCatalogResult = PhaseResult & {
  totalCases?: number;
  catalogPath?: string;
  /** How many NetworkRound were available to the generator. Zero = degraded. */
  roundsLoaded?: number;
  /** Whether auxiliary-sources/* was present. False = synthesized fallback. */
  hadAuxSources?: boolean;
  /** Number of feature-gated standard templates eligible for this game. */
  standardTemplatesApplied?: number;
  /** Number of standard templates skipped by feature gates. */
  standardTemplatesSkipped?: number;
  /** Assertions stripped from the generated catalog (Generate Cases emits
   *  cases with an empty custom_assertions list — see the strip step below). */
  assertionsStripped?: number;
};

/**
 * Generate AI catalog for `gameSlug`. By default loads ALL inputs from
 * disk (ideal for dashboard's in-process call after Auto-Onboard). Callers
 * with in-memory data (cold-start orchestrator) can pass overrides to
 * skip the disk reads — avoids redundant I/O when the data was just
 * captured in the same process.
 *
 * Overrides shape mirrors AiCatalogInput. When an override is provided it
 * REPLACES the disk-loaded value entirely; partial overrides not supported
 * (keep API simple). For deep-extract output the override key is
 * `auxiliarySources` which takes the same shape generateAiCatalog accepts.
 */
export async function phaseGenerateCatalog(args: {
  gameSlug: string;
  /** Override: pre-loaded UI registry (skip disk read). */
  uiMap?: UiRegistry;
  /** Override: pre-loaded provider cache. Pass `null` to indicate "no provider"
   *  — only the absence of the key means "load from disk". */
  provider?: ProviderCache | null;
  /** Override: pre-loaded feature registry. */
  features?: FeatureRegistry | null;
  /** Override: pre-captured network rounds (cold-start step 3 has these in
   *  memory; passing them avoids re-reading network.jsonl). */
  rounds?: NetworkRound[];
  /** Override: pre-constructed parser instance. */
  parser?: BaseParser;
  /** Override: spin API URL (from apiMapping or cold-start's top URL). */
  spinApiUrl?: string | null;
  /** Override: deep-extract output (cold-start has this in memory after step
   *  4c; passing it skips the auxiliary-sources/* disk reads). */
  auxiliarySources?: {
    paytableMd: string | null;
    infoMd: string | null;
    buyOptionsMd: string | null;
    specialBetsMd: string | null;
    paytableJson: unknown | null;
    rulesJson: unknown | null;
  } | null;
}): Promise<PhaseGenerateCatalogResult> {
  const t0 = Date.now();
  const slug = args.gameSlug;

  const uiMap = args.uiMap ?? await uiRegistry.load(slug);
  if (!uiMap || Object.keys(uiMap).length === 0) {
    return { ok: false, reason: "ui-registry.json missing or empty — onboard first", durationMs: Date.now() - t0 };
  }

  const provider = args.provider !== undefined ? args.provider : await providerCache.load(slug);
  if (!provider) {
    return { ok: false, reason: "provider-cache.json missing — onboard first (provider detection needed)", durationMs: Date.now() - t0 };
  }

  const [features, api] = await Promise.all([
    args.features !== undefined ? Promise.resolve(args.features) : featureRegistry.load(slug),
    args.spinApiUrl !== undefined ? Promise.resolve(null) : apiMapping.load(slug),
  ]);
  const spinApiUrl = args.spinApiUrl !== undefined ? args.spinApiUrl : (api?.spinApi?.url ?? null);
  // createParserForGame has a provider-cache fallback (auto-derives parser
  // kind from provider.provider) so this won't throw even if parser.json is
  // missing — it'll be written lazily.
  const parser = args.parser ?? await createParserForGame(slug);

  // Aggregate network rounds — use override if given, else load from disk.
  const rounds: NetworkRound[] = args.rounds ? [...args.rounds] : [];
  if (!args.rounds) {
  // (a) canonical network/network.jsonl from cold-start or persist-network phase
  try {
    const cold = await readFile(path.join(dirForGame(slug), "network", "network.jsonl"), "utf8");
    for (const line of cold.split("\n")) {
      if (!line.trim()) continue;
      try { rounds.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  } catch { /* no canonical capture yet */ }
  // (b) per-case captures from case-executor (includes payout-calibration's
  // network log written by Auto-Onboard's calibrate phase). Converted to
  // NetworkRound shape — generateAiCatalog only reads responses[] anyway.
  try {
    const evDir = path.join(dirForGame(slug), "case-evidence");
    const files = (await readdir(evDir)).filter((f) => f.endsWith(".network.jsonl"));
    for (const f of files) {
      let raw: string;
      try { raw = await readFile(path.join(evDir, f), "utf8"); } catch { continue; }
      const responses: CapturedResponse[] = [];
      const requests: CapturedRequest[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as {
            url: string; method?: string; status?: number;
            requestBody?: string | null; responseBody?: string | null; at?: string;
          };
          if (e.responseBody) {
            responses.push({
              url: e.url, status: e.status ?? 200, headers: {}, body: e.responseBody,
              timing: { startedAt: 0, finishedAt: 0 },
            });
          }
          if (e.requestBody) {
            requests.push({
              url: e.url, method: e.method ?? "POST", headers: {}, body: e.requestBody,
              timestamp: e.at ? Date.parse(e.at) : 0,
            });
          }
        } catch { /* skip */ }
      }
      if (responses.length > 0) {
        rounds.push({ index: rounds.length, requests, responses, wsFrames: [], screenshots: [] });
      }
    }
  } catch { /* no case-evidence yet */ }
  } // end if (!args.rounds)

  // Auxiliary sources — use override if given, else load from disk.
  type AuxSources = NonNullable<typeof args.auxiliarySources>;
  let auxiliarySources: AuxSources | null = null;
  let hadAuxSources = false;
  if (args.auxiliarySources !== undefined) {
    auxiliarySources = args.auxiliarySources;
    hadAuxSources = auxiliarySources != null;
  } else {
    const auxDir = path.join(dirForGame(slug), "auxiliary-sources");
    const tryRead = async (name: string): Promise<string | null> => {
      try { return await readFile(path.join(auxDir, name), "utf8"); } catch { return null; }
    };
    const tryReadJson = async (name: string): Promise<unknown | null> => {
      const txt = await tryRead(name);
      if (txt == null) return null;
      try { return JSON.parse(txt); } catch { return null; }
    };
    const [paytableMd, infoMd, buyOptionsMd, specialBetsMd, paytableJson, rulesJson] = await Promise.all([
      tryRead("paytable.md"),
      tryRead("rules-full.md"),
      tryRead("buy-options.md"),
      tryRead("special-bets.md"),
      tryReadJson("paytable.json"),
      tryReadJson("rules.json"),
    ]);
    hadAuxSources = [paytableMd, infoMd, buyOptionsMd, specialBetsMd, paytableJson, rulesJson].some((v) => v != null);
    auxiliarySources = hadAuxSources
      ? { paytableMd, infoMd, buyOptionsMd, specialBetsMd, paytableJson, rulesJson }
      : null;
  }

  console.log(`[phase/generate-catalog] ${slug}: rounds=${rounds.length} aux=${hadAuxSources} ui=${Object.keys(uiMap).length}`);

  try {
    const result = await generateAiCatalog({
      gameSlug: slug,
      provider,
      uiMap,
      features,
      rounds,
      parser,
      spinApiUrl,
      auxiliarySources,
    });
    if (!result.catalog) {
      return {
        ok: false,
        reason: result.reason ?? "catalog generation returned null",
        roundsLoaded: rounds.length,
        hadAuxSources,
        durationMs: Date.now() - t0,
      };
    }
    let totalCases = result.catalog.total_cases;
    let standardTemplatesApplied = 0;
    let standardTemplatesSkipped = 0;
    let assertionsStripped = 0;
    try {
      const templated = await applyTemplateSet(slug, { mode: "merge" });
      standardTemplatesApplied = templated.applied.length;
      standardTemplatesSkipped = templated.skipped.length;
      const merged = await loadRawCatalog(slug).catch(() => null);
      // Generate Cases must NOT emit assertions. Both the AI catalog generator
      // and the standard template set attach custom_assertions; strip them here
      // (AFTER the merge, so it catches every source) and persist the cleaned
      // catalog. Cases start with an empty assertion list — assertions are added
      // later via admin oc-notes (assertion-note-reviser) or manual QA edits.
      if (merged) {
        let strippedCases = 0;
        for (const c of merged.cases) {
          const n = c.custom_assertions?.length ?? 0;
          if (n > 0) { assertionsStripped += n; strippedCases++; }
          c.custom_assertions = [];
        }
        if (assertionsStripped > 0) await saveCatalog(slug, merged);
        totalCases = merged.cases.length;
        console.log(
          `[phase/generate-catalog] ${slug}: merged standard templates `
          + `(eligible=${standardTemplatesApplied}, skipped=${standardTemplatesSkipped}, total=${totalCases}); `
          + `stripped ${assertionsStripped} assertion(s) from ${strippedCases} case(s) — cases start with no assertions`,
        );
      } else {
        console.log(
          `[phase/generate-catalog] ${slug}: merged standard templates `
          + `(eligible=${standardTemplatesApplied}, skipped=${standardTemplatesSkipped}, total=${totalCases})`,
        );
      }
    } catch (err) {
      return {
        ok: false,
        reason: `AI catalog generated but standard template merge failed: ${err instanceof Error ? err.message : String(err)}`,
        roundsLoaded: rounds.length,
        hadAuxSources,
        durationMs: Date.now() - t0,
      };
    }
    return {
      ok: true,
      totalCases,
      catalogPath: result.catalogJsonPath ?? undefined,
      roundsLoaded: rounds.length,
      hadAuxSources,
      standardTemplatesApplied,
      standardTemplatesSkipped,
      assertionsStripped,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      roundsLoaded: rounds.length,
      hadAuxSources,
      durationMs: Date.now() - t0,
    };
  }
}
