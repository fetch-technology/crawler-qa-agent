import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export function computeHitRate(spins: NormalizedSpinResult[]): {
  hitCount: number;
  hitRate: number;
} {
  if (spins.length === 0) return { hitCount: 0, hitRate: 0 };
  const hitCount = spins.filter((s) => s.win > 0).length;
  return { hitCount, hitRate: hitCount / spins.length };
}
