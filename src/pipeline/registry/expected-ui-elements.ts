// Per-game expected UI element list. Defaults are the universal slot-game
// buttons. Per-game override file `expected-ui-elements.json` can ADD
// game-specific targets (anteBet, doubleChance, autoplay presets, ...) so AI
// discovery actively looks for them instead of silently missing them.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { ExpectedUiElementsConfig, RegistryStore } from "./types.js";

export type ExpectedUiElement = {
  key: string;
  description: string;
  /** Critical elements get a confidence-0.5 fallback when verify fails
   *  (never silently dropped). Non-critical that fail verify are kept as
   *  low-confidence pending entries for QA to review. */
  critical?: boolean;
};

/** The universal MAIN-STATE slot buttons + their AI-prompt visual descriptions.
 *  Mirrors the descriptions previously hardcoded in ai-vision-batch SYSTEM.
 *
 *  NOTE: historyButton + turboButton are intentionally NOT here — in PP-style
 *  games they live inside popups (history → menu popup, turbo → autoplay
 *  popup), not on the main screen. Listing them here makes AI hallucinate a
 *  main-screen coord (false positive). Discover them via the per-row
 *  [Discover] flow on menuButton / autoButton instead. Games that DO expose
 *  them on the main screen can add them back via per-game
 *  expected-ui-elements.json. */
export const EXPECTED_UI_ELEMENTS_DEFAULTS: ExpectedUiElement[] = [
  { key: "spinButton", critical: true, description: "large round button with a circular arrow ⟳ or ↻ icon, almost always centered in the bottom action strip" },
  { key: "autoButton", description: "button labeled AUTO / AUTOPLAY, usually small, near spinButton (often just below or to the left)" },
  { key: "buyBonusButton", critical: true, description: "rectangular panel labeled BUY FEATURE / BUY BONUS, usually on the LEFT side of the reels, often red/orange" },
  { key: "paytableButton", description: "'i' info icon or '?' help icon, top-left or bottom-left corner" },
  { key: "menuButton", description: "☰ hamburger lines, top-left corner" },
  { key: "betPlus", description: "a '+' icon button immediately to the RIGHT of the bet value display" },
  { key: "betMinus", description: "a '−' icon button immediately to the LEFT of the bet value display" },
];

export const expectedUiElementsStore: RegistryStore<ExpectedUiElementsConfig> = {
  load: (slug) => loadJson<ExpectedUiElementsConfig>(slug, "expectedUiElements"),
  save: (slug, data) => saveJson(slug, "expectedUiElements", data),
  exists: (slug) => fileExists(slug, "expectedUiElements"),
};

/**
 * Resolve the expected element list for a game: defaults + per-game overrides.
 * Override entries with a key matching a default REPLACE that default (so QA
 * can refine a description). New keys are appended. `replaceDefaults: true`
 * drops defaults entirely.
 */
export async function resolveExpectedUiElements(
  slug: string | null,
): Promise<ExpectedUiElement[]> {
  if (!slug) return [...EXPECTED_UI_ELEMENTS_DEFAULTS];
  const override = await expectedUiElementsStore.load(slug).catch(() => null);
  const extras = override?.elements ?? [];
  if (override?.replaceDefaults) {
    return extras.length > 0 ? [...extras] : [...EXPECTED_UI_ELEMENTS_DEFAULTS];
  }
  const byKey = new Map<string, ExpectedUiElement>();
  for (const e of EXPECTED_UI_ELEMENTS_DEFAULTS) byKey.set(e.key, e);
  for (const e of extras) byKey.set(e.key, e); // override or append
  return [...byKey.values()];
}
