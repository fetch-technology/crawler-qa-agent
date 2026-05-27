// Build a GameSpec from new pipeline registry artifacts. Used as input to
// legacy `generateTestCaseCatalog()` which expects a fully-populated GameSpec.

import type { GameSpec } from "../../ai/authoring.js";
import type { Paytable, ProviderCache, UiRegistry } from "../registry/types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import { buildExecutionStrategy } from "../step6-build-model/execution-strategy.js";

export type SpecInput = {
  gameSlug: string;
  provider: ProviderCache | null;
  uiMap: UiRegistry | null;
  features: FeatureRegistry | null;
  parsedSpins: NormalizedSpinResult[];
  rounds?: NetworkRound[];
  spinApiUrl?: string | null;
  /** C1: paytable from registry (deep-extract.ts populates it during cold-start).
   *  When provided, symbols[] is hydrated from it instead of being empty. */
  paytable?: Paytable | null;
};

export function buildGameSpec(input: SpecInput): GameSpec {
  const slug = input.gameSlug;
  const gameName = input.provider?.gameName ?? slug;

  const observedBets = Array.from(
    new Set(input.parsedSpins.map((s) => s.bet).filter((b) => b > 0)),
  ).sort((a, b) => a - b);
  const baseBet = observedBets[0] ?? null;

  const features: GameSpec["features"] = [];
  if (input.features) {
    for (const [name, info] of Object.entries(input.features.features)) {
      if (info?.present) {
        features.push({
          name,
          description: `${name} detected via ${info.sources.join("+")} (confidence ${info.confidence.toFixed(2)})`,
          trigger: null,
        });
      }
    }
  }

  const sampleSpin = input.parsedSpins[0];
  const sample_spin_response_shape: Record<string, string> = {};
  if (sampleSpin?.raw) {
    for (const [k, v] of Object.entries(sampleSpin.raw)) {
      if (k.startsWith("__")) continue;
      sample_spin_response_shape[k] = typeof v;
    }
  }

  // Extract observed grid dimensions from sample reels. Catalog EXPAND prompt
  // surfaces these so AI doesn't hallucinate matrix.length / matrix[0].length
  // values in assertions (e.g., generating `matrix[0].length === 4` for a 5x5
  // game). Source = "observed" when we have real reel data; "default" when
  // we have to fall back.
  const grid_dimensions: GameSpec["grid_dimensions"] = (() => {
    const reels = sampleSpin?.reels;
    if (Array.isArray(reels) && reels.length > 0 && Array.isArray(reels[0]) && reels[0].length > 0) {
      return {
        width: reels.length,
        height: reels[0].length,
        source: "observed" as const,
      };
    }
    return undefined;
  })();

  const cascade = input.parsedSpins.some((s) => s.cascadeFrames.length > 0);

  const execution_strategy = buildExecutionStrategy({
    spins: input.parsedSpins,
    rounds: input.rounds ?? [],
    spinApiUrl: input.spinApiUrl ?? null,
    freeSpinDetected: features.some((f) => f.name === "freeSpin"),
  });

  return {
    game_code: slug,
    game_display_name: gameName,
    engine:
      input.provider?.platform === "HTML5" ? "HTML5/Canvas" : input.provider?.platform ?? null,
    currency: null,
    rules_summary: `Game ${gameName} (${input.provider?.provider ?? "Unknown"} provider). Features detected: ${features.map((f) => f.name).join(", ") || "none"}. ${cascade ? "Cascade/tumble mechanic detected from captured frames." : "Non-cascade."}`,
    bet_mechanics: {
      base_bet: baseBet,
      bet_sizes: observedBets,
      bet_levels: [],
      bet_amount_formula: "coin * lines (PP-style)",
    },
    features,
    symbols: paytableToGameSpecSymbols(input.paytable),
    invariants: [],
    sample_spin_response_shape,
    observed_caveats: buildCaveats(input.paytable),
    execution_strategy,
    mechanic_type: cascade ? "cluster" : "ways",
    cascade,
    grid_dimensions,
  };
}

/** C1: convert registry Paytable.symbols[] → GameSpec.symbols[]. Empty when
 *  no paytable extracted (cold-start step4 deep-extract didn't run or didn't
 *  succeed). Multipliers serialized as "x{n}" strings to match the GameSpec
 *  string-valued Record convention. */
export function paytableToGameSpecSymbols(pt: Paytable | null | undefined): GameSpec["symbols"] {
  if (!pt || pt.symbols.length === 0) return [];
  return pt.symbols.map((s) => {
    const mult: Record<string, string> = {};
    for (const p of s.payouts) mult[String(p.count)] = `x${p.multiplier}`;
    const type = inferSymbolType(s.name, s.symbol);
    return {
      code: s.symbol || null,
      name: s.name || null,
      type,
      multipliers: Object.keys(mult).length > 0 ? mult : null,
      note: null,
    };
  });
}

function inferSymbolType(name: string | undefined, code: string | undefined): GameSpec["symbols"][number]["type"] {
  const blob = `${name ?? ""} ${code ?? ""}`.toLowerCase();
  if (/\bwild\b/.test(blob)) return "WILD";
  if (/scatter/.test(blob)) return "SCATTER";
  if (/bonus|trigger/.test(blob)) return "BONUS";
  if (/mystery/.test(blob)) return "MYSTERY";
  return "PICTURE_SYMBOL";
}

function buildCaveats(pt: Paytable | null | undefined): string[] {
  const out: string[] = [];
  if (!pt || pt.symbols.length === 0) {
    out.push("GameSpec built from network capture observations only — paytable not extracted");
    out.push("Symbols list empty — run deep-extract during cold-start to populate paytable.json");
  } else {
    out.push(`Symbols list populated from registry/paytable.json (${pt.symbols.length} symbols extracted by deep-extract)`);
  }
  out.push("Invariants empty — relies on rule engine deterministic checks for now");
  return out;
}
