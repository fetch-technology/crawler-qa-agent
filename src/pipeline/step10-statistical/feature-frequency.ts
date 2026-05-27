import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { FeatureFrequency } from "./types.js";

export function computeFeatureFrequency(spins: NormalizedSpinResult[]): FeatureFrequency {
  const total = spins.length;
  if (total === 0) return { freeSpinTrigger: 0, bonusTrigger: 0, retrigger: 0 };

  let freeSpinTrigger = 0;
  let bonusTrigger = 0;
  let retrigger = 0;
  let prev: NormalizedSpinResult | null = null;

  for (const s of spins) {
    if (prev?.state !== "FREE_SPIN" && s.isFreeSpin) freeSpinTrigger++;
    if (prev?.state !== "BONUS" && s.hasBonus) bonusTrigger++;
    if (s.state === "RETRIGGER") retrigger++;
    prev = s;
  }

  return {
    freeSpinTrigger: freeSpinTrigger / total,
    bonusTrigger: bonusTrigger / total,
    retrigger: retrigger / total,
  };
}
