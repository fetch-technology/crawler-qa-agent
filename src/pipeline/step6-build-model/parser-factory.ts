// Parser construction factory — centralizes loading of bet formula + parser
// kind from the game's registry, so callers don't need to remember to inject
// `setBetMultiplier` manually after `pickParserByKind`.
//
// Before this factory:
//   const parser = pickParserByKind(kind);
//   const mechanics = await gameMechanics.load(slug);
//   if (mechanics) parser.setBetMultiplier(mechanics.betMultiplier);  // easy to forget
//
// After:
//   const parser = await createParserForGame(slug);   // bet formula baked in
//
// 4 of 5 prior call sites (cold-start, warm-start, run-spins, discover-features)
// previously SKIPPED multiplier injection → ways games (vswaysmahwin2) got
// bet=c*l=460.8 instead of c*20=9.0 silently. Factory fixes this once.

import { parserCache } from "../registry/parser-cache.js";
import { gameMechanics } from "../registry/game-mechanics.js";
import type { ParserKind, BaseParser } from "./base-parser.js";
import { pickParserByKind } from "./registry.js";

/** Subset of parser interface for the bet-multiplier injection point.
 *  Pure structural typing — any parser exposing setBetMultiplier qualifies. */
type WithBetMultiplier = BaseParser & {
  setBetMultiplier(m: number | undefined): void;
};

/** Optional setter for mechanic ("lines"/"ways"/"cluster"/"unknown") — lets
 *  the parser choose the right bet formula (e.g. lines games use request `l`
 *  directly; ways games rely on the per-level multiplier instead). */
type WithMechanic = BaseParser & {
  setMechanic(m: string | undefined): void;
};

function supportsBetMultiplier(parser: BaseParser): parser is WithBetMultiplier {
  return typeof (parser as { setBetMultiplier?: unknown }).setBetMultiplier === "function";
}

function supportsMechanic(parser: BaseParser): parser is WithMechanic {
  return typeof (parser as { setMechanic?: unknown }).setMechanic === "function";
}

/** Parser exposing the per-game overlay hook (SpecDrivenParser). Legacy
 *  hardcoded parsers don't, so overlay application is a no-op for them. */
type WithSpecOverlay = BaseParser & {
  applySpecOverlay(overlay: import("./providers/spec-types.js").ParserOverlay | null): void;
};

function supportsSpecOverlay(parser: BaseParser): parser is WithSpecOverlay {
  return typeof (parser as { applySpecOverlay?: unknown }).applySpecOverlay === "function";
}

export type ParserFactoryOptions = {
  /** Override parser kind (skip loading parser.json). Used by tests + paths
   *  where parser kind is already known. */
  parserKind?: ParserKind;
  /** Skip multiplier loading (e.g. for tests that want a pristine parser). */
  skipBetMultiplier?: boolean;
};

/**
 * Build a parser for a specific game with all configuration baked in.
 *   1. Load parser kind from `parser.json` (or use override)
 *   2. Load game-mechanics → inject betMultiplier into parser (if parser
 *      supports it AND mechanics exist with a positive multiplier)
 *
 * Errors:
 *   - parser.json missing AND no override → throws (game must run cold-start first)
 *   - game-mechanics.json missing → continues with naive formula (parser default)
 */
export async function createParserForGame(
  gameSlug: string,
  opts: ParserFactoryOptions = {},
): Promise<BaseParser> {
  let kind: ParserKind;
  if (opts.parserKind) {
    kind = opts.parserKind;
  } else {
    const cache = await parserCache.load(gameSlug);
    if (cache) {
      kind = cache.parser;
    } else {
      // Lazy fallback — Auto-Onboard doesn't persist parser.json (only
      // cold-start does), but provider-cache.json is written when the
      // session detects a provider. Derive parser kind from there + save
      // parser.json so subsequent calls skip this path. Mapping matches
      // step6/registry.ts: Pragmatic → PragmaticParser, else → GenericParser.
      const { providerCache } = await import("../registry/provider-cache.js");
      const provider = await providerCache.load(gameSlug);
      if (!provider) {
        throw new Error(
          `No parser.json or provider-cache.json for "${gameSlug}". Run qa:cold or Auto-Onboard first, or pass { parserKind } override.`,
        );
      }
      kind = provider.provider === "Pragmatic" ? "PragmaticParser"
        : provider.provider === "ThreeOaks" ? "ThreeOaksParser"
        : provider.provider === "Playtech" ? "PlaytechParser"
        : "GenericParser";
      try {
        await parserCache.save(gameSlug, { parser: kind, version: 1 });
        console.log(`[parser-factory] persisted parser.json for "${gameSlug}" (derived from provider="${provider.provider}" → ${kind})`);
      } catch (err) {
        // Non-fatal — kind is already resolved, we just couldn't cache.
        console.warn(`[parser-factory] failed to persist parser.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // A game pinned to a LEARNED provider spec (AI-derived + arithmetic-verified)
  // loads its own per-game spec from disk and runs the generic SpecDrivenParser
  // over it — no built-in ParserKind needed.
  if (kind === "LearnedSpecParser") {
    const { readFile } = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const { dirForGame } = await import("../registry/paths.js");
    const { SpecDrivenParser } = await import("./providers/spec-driven-parser.js");
    const specPath = pathMod.join(dirForGame(gameSlug), "learned-provider-spec.json");
    const spec = JSON.parse(await readFile(specPath, "utf8")) as import("./providers/spec-types.js").ProviderSpec;
    console.log(`[parser-factory] "${gameSlug}" → LearnedSpecParser (provider="${spec.name}")`);
    return new SpecDrivenParser(spec, "GenericParser");
  }
  const parser = pickParserByKind(kind);

  if (!opts.skipBetMultiplier) {
    const mechanics = await gameMechanics.load(gameSlug);
    if (mechanics) {
      if (supportsBetMultiplier(parser) && mechanics.betMultiplier > 0) {
        parser.setBetMultiplier(mechanics.betMultiplier);
      }
      if (supportsMechanic(parser) && mechanics.mechanic) {
        parser.setMechanic(mechanics.mechanic);
      }
    }
  }

  // Per-game parser overlay (Phase 1): layer the game-specific spec delta
  // (e.g. win itemization) on top of the provider base. Only TRUSTED aspects
  // override; absent overlay → base spec unchanged. No-op for legacy parsers.
  if (supportsSpecOverlay(parser)) {
    const { loadOverlay } = await import("./providers/spec-loader.js");
    const overlay = await loadOverlay(gameSlug);
    if (overlay) {
      parser.applySpecOverlay(overlay);
      console.log(`[parser-factory] applied parser-overlay for "${gameSlug}" (winItemization=${overlay.winItemization?.trusted ? overlay.winItemization.value : "untrusted→base"})`);
    }
  }

  return parser;
}
