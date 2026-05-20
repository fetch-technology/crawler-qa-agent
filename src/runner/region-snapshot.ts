/**
 * Region snapshot — thay thế LLM vision cho việc "đọc state ổn định" từ canvas.
 *
 * Khi nào dùng:
 *   - Verify "spin button đang visible ở vị trí cũ"
 *   - Verify "bonus screen đã xuất hiện"
 *   - So 1 phần play screen với baseline đã chốt
 *
 * Khi nào KHÔNG dùng:
 *   - Vùng có animation chạy liên tục (reel quay) → freeze frame trước rồi mới snapshot
 *   - Vùng có random visual (particle, confetti) → mask hoặc skip
 *
 * Nguyên lý:
 *   - Lần đầu chạy → save PNG vào fixtures/templates/{slug}/{name}.png
 *   - Lần sau chạy → screenshot vùng tương ứng → diff pixel với baseline → fail nếu khác > threshold
 *   - Cập nhật baseline: chạy với env REGION_SNAPSHOT_UPDATE=1 (overwrite mọi snapshot)
 *
 * Không phụ thuộc external image library — dùng PNG raw từ Playwright + simple
 * pixel diff. Đủ cho canvas slot game (vùng UI ổn định, không cần SSIM phức tạp).
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Mask region — vùng "đừng so sánh" trước khi pixel-diff. Fill bằng solid
 * color trong cả baseline và actual → 0% diff bất kể content.
 *
 * Use case canvas slot games:
 *   - Reels matrix (random symbols mỗi load)
 *   - Balance / Win / Bet text (số động)
 *   - Background animation (sky, characters đi lại)
 *   - Timer / clock
 *
 * Per-slug override: fixtures/templates/{slug}/mask.json với { regions: MaskRegion[] }.
 */
export type MaskRegion = Region & {
  /** Optional label for debugging (vd "reels", "balance_display"). */
  label?: string;
};

/**
 * Default mask cho Pragmatic Play canvas slot games (viewport 1440×900).
 *   - Reels matrix (center): symbols random mỗi spin
 *   - Bottom UI bar: balance/win/bet text + autoplay counter
 */
export const DEFAULT_PP_MASK: MaskRegion[] = [
  { x: 280, y: 90, width: 880, height: 620, label: "reels" },
  { x: 0, y: 720, width: 1440, height: 180, label: "bottom_bar" },
];

/**
 * Load mask config từ fixtures/templates/{slug}/mask.json nếu có. Fallback:
 *   - PP slug (bắt đầu "vs"): DEFAULT_PP_MASK
 *   - Khác: [] (no mask)
 */
export function loadMaskRegions(slug: string): MaskRegion[] {
  const path = join(TEMPLATES_DIR, slug, "mask.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) return parsed as MaskRegion[];
      if (parsed && Array.isArray(parsed.regions)) return parsed.regions as MaskRegion[];
    } catch (err) {
      console.warn(`[mask] failed to parse ${path}: ${(err as Error).message}`);
    }
  }
  if (/^vs\d/i.test(slug)) return DEFAULT_PP_MASK;
  return [];
}

/**
 * Fill mask regions với solid color (default đen) — mutates PNG data in place.
 * Coords clip vào image boundary.
 */
export function applyMask(png: PNG, regions: MaskRegion[], rgb: [number, number, number] = [0, 0, 0]): void {
  if (regions.length === 0) return;
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.floor(r.x + r.width));
    const y1 = Math.min(png.height, Math.floor(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (png.width * y + x) << 2;
        png.data[idx] = rgb[0];
        png.data[idx + 1] = rgb[1];
        png.data[idx + 2] = rgb[2];
        png.data[idx + 3] = 255;
      }
    }
  }
}

