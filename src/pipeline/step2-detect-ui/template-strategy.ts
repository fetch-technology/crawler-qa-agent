import type { Page } from "playwright";
import type { StrategyResult } from "./types.js";

/**
 * Phase 3: implement with pixelmatch for template baselines.
 * Stub for Phase 1.
 */
export async function tryTemplate(_page: Page, _elementKind: string): Promise<StrategyResult> {
  return { found: false };
}
