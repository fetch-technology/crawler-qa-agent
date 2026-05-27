import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { computeRtp } from "./rtp.js";
import { computeHitRate } from "./hit-rate.js";
import { computeVolatility } from "./volatility.js";
import { computeFeatureFrequency } from "./feature-frequency.js";
import { dedupByRoundId } from "./dedup.js";
import type { StatReport } from "./types.js";

/**
 * Aggregate per-spin stats. Cascade games (PP, Hacksaw) emit multiple response
 * frames per spin — we dedupe by roundId so RTP / hit-rate / volatility reflect
 * LOGICAL spins, not raw frames. Raw (pre-dedup) stats are surfaced under
 * `raw` for debugging.
 */
export function aggregate(spins: NormalizedSpinResult[]): StatReport {
  const unique = dedupByRoundId(spins);

  const { totalBet, totalWin, rtp } = computeRtp(unique);
  const { hitRate } = computeHitRate(unique);
  const { band: volatility, distribution } = computeVolatility(unique);
  const features = computeFeatureFrequency(unique);

  const rawRtp = computeRtp(spins);
  const rawHit = computeHitRate(spins);

  return {
    totalSpins: unique.length,
    totalBet,
    totalWin,
    rtp,
    hitRate,
    volatility,
    features,
    winDistribution: distribution,
    raw: {
      frameCount: spins.length,
      rtpRaw: rawRtp.rtp,
      hitRateRaw: rawHit.hitRate,
    },
  };
}