export type RegionSnapshotOpts = {
  /** Game slug — dùng làm thư mục baseline. */
  slug: string;
  /** Tên baseline (vd "play-screen-idle", "bonus-active"). Kebab-case khuyến nghị. */
  name: string;
  /** Vùng để snapshot. Tọa độ theo viewport. */
  region: Region;
  /**
   * Tỉ lệ pixel cho phép sai khác (0.0-1.0). Default 0.02 = 2% pixel có thể lệch
   * (chấp nhận anti-aliasing, sub-pixel rendering).
   */
  maxDiffRatio?: number;
  /**
   * Threshold tuyệt đối cho 1 pixel coi như "khác" (0-255 per channel, sum 3 channel).
   * Default 30 = tolerance cho compression artifact.
   */
  pixelThreshold?: number;
  /**
   * Mask regions — vùng FILL solid color trước khi diff (loại volatile area
   * như reels random symbols, balance số động khỏi comparison). Coords relative
   * to **region** (NOT viewport). Default load từ fixtures/templates/{slug}/mask.json
   * hoặc DEFAULT_PP_MASK cho PP slug.
   */
  maskRegions?: MaskRegion[];
};

export type RegionSnapshotResult = {
  ok: boolean;
  baselinePath: string;
  actualPath: string;
  /** Tỉ lệ pixel khác (0.0-1.0). */
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  /** True nếu vừa tạo baseline (lần đầu chạy hoặc UPDATE env set). */
  created: boolean;
};

const TEMPLATES_DIR = "fixtures/templates";

export function baselinePath(slug: string, name: string): string {
  return join(TEMPLATES_DIR, slug, `${name}.png`);
}

/**
 * Capture region screenshot và so với baseline. Throw nếu vượt threshold.
 *
 * @example
 *   await assertRegionMatches(page, {
 *     slug: "fiesta-magenta",
 *     name: "spin-button-idle",
 *     region: { x: 700, y: 800, width: 80, height: 80 },
 *   });
 */
export async function assertRegionMatches(
  page: Page,
  opts: RegionSnapshotOpts,
): Promise<RegionSnapshotResult> {
  const maxDiffRatio = opts.maxDiffRatio ?? 0.02;
  const pixelThreshold = opts.pixelThreshold ?? 30;
  const baseline = baselinePath(opts.slug, opts.name);
  const update = process.env.REGION_SNAPSHOT_UPDATE === "1";

  const actual = await page.screenshot({
    clip: opts.region,
    type: "png",
  });

  if (!existsSync(baseline) || update) {
    mkdirSync(dirname(baseline), { recursive: true });
    writeFileSync(baseline, actual);
    return {
      ok: true,
      baselinePath: baseline,
      actualPath: baseline,
      diffRatio: 0,
      diffPixels: 0,
      totalPixels: opts.region.width * opts.region.height,
      created: true,
    };
  }

  const baselineBytes = readFileSync(baseline);
  // Resolve mask: explicit opts > per-slug config > PP default cho vs-slug.
  // Mask coords adjust relative to region origin nếu region.x/y > 0.
  const rawMask = opts.maskRegions ?? loadMaskRegions(opts.slug);
  const masks: MaskRegion[] = rawMask.map((m) => ({
    ...m,
    x: m.x - opts.region.x,
    y: m.y - opts.region.y,
  }));
  const diff = diffPng(baselineBytes, actual, pixelThreshold, masks);

  // Lưu actual + diff visualization vào test-results để debug
  const debugDir = join("test-results", "region-snapshots", opts.slug);
  mkdirSync(debugDir, { recursive: true });
  const actualOut = join(debugDir, `${opts.name}.actual.png`);
  writeFileSync(actualOut, actual);
  // Diff PNG (highlight pixel khác bằng đỏ) — chỉ lưu khi mismatch
  let diffOut: string | undefined;
  if (diff.diffImage) {
    diffOut = join(debugDir, `${opts.name}.diff.png`);
    writeFileSync(diffOut, diff.diffImage);
  }

  const result: RegionSnapshotResult = {
    ok: diff.ratio <= maxDiffRatio,
    baselinePath: baseline,
    actualPath: actualOut,
    diffRatio: diff.ratio,
    diffPixels: diff.diffPixels,
    totalPixels: diff.totalPixels,
    created: false,
  };

  if (!result.ok) {
    throw new Error(
      `Region snapshot mismatch: ${opts.slug}/${opts.name}\n` +
        `  diff: ${(diff.ratio * 100).toFixed(2)}% (${diff.diffPixels}/${diff.totalPixels} pixels)\n` +
        `  threshold: ${(maxDiffRatio * 100).toFixed(2)}%\n` +
        `  baseline: ${baseline}\n` +
        `  actual:   ${actualOut}\n` +
        (diffOut ? `  diff:     ${diffOut}  (red pixels = mismatch)\n` : "") +
        `  To accept new state as baseline: REGION_SNAPSHOT_UPDATE=1 playwright test`,
    );
  }
  return result;
}

