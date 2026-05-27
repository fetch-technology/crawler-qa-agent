import { meta } from "./meta.js";
import { uiRegistry } from "./ui-registry.js";
import { providerCache } from "./provider-cache.js";
import { apiMapping } from "./api-mapping.js";
import { parserCache } from "./parser-cache.js";
import type { GameSlug } from "./types.js";

export async function registryExists(slug: GameSlug): Promise<boolean> {
  const [m, ui, prov, api, parser] = await Promise.all([
    meta.exists(slug),
    uiRegistry.exists(slug),
    providerCache.exists(slug),
    apiMapping.exists(slug),
    parserCache.exists(slug),
  ]);
  return m && ui && prov && api && parser;
}
