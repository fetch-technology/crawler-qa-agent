// AI: called only during cold-start. Aggregates screenshots + network + paytable into
// a final feature judgement. NEVER per-spin.

import type { FeatureSignal } from "./types.js";

export type AiDiscoveryInput = {
  screenshotPath?: string;
  paytableScreenshotPath?: string;
  sampleResponses: string[];
  ocrButtons: string[];
};

export async function detectFromAi(_input: AiDiscoveryInput): Promise<FeatureSignal[]> {
  return [];
}