/**
 * Trả về true/false không throw — dùng cho conditional check (vd "bonus screen ON yet?").
 */
export async function regionMatches(
  page: Page,
  opts: RegionSnapshotOpts,
): Promise<boolean> {
  try {
    const r = await assertRegionMatches(page, opts);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Pixel-perfect diff dùng pngjs (decode) + pixelmatch (compare). Trả về số
 * pixel khác, ratio, và một PNG visualization với pixel-khác được highlight đỏ.
 *
 * pixelmatch dùng YIQ color space để estimate perceptual difference, không phải
 * raw RGB — tolerance gần với "what human sees as different". Default
 * threshold=0.1 (0-1, càng nhỏ càng strict).
 */
function diffPng(
  baseline: Buffer,
  actual: Buffer,
  pixelThreshold: number,
  masks: MaskRegion[] = [],
): {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  diffImage: Buffer | null;
} {
  // Fast path — bytes giống hệt + no mask, skip decode
  if (masks.length === 0 && baseline.equals(actual)) {
    const w = baseline.readUInt32BE(16);
    const h = baseline.readUInt32BE(20);
    return { diffPixels: 0, totalPixels: w * h, ratio: 0, diffImage: null };
  }

  const baseImg = PNG.sync.read(baseline);
  const actImg = PNG.sync.read(actual);

  if (baseImg.width !== actImg.width || baseImg.height !== actImg.height) {
    const totalPixels = baseImg.width * baseImg.height;
    return {
      diffPixels: totalPixels,
      totalPixels,
      ratio: 1,
      diffImage: null,
    };
  }

  // Apply mask trong baseline + actual (cùng solid color) — vùng masked
  // identical sau khi fill → 0% contribution to diff.
  if (masks.length > 0) {
    applyMask(baseImg, masks);
    applyMask(actImg, masks);
  }

  const { width, height } = baseImg;
  const totalPixels = width * height;
  const diffImg = new PNG({ width, height });

  // pixelmatch threshold tiếp nhận 0-1 (YIQ). pixelThreshold của caller là
  // 0-255 raw sum → map approx về 0-1 bằng /255/3.
  const threshold = Math.min(1, Math.max(0, pixelThreshold / 765));

  const diffPixels = pixelmatch(
    baseImg.data,
    actImg.data,
    diffImg.data,
    width,
    height,
    { threshold, includeAA: false },
  );

  // Effective denominator: exclude masked area (guaranteed 0 diff there) →
  // ratio reflect REAL UI diff outside mask.
  let maskedArea = 0;
  for (const r of masks) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.floor(r.x + r.width));
    const y1 = Math.min(height, Math.floor(r.y + r.height));
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    maskedArea += w * h;
  }
  const effectivePixels = Math.max(1, totalPixels - maskedArea);

  return {
    diffPixels,
    totalPixels,
    ratio: diffPixels / effectivePixels,
    diffImage: diffPixels > 0 ? PNG.sync.write(diffImg) : null,
  };
}

/**
 * dHash 8x8 perceptual hash. KHÔNG dùng cho diff chính xác, dùng để check
 * "ảnh này có cùng nội dung tổng quát với ảnh kia không" (robust với scale,
 * brightness, minor noise).
 *
 * Use case: detect "đang ở màn hình nào" trong 1 set fingerprint đã lưu trước.
 *
 * Implementation note: dùng `crypto.createHash` để có hash ổn định, không phải
 * perceptual hash đúng nghĩa. Để perceptual hash thật cần decode PNG → grayscale
 * 9x8 → compare adjacent. Hold off implement đầy đủ tới khi có nhu cầu cụ thể.
 */
export async function pageRegionFingerprint(
  page: Page,
  region: Region,
): Promise<string> {
  const buf = await page.screenshot({ clip: region, type: "png" });
  // sha256 đoạn giữa buffer — đủ để check identical screen
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
