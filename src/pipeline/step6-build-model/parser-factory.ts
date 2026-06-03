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
      kind = provider.provider === "Pragmatic" ? "PragmaticParser" : "GenericParser";
      try {
        await parserCache.save(gameSlug, { parser: kind, version: 1 });
        console.log(`[parser-factory] persisted parser.json for "${gameSlug}" (derived from provider="${provider.provider}" → ${kind})`);
      } catch (err) {
        // Non-fatal — kind is already resolved, we just couldn't cache.
        console.warn(`[parser-factory] failed to persist parser.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

  return parser;
}
