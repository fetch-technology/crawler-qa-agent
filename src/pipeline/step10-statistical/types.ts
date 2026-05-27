export type FeatureFrequency = {
  freeSpinTrigger: number;
  bonusTrigger: number;
  retrigger: number;
};

export type WinDistribution = {
  totalSpins: number;
  hitCount: number;
  maxWin: number;
  meanWin: number;
  stddev: number;
  percentiles: { p50: number; p90: number; p99: number; p999: number };
};

export type StatReport = {
  totalSpins: number;
  totalBet: number;
  totalWin: number;
  rtp: number;
  hitRate: number;
  volatility: "low" | "medium" | "high";
  features: FeatureFrequency;
  winDistribution: WinDistribution;
  /** Raw stats over ALL captured frames (pre-dedup). Useful for debugging cascade games where 1 spin emits N frames. */
  raw?: {
    frameCount: number;
    rtpRaw: number;
    hitRateRaw: number;
  };
};
