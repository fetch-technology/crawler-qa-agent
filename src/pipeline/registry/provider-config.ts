// Provider URL pattern config. Used by step1 provider-detector to map an
// arbitrary game URL to a known provider. Phase 7.1H extract from
// hardcoded `PRAGMATIC_URL` regex in provider-detector.ts.
//
// Lives at the PROVIDERS level (not per-game) under
// `fixtures/registry/_providers/<provider>.json`. The leading underscore
// distinguishes this from game slugs (avoid collision).
//
// Schema per file:
//   {
//     name: "Pragmatic" | "Generic" | ...,
//     urlPatterns: ["regex1", "regex2", ...],   // any match → this provider
//     skipPatterns: ["regex"],                  // skip these URLs (auth, static, etc.)
//     gameSlugPattern: "regex with one capture group" // extract slug from URL
//   }

import { readFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "./paths.js";

export type ProviderConfig = {
  name: string;
  urlPatterns: string[];
  skipPatterns?: string[];
  gameSlugPattern?: string;
};

/** Built-in providers — defaults used when no config file exists. */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    name: "Pragmatic",
    urlPatterns: [
      "pragmatic", "gs2c", "prerelease-d2", "sandbox\\.pragmatic",
      "\\/\\/pp\\.", "\\bpp\\.\\w",
      // Game slug conventions:
      //   vs<N><name>     → vs20rnriches, vs10aocelot, vs5flames     (classic paylines)
      //   vsways<name>    → vswaysmahwin2, vswaysrcandy              (ways family)
      //   vscluster<name> → vsclustertumbl, vsclustersweet           (cluster family)
      //   vshades / vshorus / vsfun<...> → various other PP families
      "vs\\d+\\w+",
      "vsways\\w+",
      "vscluster\\w+",
      "vshades\\w+",
      "vshorus\\w+",
      "vsfun\\w+",
    ],
    gameSlugPattern: "\\/(vs(?:\\d+|ways|cluster|hades|horus|fun)\\w+)",
  },
  {
    // 3 Oaks (Booongo) — RG sandbox. Game service host `api.3oaks.…` with a
    // `…/gs/<game>/desktop/<id>/<brand>?gsc=play` spin endpoint, and the static
    // bundle served from `static.3oaks.…/api/v1/games/<game>/play/`.
    name: "ThreeOaks",
    urlPatterns: [
      "3oaks",
      "\\/gs\\/[^/]+\\/desktop\\/",
    ],
    // Slug from the game-service path (`/gs/black_wolf_2/desktop/…`) or the
    // static bundle path (`/api/v1/games/black_wolf_2/play/`).
    gameSlugPattern: "\\/(?:gs|games)\\/([a-z0-9_]+)\\/(?:desktop|play)",
  },
  {
    // Playtech GPAS — RG sandbox. Static client at `static.playtech.…/gpasclient.html`
    // + game-service WebSocket at `api.playtech.…/socket.io/…`. The launch URL
    // carries the real game in `?game=pt-gpas-<name>`.
    name: "Playtech",
    urlPatterns: ["playtech", "gpasclient", "\\/socket\\.io\\/"],
    // Slug from `?game=pt-gpas-rabbitcash-pop` (else the path falls back to the
    // html filename — see crawler deriveSlug).
    gameSlugPattern: "[?&]game=([a-z0-9_-]+)",
  },
];

/** Load a provider config file by name. Returns null if not on disk; engine
 *  callers can fall back to BUILTIN_PROVIDERS entry. */
export async function loadProviderConfig(name: string): Promise<ProviderConfig | null> {
  const file = path.join(dirForGame(`_providers`), `${name.toLowerCase()}.json`);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ProviderConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve provider URL patterns: returns disk overrides if present, else
 * built-in. The returned regex array is compiled (joined into one regex with
 * alternation) for caller convenience.
 */
export async function resolveProviderPattern(name: string): Promise<RegExp> {
  const config = (await loadProviderConfig(name))
    ?? BUILTIN_PROVIDERS.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!config) {
    throw new Error(`Unknown provider: ${name}. Add fixtures/registry/_providers/${name.toLowerCase()}.json or register in BUILTIN_PROVIDERS.`);
  }
  const joined = config.urlPatterns.map((p) => `(?:${p})`).join("|");
  return new RegExp(joined, "i");
}

/** All known providers — built-ins + any custom JSON files. Used by detector
 *  to iterate when caller doesn't know which provider to test against. */
export function builtinProviders(): ProviderConfig[] {
  return [...BUILTIN_PROVIDERS];
}
