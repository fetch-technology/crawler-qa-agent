import type { UiRegistry } from "../registry/types.js";
import type { FeatureName, FeatureSignal } from "./types.js";

const UI_TO_FEATURE: Record<string, FeatureName> = {
  buyBonusButton: "buyBonus",
  autoButton: "autoSpin",
  turboButton: "turbo",
  historyButton: "history",
  paytableButton: "paytable",
};

export function detectFromUi(uiMap: UiRegistry): FeatureSignal[] {
  const signals: FeatureSignal[] = [];
  for (const [key, feature] of Object.entries(UI_TO_FEATURE)) {
    if (uiMap[key]) {
      signals.push({
        feature,
        source: "ui",
        confidence: uiMap[key]?.confidence ?? 0.9,
        evidence: `UI element "${key}" present`,
      });
    }
  }
  return signals;
}
