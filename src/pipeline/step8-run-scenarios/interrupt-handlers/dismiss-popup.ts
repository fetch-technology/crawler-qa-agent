// Generic popup dismiss handler — works for paytable/autoplay/history/etc.
// Tries: ESC × 2 → click viewport corner (5,5) → wait. Falls back to
// clicking a known closeButton from registry (e.g., paytableButton__closeButton).
import type { HandlerContext, HandlerOutcome, InterruptHandler } from "./types.js";

export function makeDismissPopupHandler(handlerName: string, closeKeyHint?: string): InterruptHandler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const start = Date.now();
    try {
      // 1. Try registry closeButton if hint provided
      if (closeKeyHint && ctx.uiMap[closeKeyHint]) {
        const el = ctx.uiMap[closeKeyHint];
        await ctx.page.mouse.click(el.x, el.y);
        await ctx.page.waitForTimeout(1200);
      }
      // 2. ESC × 2 fallback
      await ctx.page.keyboard.press("Escape").catch(() => undefined);
      await ctx.page.waitForTimeout(300);
      await ctx.page.keyboard.press("Escape").catch(() => undefined);
      await ctx.page.waitForTimeout(300);
      // 3. Click corner to drop overlay
      await ctx.page.mouse.click(5, 5).catch(() => undefined);
      await ctx.page.waitForTimeout(1200);
      return {
        handler: handlerName,
        ok: true,
        summary: closeKeyHint ? `dismissed via ${closeKeyHint} + ESC` : "dismissed via ESC + corner click",
        finalState: "MAIN",
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        handler: handlerName,
        ok: false,
        summary: `error: ${err instanceof Error ? err.message : String(err)}`,
        finalState: "UNKNOWN",
        durationMs: Date.now() - start,
      };
    }
  };
}
