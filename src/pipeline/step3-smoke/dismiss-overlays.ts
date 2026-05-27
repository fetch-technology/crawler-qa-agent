// Dismiss any "press anywhere to continue" / intro / post-free-spin popups by
// tapping safe areas before AI discovery. Slot games often boot into a stale-
// session popup ("YOU WON $X IN N FREE SPINS") that BLOCKS all UI clicks.
// Without dismissing, every spin attempt just dismisses one popup instead of
// triggering a spin.
//
// IMPORTANT: do NOT gate clicks on screen-stability — slot games have
// continuous background animations (smoke, sparkles, character idle) so the
// screen NEVER goes stable. Just click safe spots blindly; if there's no
// popup the clicks land on empty canvas and are no-ops.

import type { Page } from "playwright";
import { detectBlackScreen } from "../utils/pixel-diff/index.js";

// Safe click points — these coordinates should NEVER coincide with a UI button
// in a standard 1920×1080 slot layout (buttons sit at bottom or sides).
const SAFE_CLICKS: Array<{ x: number; y: number; label: string }> = [
  { x: 960, y: 500, label: "center" },
  { x: 200, y: 400, label: "left-mid" },
  { x: 1700, y: 400, label: "right-mid" },
];

export type DismissOptions = {
  initialWaitMs?: number;
  perClickWaitMs?: number;
  finalSettleMs?: number;
};

export async function dismissOverlays(
  page: Page,
  opts: DismissOptions = {},
): Promise<{ clicks: number; finalBlackScreen: boolean }> {
  const initialWaitMs = opts.initialWaitMs ?? 4000;
  const perClickWaitMs = opts.perClickWaitMs ?? 1200;
  const finalSettleMs = opts.finalSettleMs ?? 2000;

  // Initial settle — game loads splash, decompresses assets, etc.
  await page.waitForTimeout(initialWaitMs);

  let clicks = 0;
  for (const { x, y, label } of SAFE_CLICKS) {
    try {
      await page.mouse.click(x, y);
      clicks++;
      void label;
      await page.waitForTimeout(perClickWaitMs);
    } catch {
      // page may have closed mid-flow
      break;
    }
  }

  await page.waitForTimeout(finalSettleMs);

  const black = await detectBlackScreen(page, 0.85);
  return { clicks, finalBlackScreen: black.black };
}
