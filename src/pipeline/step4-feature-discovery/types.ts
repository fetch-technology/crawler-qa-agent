export type FeatureName =
  | "buyBonus"
  | "freeSpin"
  | "respin"
  | "multiplier"
  | "gamble"
  | "jackpot"
  | "turbo"
  | "autoSpin"
  | "extraBet"
  | "history"
  | "paytable"
  | "scatter"
  | "wild"
  | "cascade"
  | "megaways";

export type FeatureSource = "ui" | "network" | "paytable" | "gameplay" | "ai";

export type FeatureSignal = {
  feature: FeatureName;
  source: FeatureSource;
  confidence: number;
  evidence: string;
};

export type FeatureRegistry = {
  detectedAt: string;
  signals: FeatureSignal[];
  features: Partial<Record<FeatureName, { present: boolean; confidence: number; sources: FeatureSource[] }>>;
};

export const ALL_FEATURES: FeatureName[] = [
  "buyBonus",
  "freeSpin",
  "respin",
  "multiplier",
  "gamble",
  "jackpot",
  "turbo",
  "autoSpin",
  "extraBet",
  "history",
  "paytable",
  "scatter",
  "wild",
  "cascade",
  "megaways",
];
