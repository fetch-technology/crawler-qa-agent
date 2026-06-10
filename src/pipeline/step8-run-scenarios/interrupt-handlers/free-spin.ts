// FREE_SPIN_TRIGGERED handler — dismiss trigger popup, then wait for chain
// to play out automatically (game usually auto-plays free spins). When the
// final free spin completes, balance updates and state returns to MAIN.
//
// Verification side-effect: caller can inspect collectedSpins for
// no-deduction invariant across the chain (a separate assertion responsibility).

import { detectAnyPopup } from "../../utils/ocr-popup.js";
import type { HandlerContext, HandlerOutcome, InterruptHandler } from "./types.js";

export const freeSpinHandler: InterruptHandler = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  const start = Date.now();
  const vp = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = Math.round(vp.width / 2);
  const cy = Math.round(vp.height / 2);

  // Step 1: dismiss the trigger popup (usually "PRESS ANYWHERE TO CONTINUE")
  try {
    await ctx.page.waitForTimeout(2000); // animation grace
    await ctx.page.mouse.click(cx, cy);
    await ctx.page.waitForTimeout(1500);
  } catch {
    // continue — sometimes there's no popup to dismiss
  }

  // Step 2: wait for chain to finish — poll OCR every 3s, look for absence
  // of FREE SPIN keyword in screen text. Hard cap from timing config.
  // #4b: previously this was additionally clamped to 3 min, which truncated
  // long / retriggered bonuses. Respect the configured hardCapMs (default
  // 5 min) so retrigger-heavy chains can play out fully.
  const deadline = start + ctx.timing.hardCapMs;
  while (Date.now() < deadline) {
    await ctx.page.waitForTimeout(3000);
    try {
      const det = await detectAnyPopup(ctx.page);
      const stillFs = det.matchedKeywords.some((k) => k.includes("free spin"));
      const hasInterstitial = det.matchedKeywords.some((k) =>
        k.includes("press anywhere") || k.includes("congratulations"),
      );
      if (hasInterstitial) {
        // End-of-chain interstitial — tap to dismiss
        await ctx.page.mouse.click(cx, cy);
        await ctx.page.waitForTimeout(1500);
        return {
          handler: "free-spin",
          ok: true,
          summary: "chain completed and end-interstitial dismissed",
          finalState: "MAIN",
          durationMs: Date.now() - start,
        };
      }
      if (!stillFs) {
        return {
          handler: "free-spin",
          ok: true,
          summary: "chain completed (no FREE SPIN text on screen)",
          finalState: "MAIN",
          durationMs: Date.now() - start,
        };
      }
    } catch {
      // OCR error — give up gracefully
      break;
    }
  }

  return {
    handler: "free-spin",
    ok: false,
    summary: "chain did not complete within hard cap",
    finalState: "UNKNOWN",
    durationMs: Date.now() - start,
  };
};
