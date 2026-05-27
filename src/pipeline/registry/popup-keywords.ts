// Per-game popup keyword overrides. Engine defaults live in
// src/pipeline/utils/ocr-popup.ts (POPUP_KEYWORDS, SUBSTATE_POPUP_KEYWORDS).
// Per-game override file `popup-keywords.json` can EXTEND those defaults
// (additive) or REPLACE entirely.

import { loadJson, saveJson, fileExists } from "./io.js";
import {
  POPUP_KEYWORDS as DEFAULT_INTERSTITIAL,
  SUBSTATE_POPUP_KEYWORDS as DEFAULT_SUBSTATE,
} from "../utils/ocr-popup.js";
import type { PopupKeywordsConfig, RegistryStore } from "./types.js";

export const popupKeywordsStore: RegistryStore<PopupKeywordsConfig> = {
  load: (slug) => loadJson<PopupKeywordsConfig>(slug, "popupKeywords"),
  save: (slug, data) => saveJson(slug, "popupKeywords", data),
  exists: (slug) => fileExists(slug, "popupKeywords"),
};

export type ResolvedKeywords = {
  interstitial: ReadonlyArray<string>;
  substate: ReadonlyArray<string>;
};

/**
 * Resolve effective popup keyword lists for a given game. When per-game
 * override has `replaceDefaults: true`, only the override values are used;
 * otherwise the override is concatenated with defaults (deduplicated).
 */
export async function resolvePopupKeywords(slug: string | null): Promise<ResolvedKeywords> {
  if (!slug) return { interstitial: DEFAULT_INTERSTITIAL, substate: DEFAULT_SUBSTATE };
  const override = await popupKeywordsStore.load(slug);
  if (!override) return { interstitial: DEFAULT_INTERSTITIAL, substate: DEFAULT_SUBSTATE };

  const overrideInterstitial = (override.interstitial ?? []).map((k) => k.toLowerCase());
  const overrideSubstate = (override.substate ?? []).map((k) => k.toLowerCase());

  if (override.replaceDefaults) {
    return {
      interstitial: overrideInterstitial,
      substate: overrideSubstate,
    };
  }
  // Extend defaults — dedupe via Set
  return {
    interstitial: [...new Set([...DEFAULT_INTERSTITIAL, ...overrideInterstitial])],
    substate: [...new Set([...DEFAULT_SUBSTATE, ...overrideSubstate])],
  };
}
