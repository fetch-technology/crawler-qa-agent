// Phase: translate-cases — AI translates each case's natural-language
// setup_instructions into a structured CaseAction[] sequence that
// case-executor can run. Persisted to test-cases.actions.json so per-case
// "Run" doesn't pay this AI cost.
//
// Idempotent — cases already in the cache are reused, only NEW cases get
// translated (~$0.02-0.10 per fresh case). Side effect:
// fixtures/registry/<slug>/test-cases.actions.json.
//
// Runs AFTER phase-generate-catalog. Typical Auto-Onboard chain:
//   generate-catalog → translate-cases → (cases ready to run).

import { loadAiCatalog } from "../step7-testcase-gen/ai-catalog.js";
import { translateAllCases } from "../step7-testcase-gen/case-action-translator.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { buildGameSpec } from "../step7-testcase-gen/build-game-spec.js";
import { providerCache } from "../registry/provider-cache.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { apiMapping } from "../registry/api-mapping.js";
import type { UiRegistry, ProviderCache } from "../registry/types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { TestCaseCatalog } from "../../ai/test-catalog.js";
import type { PhaseResult } from "./types.js";

export type PhaseTranslateCasesResult = PhaseResult & {
  totalCases?: number;
  /** How many cases were translated this run (rest reused from cache). */
  newCount?: number;
  cachePath?: string;
};

/**
 * Translate cases in `gameSlug`'s catalog into action sequences. Disk-first
 * by default; callers with in-memory data (cold-start orchestrator) can
 * pass overrides.
 */
export async function phaseTranslateCases(args: {
  gameSlug: string;
  /** Override: pre-loaded catalog (cold-start just generated it). */
  catalog?: TestCaseCatalog | null;
  /** Override: pre-loaded UI registry. */
  uiMap?: UiRegistry;
  /** Override: pre-loaded provider cache. */
  provider?: ProviderCache | null;
  /** Override: pre-loaded feature registry. */
  features?: FeatureRegistry | null;
  /** Override: pre-resolved spin API URL. */
  spinApiUrl?: string | null;
}): Promise<PhaseTranslateCasesResult> {
  const t0 = Date.now();
  const slug = args.gameSlug;

  const catalog = args.catalog !== undefined ? args.catalog : await loadAiCatalog(slug);
  if (!catalog || catalog.cases.length === 0) {
    return { ok: false, reason: "test-cases.json missing or empty — run generate-catalog first", durationMs: Date.now() - t0 };
  }

  const uiMap = args.uiMap ?? await uiRegistry.load(slug);
  if (!uiMap || Object.keys(uiMap).length === 0) {
    return { ok: false, reason: "ui-registry.json missing — onboard first", durationMs: Date.now() - t0 };
  }

  // GameSpec drives bet-ladder math + default-bet hints in the translator
  // prompt. Build from the same inputs catalog gen used so the two are
  // consistent (a case asserting betAmount === 7 expects the translator to
  // see 7 as a valid ladder rung).
  const [provider, features, paytable, api] = await Promise.all([
    args.provider !== undefined ? Promise.resolve(args.provider) : providerCache.load(slug),
    args.features !== undefined ? Promise.resolve(args.features) : featureRegistry.load(slug),
    paytableStore.load(slug).catch(() => null),
    args.spinApiUrl !== undefined ? Promise.resolve(null) : apiMapping.load(slug),
  ]);
  const spinApiUrl = args.spinApiUrl !== undefined ? args.spinApiUrl : (api?.spinApi?.url ?? null);
  // QA override for bet ladder / min / max → flows into translator's
  // GameSpec hint so set_bet_to_value() targets the corrected ladder.
  const { gameSpecOverride } = await import("../registry/game-spec-override.js");
  const ov = await gameSpecOverride.load(slug).catch(() => null);
  const betOverride = ov ? {
    baseBet: ov.defaultBet,
    betLadder: ov.betLadder,
    betMin: ov.betMin,
    betMax: ov.betMax,
  } : undefined;
  const bigSpec = buildGameSpec({
    gameSlug: slug,
    provider,
    uiMap,
    features,
    parsedSpins: [],
    spinApiUrl,
    paytable,
    betOverride,
  });
  // translateAllCases' GameSpec is a 4-field subset (betLadder/defaultBet/
  // betMin/betMax) — distinct from buildGameSpec's rich shape used by the
  // catalog generator. Extract just what the translator needs so types match.
  const ladder = bigSpec.bet_mechanics?.bet_sizes ?? [];
  const specForTranslate = {
    betLadder: ladder,
    defaultBet: bigSpec.bet_mechanics?.base_bet ?? undefined,
    betMin: ladder.length > 0 ? ladder[0] : undefined,
    betMax: ladder.length > 0 ? ladder[ladder.length - 1] : undefined,
  };

  // Operator code drives admin per-OC override notes injected into the
  // translate prompt. Derived from the game's launch URL (persisted in _meta).
  const { meta } = await import("../registry/meta.js");
  const { deriveOcKey } = await import("../registry/oc-prompt-notes.js");
  const gameMeta = await meta.load(slug).catch(() => null);
  const oc = deriveOcKey(gameMeta?.gameUrl);

  try {
    const before = (await loadAiCatalog(slug))?.cases.length ?? 0;
    const result = await translateAllCases(slug, catalog.cases, uiMap, specForTranslate, oc);
    const total = Object.keys(result.cases).length;
    // newCount derived approximately — translateAllCases skips already-cached
    // cases. The function itself logs new vs cached; here we just report total.
    return {
      ok: true,
      totalCases: total,
      newCount: total - before, // best-effort; result.cases is a Record not a delta
      cachePath: `fixtures/registry/${slug}/test-cases.actions.json`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}
