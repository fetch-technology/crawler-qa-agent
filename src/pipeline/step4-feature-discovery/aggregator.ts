import type { FeatureName, FeatureRegistry, FeatureSignal, FeatureSource } from "./types.js";

const PRESENCE_THRESHOLD = 0.7;
const MULTI_SOURCE_BONUS = 0.05;

export function aggregateSignals(signals: FeatureSignal[]): FeatureRegistry {
  const byFeature = new Map<FeatureName, FeatureSignal[]>();
  for (const sig of signals) {
    const arr = byFeature.get(sig.feature) ?? [];
    arr.push(sig);
    byFeature.set(sig.feature, arr);
  }

  const features: FeatureRegistry["features"] = {};
  for (const [feature, list] of byFeature) {
    const sources = Array.from(new Set(list.map((s) => s.source))) as FeatureSource[];
    const maxConf = list.reduce((m, s) => Math.max(m, s.confidence), 0);
    const adjusted = Math.min(1, maxConf + (sources.length - 1) * MULTI_SOURCE_BONUS);
    features[feature] = {
      present: adjusted >= PRESENCE_THRESHOLD,
      confidence: adjusted,
      sources,
    };
  }

  return {
    detectedAt: new Date().toISOString(),
    signals,
    features,
  };
}
