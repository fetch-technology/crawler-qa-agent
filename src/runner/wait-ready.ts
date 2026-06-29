/**
 * Pure-deterministic readiness wait — không cần LLM, không cần baseline snapshot.
 *
 * Heuristic 4 layer (tăng dần mức tin cậy):
 *   1. networkidle — không có request mới trong 500ms
 *   2. Visible <canvas> với non-zero size
 *   3. Canvas có pixel content (không phải solid color như loading bg)
 *   4. (optional) Click probe — click thử vùng spin button, watch xem có request fire
 *
 * Use case: thay thế `await page.waitForTimeout(2500)` mơ hồ trong deterministic
 * test. Quan trọng cho game canvas vì DOM events không tin được — game render
 * vào single <canvas>, không có "play screen ready" DOM signal.
 */

import type { Page } from "playwright";

export type WaitReadyOpts = {
  /** Max ms để đợi tất cả layer. Default 30s. */
  timeoutMs?: number;
  /** Bỏ qua networkidle (game vẫn streaming asset → networkidle không bao giờ đạt). */
  skipNetworkIdle?: boolean;
  /** Polling interval giữa các check. Default 250ms. */
  pollMs?: number;
};

export type WaitReadyResult = {
  ready: boolean;
  /** Layer cuối cùng pass. */
  layer:
    | "networkidle"
    | "canvas-visible"
    | "canvas-painted"
    | "canvas-stable"
    | "timeout";
  durationMs: number;
  canvasInfo?: { width: number; height: number; nonBlankPx: number };
};

/**
 * Đợi tới khi game canvas đã render. Throw nếu timeout.
 */
export async function waitForCanvasReady(
  page: Page,
  opts: WaitReadyOpts = {},
): Promise<WaitReadyResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const start = Date.now();
  let layer: WaitReadyResult["layer"] = "timeout";

  // Layer 1: networkidle. Vì asset load có thể không bao giờ idle (streaming
  // audio/sprite), tolerate nếu timeout — vẫn tiếp tục check canvas.
  if (!opts.skipNetworkIdle) {
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) });
      layer = "networkidle";
    } catch {
      // không sao — game có thể vẫn ổn dù không idle
    }
  }

  // CRITICAL: NEVER call canvas.getContext() on a game canvas here. A canvas
  // can hold only ONE context type; if we grab "2d" to read pixels before the
  // game engine (Cocos/PIXI) grabs "webgl"/"webgl2" on that SAME canvas, the
  // engine's getContext returns null → "This device does not support WebGL" →
  // crash on init, loader stuck. So readiness is geometry-only (getBoundingClientRect),
  // and the painted/stable check uses page.screenshot() of the canvas region,
  // which never touches the canvas's rendering context.
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  while (Date.now() - start < timeoutMs) {
    const box = await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll("canvas"))
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height };
        })
        .filter((x) => x.area > 10_000)
        .sort((a, b) => b.area - a.area)[0];
      return visible ?? null;
    });

    if (box && box.w >= 200 && box.h >= 200) {
      layer = "canvas-visible";
      // Clamp the clip into the viewport (screenshot rejects out-of-bounds).
      const clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.min(Math.floor(box.w), vp.width - Math.max(0, Math.floor(box.x))),
        height: Math.min(Math.floor(box.h), vp.height - Math.max(0, Math.floor(box.y))),
      };
      if (clip.width >= 100 && clip.height >= 100) {
        // Stability: a loading screen animates (progress bar) → screenshots
        // keep changing; the play screen idle → screenshots stabilize.
        const stable = await waitForCanvasStable(page, {
          clip,
          timeoutMs: Math.max(5_000, timeoutMs - (Date.now() - start)),
          samplePeriodMs: 800,
          requiredSamples: 4,
          maxDiffRatio: 0.02,
        });
        if (stable) {
          return {
            ready: true,
            layer: "canvas-stable",
            durationMs: Date.now() - start,
            canvasInfo: { width: box.w, height: box.h, nonBlankPx: -1 },
          };
        }
      }
    }

    await page.waitForTimeout(pollMs);
  }

  return { ready: false, layer, durationMs: Date.now() - start };
}

/** Coarse digest of a screenshot PNG buffer — samples bytes so big visual
 *  changes (loading animation) diverge while tiny noise stays similar. */
function bufDigest(buf: Buffer): string {
  let s = "";
  for (let i = 0; i < buf.length; i += 397) s += String.fromCharCode(buf[i]! & 0xfe);
  return s;
}

/**
 * Sample a SCREENSHOT of the canvas region every samplePeriodMs (never touches
 * the canvas context — see waitForCanvasReady note). Ready when `requiredSamples`
 * consecutive screenshots are similar (diff < maxDiffRatio). Loading animation →
 * fails; idle play screen → passes. Returns false on timeout.
 */
async function waitForCanvasStable(
  page: Page,
  opts: {
    clip: { x: number; y: number; width: number; height: number };
    timeoutMs: number;
    samplePeriodMs: number;
    requiredSamples: number;
    maxDiffRatio: number;
  },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const recent: string[] = [];

  while (Date.now() < deadline) {
    let digest = "";
    try {
      const buf = await page.screenshot({ clip: opts.clip });
      digest = bufDigest(buf);
    } catch {
      // page navigated / clip transiently invalid — skip this sample
    }

    if (!digest) {
      await page.waitForTimeout(opts.samplePeriodMs);
      continue;
    }

    recent.push(digest);
    if (recent.length > opts.requiredSamples) recent.shift();

    if (recent.length === opts.requiredSamples) {
      const ref = recent[0]!;
      const allSimilar = recent.every((h) => stringSimilarity(h, ref) > 1 - opts.maxDiffRatio);
      if (allSimilar) return true;
    }

    await page.waitForTimeout(opts.samplePeriodMs);
  }
  return false;
}

function stringSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let same = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / Math.max(a.length, b.length);
}
