import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { DiffOptions, DiffResult, Region } from "./types.js";

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * Crop a PNG to a region. Returns a NEW PNG. Region coordinates clamp to image bounds.
 */
export function cropRegion(src: PNG, region: Region): PNG {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const w = Math.min(src.width - x, Math.floor(region.width));
  const h = Math.min(src.height - y, Math.floor(region.height));
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcIdx = ((y + row) * src.width + x) * 4;
    const dstIdx = row * w * 4;
    src.data.copy(out.data, dstIdx, srcIdx, srcIdx + w * 4);
  }
  return out;
}

/**
 * Compare two PNGs of identical dimensions (or crop both to a shared region first).
 */
export function pixelDiff(a: PNG, b: PNG, opts: DiffOptions = {}): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `pixelDiff: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    );
  }
  const total = a.width * a.height;
  const diffBuf = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diffBuf.data, a.width, a.height, {
    threshold: opts.pixelThreshold ?? 0.1,
  });
  return {
    width: a.width,
    height: a.height,
    diffPixels,
    totalPixels: total,
    ratio: diffPixels / total,
  };
}

/**
 * % pixels considered "black" (R<threshold, G<threshold, B<threshold). Useful for
 * detecting black-screen crashes after spin.
 */
export function blackRatio(png: PNG, threshold = 16): number {
  let blackCount = 0;
  const data = png.data;
  const total = png.width * png.height;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < threshold && data[i + 1]! < threshold && data[i + 2]! < threshold) {
      blackCount++;
    }
  }
  return blackCount / total;
}
