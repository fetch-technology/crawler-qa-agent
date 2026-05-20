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

  // Layer 2 + 3: canvas visible + painted
  while (Date.now() - start < timeoutMs) {
    const info = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll("canvas"));
      // Pick canvas lớn nhất visible
      const visible = canvases
        .map((c) => {
          const rect = c.getBoundingClientRect();
          return { c, rect, area: rect.width * rect.height };
        })
        .filter((x) => x.area > 10_000)
        .sort((a, b) => b.area - a.area)[0];
      if (!visible) return null;

      // Sample painted pixels — check canvas có content, không phải solid color
      try {
        const ctx = (visible.c as HTMLCanvasElement).getContext("2d");
        if (!ctx) {
          // WebGL canvas — không readPixels được từ 2d ctx. Assume painted nếu visible.
          return {
            width: visible.rect.width,
            height: visible.rect.height,
            nonBlankPx: -1, // sentinel: WebGL, không check được
          };
        }
        const w = Math.min(100, visible.c.width);
        const h = Math.min(100, visible.c.height);
        const sample = ctx.getImageData(0, 0, w, h).data;
        // Count pixels khác base color (>5% variance)
        const baseR = sample[0]!;
        const baseG = sample[1]!;
        const baseB = sample[2]!;
        let nonBlank = 0;
        for (let i = 0; i < sample.length; i += 16) {
          const dr = Math.abs(sample[i]! - baseR);
          const dg = Math.abs(sample[i + 1]! - baseG);
          const db = Math.abs(sample[i + 2]! - baseB);
          if (dr + dg + db > 30) nonBlank++;
        }
        return {
          width: visible.rect.width,
          height: visible.rect.height,
          nonBlankPx: nonBlank,
        };
      } catch {
        return {
          width: visible.rect.width,
          height: visible.rect.height,
          nonBlankPx: -1,
        };
      }
    });

    if (info && info.width >= 200 && info.height >= 200) {
      layer = "canvas-visible";
      // Nếu là WebGL (nonBlankPx=-1) hoặc đã có content → enter stability phase
      if (info.nonBlankPx === -1 || info.nonBlankPx > 50) {
        layer = "canvas-painted";
        // Stability check: loading screen có animation (progress bar) → screenshot
        // hash thay đổi liên tục. Play screen idle → mostly static.
        const stable = await waitForCanvasStable(page, {
          timeoutMs: Math.max(5_000, timeoutMs - (Date.now() - start)),
          samplePeriodMs: 800,
          requiredSamples: 4,
          maxDiffRatio: 0.005,
        });
        if (stable) {
          return {
            ready: true,
            layer: "canvas-stable",
            durationMs: Date.now() - start,
            canvasInfo: info,
          };
        }
      }
    }

    await page.waitForTimeout(pollMs);
  }

  return { ready: false, layer, durationMs: Date.now() - start };
}

/**
 * Sample canvas hash mỗi samplePeriodMs. Ready khi `requiredSamples` consecutive
 * sample khớp (pixel diff < maxDiffRatio). Loading animation → fail samples.
 * Play screen idle (reels stopped) → pass.
 *
 * Trả false nếu hết timeoutMs mà chưa stable.
 */
async function waitForCanvasStable(
  page: Page,
  opts: {
    timeoutMs: number;
    samplePeriodMs: number;
    requiredSamples: number;
    maxDiffRatio: number;
  },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  const recent: string[] = [];

  while (Date.now() < deadline) {
    const hash = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll("canvas"));
      const visible = canvases
        .map((c) => ({ c, area: c.clientWidth * c.clientHeight }))
        .filter((x) => x.area > 10_000)
        .sort((a, b) => b.area - a.area)[0];
      if (!visible) return "";
      try {
        const ctx = (visible.c as HTMLCanvasElement).getContext("2d");
        if (ctx) {
          // 2D canvas — sample 32x32 grid
          const w = visible.c.width;
          const h = visible.c.height;
          const data = ctx.getImageData(0, 0, Math.min(200, w), Math.min(200, h)).data;
          // Compress to digest: average per 16x16 cell
          let s = "";
          for (let i = 0; i < data.length; i += 256) {
            s += String.fromCharCode(data[i]! & 0xfe);
          }
          return s;
        }
        // WebGL canvas — dùng toDataURL sample (slow nhưng accurate)
        return (visible.c as HTMLCanvasElement).toDataURL("image/png", 0.1).slice(0, 5000);
      } catch {
        return "";
      }
    });

    if (!hash) {
      await page.waitForTimeout(opts.samplePeriodMs);
      continue;
    }

    recent.push(hash);
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
