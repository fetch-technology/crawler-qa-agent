import type { Page } from "playwright";
import type { UiRegistry } from "../registry/types.js";
import type { SmokeResult } from "./types.js";
import { waitUntilStable, type Region } from "../utils/pixel-diff/index.js";

const REELS_REGION_DEFAULT: Region = { x: 200, y: 150, width: 1400, height: 700 };

export type SmokeOptions = {
  spins?: number;
  /** Region to monitor for stability — defaults to reels. Avoid full-screen so idle background animations don't block. */
  region?: Region;
  /** Per-spin max stability iterations. Default 10 (3s with 300ms interval). */
  maxIterations?: number;
  /** Pixel diff ratio threshold above which the frame is "changed". Default 0.02. */
  changeThreshold?: number;
};

export async function runSmokeSpins(
  page: Page,
  uiMap: UiRegistry,
  opts: SmokeOptions = {},
): Promise<SmokeResult> {
  const spins = opts.spins ?? 5;
  const region = opts.region ?? REELS_REGION_DEFAULT;
  const maxIterations = opts.maxIterations ?? 10;
  const changeThreshold = opts.changeThreshold ?? 0.02;

  const result: SmokeResult = {
    spinsAttempted: 0,
    clickable: false,
    animationStarted: false,
    screenStable: false,
    errors: [],
  };

  const spin = uiMap.spinButton;
  if (!spin) {
    result.errors.push("spinButton missing in uiMap");
    return result;
  }

  for (let i = 0; i < spins; i++) {
    try {
      await page.mouse.click(spin.x, spin.y);
      result.clickable = true;
      result.spinsAttempted++;
      const stable = await waitUntilStable(page, {
        region,
        maxIterations,
        changeThreshold,
        consecutiveStable: 2,
      });
      result.screenStable = stable;
      result.animationStarted = true;
    } catch (e) {
      result.errors.push(String(e));
    }
  }

  return result;
}
