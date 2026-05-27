import { uiRegistry } from "./ui-registry.js";
import { providerCache } from "./provider-cache.js";
import { apiMapping } from "./api-mapping.js";
import { parserCache } from "./parser-cache.js";
import { meta } from "./meta.js";
import { SCHEMA_VERSION } from "./paths.js";
import type { GameSlug, ValidationResult } from "./types.js";

export async function validateAll(slug: GameSlug): Promise<ValidationResult> {
  const invalidEntries: string[] = [];

  const [m, ui, prov, api, parser] = await Promise.all([
    meta.load(slug),
    uiRegistry.load(slug),
    providerCache.load(slug),
    apiMapping.load(slug),
    parserCache.load(slug),
  ]);

  if (!m) invalidEntries.push("meta");
  else if (m.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      invalidEntries: ["meta"],
      reason: `schemaVersion ${m.schemaVersion} != expected ${SCHEMA_VERSION}`,
    };
  }

  if (!ui || !ui.spinButton) invalidEntries.push("uiRegistry.spinButton");
  if (!prov) invalidEntries.push("providerCache");
  if (!api?.spinApi) invalidEntries.push("apiMapping.spinApi");
  if (!parser) invalidEntries.push("parserCache");

  return {
    ok: invalidEntries.length === 0,
    invalidEntries,
  };
}
