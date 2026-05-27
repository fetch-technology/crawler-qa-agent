// Per-game bet-control tunables. Defaults match historical hardcoded values
// in case-executor.ts (20 clicks × 80ms). Override per game by writing
// `bet-controls.json` in the game's registry directory.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { BetControlsConfig, RegistryStore } from "./types.js";

export const BET_CONTROLS_DEFAULTS: Required<BetControlsConfig> = {
  minBetClicks: 20,
  maxBetClicks: 20,
  stepDelayMs: 80,
};

export const betControlsStore: RegistryStore<BetControlsConfig> = {
  load: (slug) => loadJson<BetControlsConfig>(slug, "betControls"),
  save: (slug, data) => saveJson(slug, "betControls", data),
  exists: (slug) => fileExists(slug, "betControls"),
};

export async function resolveBetControls(slug: string | null): Promise<Required<BetControlsConfig>> {
  if (!slug) return { ...BET_CONTROLS_DEFAULTS };
  const override = await betControlsStore.load(slug);
  if (!override) return { ...BET_CONTROLS_DEFAULTS };
  return { ...BET_CONTROLS_DEFAULTS, ...override };
}
