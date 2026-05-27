// Per-game timing tunables. Defaults match historical hardcoded values
// in case-executor.ts so existing tests don't break. Override per game by
// writing `timing-config.json` in the game's registry directory.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { TimingConfig, RegistryStore } from "./types.js";

export const TIMING_DEFAULTS: Required<TimingConfig> = {
  spinResponseTimeoutMs: 15_000,
  postActionSettleMs: 10_000,
  actionTimeoutMs: 30_000,
  hardCapMs: 5 * 60_000,
  popupCheckDelayMs: 2_500,
  dismissInterClickMs: 800,
  dismissPreWaitMs: 10_000,
  maxSpinRetries: 2,
};

export const timingConfig: RegistryStore<TimingConfig> = {
  load: (slug) => loadJson<TimingConfig>(slug, "timingConfig"),
  save: (slug, data) => saveJson(slug, "timingConfig", data),
  exists: (slug) => fileExists(slug, "timingConfig"),
};

/**
 * Load resolved timing config: returns DEFAULTS merged with any per-game
 * overrides from disk. Always returns a fully-populated object (no nulls).
 */
export async function resolveTimingConfig(slug: string | null): Promise<Required<TimingConfig>> {
  if (!slug) return { ...TIMING_DEFAULTS };
  const override = await timingConfig.load(slug);
  if (!override) return { ...TIMING_DEFAULTS };
  return { ...TIMING_DEFAULTS, ...override };
}
