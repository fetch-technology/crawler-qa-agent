import type { UiRegistry, Paytable } from "../registry/types.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { detectFromUi } from "./ui-detector.js";
import { detectFromNetwork } from "./network-detector.js";
import { detectFromPaytable } from "./paytable-detector.js";
import { detectFromGameplay } from "./gameplay-detector.js";
import { detectFromAi, type AiDiscoveryInput } from "./ai-detector.js";
import { aggregateSignals } from "./aggregator.js";

export type DiscoveryInput = {
  uiMap: UiRegistry;
  rounds: NetworkRound[];
  paytable?: Paytable | null;
  spins?: NormalizedSpinResult[];
  ai?: AiDiscoveryInput;
};

export async function discoverFeatures(input: DiscoveryInput) {
  const signals = [
    ...detectFromUi(input.uiMap),
    ...detectFromNetwork(input.rounds),
    ...detectFromPaytable(input.paytable ?? null),
    ...detectFromGameplay(input.spins ?? []),
    ...(input.ai ? await detectFromAi(input.ai) : []),
  ];
  return aggregateSignals(signals);
}

export type { FeatureName, FeatureRegistry, FeatureSignal, FeatureSource } from "./types.js";
export { ALL_FEATURES } from "./types.js";
