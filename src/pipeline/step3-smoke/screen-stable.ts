import type { Page } from "playwright";
import { waitUntilStable, type Region, type StableOptions } from "../utils/pixel-diff/index.js";

export type { Region, StableOptions };

export async function waitUntilScreenStable(
  page: Page,
  opts: StableOptions = {},
): Promise<boolean> {
  return waitUntilStable(page, opts);
}
