// Provider detection — URL patterns now loaded from registry/provider-config
// (Phase 7.1H). Defaults match the original hardcoded PRAGMATIC_URL regex.

import type { Page } from "playwright";
import type { ProviderName } from "../registry/types.js";
import { resolveProviderPattern, builtinProviders } from "../registry/provider-config.js";

export type ProviderInfo = {
  provider: ProviderName;
  gameName: string;
  platform: "HTML5" | "Unity" | "Flash" | "Unknown";
};

export async function detectProvider(page: Page, gameUrl: string): Promise<ProviderInfo> {
  let provider: ProviderName = "Generic";
  // Iterate known providers and test each pattern against the URL (and iframe
  // URLs as fallback). First match wins.
  for (const known of builtinProviders()) {
    const pattern = await resolveProviderPattern(known.name);
    if (pattern.test(gameUrl)) {
      provider = known.name as ProviderName;
      break;
    }
    let matched = false;
    for (const frame of page.frames()) {
      if (pattern.test(frame.url())) {
        provider = known.name as ProviderName;
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  const title = await page.title().catch(() => "");
  const gameName = parseGameNameFromUrl(gameUrl) || title || "Unknown";
  const platform: ProviderInfo["platform"] = "HTML5";

  return { provider, gameName, platform };
}

function parseGameNameFromUrl(url: string): string {
  const m = url.match(/\/(vs\d+\w+)/i);
  return m && m[1] ? m[1] : "";
}
