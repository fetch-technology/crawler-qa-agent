// AI: called only during cold-start discovery or recovery — NEVER per-spin.
// Delegates to ai-vision-batch which makes a SINGLE Claude call per Page session
// and serves all element lookups from the cached result.

import type { Page } from "playwright";
import { getAiBatchResult, toUiElement } from "./ai-vision-batch.js";
import type { StrategyResult } from "./types.js";

export async function tryAiVision(page: Page, elementKind: string): Promise<StrategyResult> {
  const result = await getAiBatchResult(page);
  if (!result) return { found: false };
  const coord = result.elements[elementKind];
  if (!coord || typeof coord.x !== "number" || typeof coord.y !== "number") {
    return { found: false };
  }
  return { found: true, element: toUiElement(coord) };
}
