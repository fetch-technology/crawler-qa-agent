// AI: called only during cold-start to add optional case suggestions. NEVER per-spin.

import type { GeneratedTestcase } from "./types.js";

export async function aiAugmentTestcases(
  baseCases: GeneratedTestcase[],
): Promise<GeneratedTestcase[]> {
  return baseCases;
}
