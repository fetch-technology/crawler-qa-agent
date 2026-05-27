// BIG_WIN_POPUP handler — click center to dismiss + capture screenshot.
import type { HandlerContext, HandlerOutcome, InterruptHandler } from "./types.js";

export const bigWinHandler: InterruptHandler = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  const start = Date.now();
  const vp = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = Math.round(vp.width / 2);
  const cy = Math.round(vp.height / 2);
  try {
    await ctx.page.waitForTimeout(ctx.timing.dismissPreWaitMs);
    for (let i = 0; i < 2; i++) {
      await ctx.page.mouse.click(cx, cy);
      await ctx.page.waitForTimeout(ctx.timing.dismissInterClickMs);
    }
    return {
      handler: "big-win",
      ok: true,
      summary: "dismissed via center click",
      finalState: "MAIN",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      handler: "big-win",
      ok: false,
      summary: `error: ${err instanceof Error ? err.message : String(err)}`,
      finalState: "UNKNOWN",
      durationMs: Date.now() - start,
    };
  }
};
