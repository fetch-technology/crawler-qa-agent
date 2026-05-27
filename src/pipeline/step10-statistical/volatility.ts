import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { WinDistribution } from "./types.js";

export function computeVolatility(spins: NormalizedSpinResult[]): {
  band: "low" | "medium" | "high";
  distribution: WinDistribution;
} {
  const wins = spins.map((s) => s.win);
  const total = wins.length;
  const hits = wins.filter((w) => w > 0);
  const maxWin = hits.length > 0 ? Math.max(...hits) : 0;
  const meanWin = total === 0 ? 0 : wins.reduce((a, b) => a + b, 0) / total;
  const variance = total === 0 ? 0 : wins.reduce((a, b) => a + (b - meanWin) ** 2, 0) / total;
  const stddev = Math.sqrt(variance);

  const sorted = [...wins].sort((a, b) => a - b);
  const pct = (p: number) => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx] ?? 0;
  };

  const distribution: WinDistribution = {
    totalSpins: total,
    hitCount: hits.length,
    maxWin,
    meanWin,
    stddev,
    percentiles: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999) },
  };

  const cv = meanWin === 0 ? 0 : stddev / meanWin;
  const band: "low" | "medium" | "high" = cv < 3 ? "low" : cv < 8 ? "medium" : "high";

  return { band, distribution };
}
