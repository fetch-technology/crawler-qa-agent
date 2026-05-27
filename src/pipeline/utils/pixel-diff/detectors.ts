import type { Page } from "playwright";
import { PNG } from "pngjs";
import { pixelDiff, blackRatio } from "./diff.js";
import { snapshot, snapshotRegion } from "./region.js";
import type { DetectOptions, Region, StableOptions } from "./types.js";

async function capture(page: Page, region?: Region): Promise<PNG> {
  return region ? await snapshotRegion(page, region) : await snapshot(page);
}

/**
 * Pre/post diff around an action. If diff ratio > changeThreshold the change is
 * "significant" — used for spin-started / popup-appeared / button-clicked verification.
 */
export async function diffAroundAction(
  page: Page,
  action: () => Promise<void>,
  opts: DetectOptions & { postDelayMs?: number } = {},
): Promise<{ changed: boolean; ratio: number }> {
  const before = await capture(page, opts.region);
  await action();
  await page.waitForTimeout(opts.postDelayMs ?? 300);
  const after = await capture(page, opts.region);
  const result = pixelDiff(before, after, opts);
  return { changed: result.ratio > (opts.changeThreshold ?? 0.05), ratio: result.ratio };
}

/**
 * Wait until N consecutive frames have diff < changeThreshold. Returns true if stable
 * within maxIterations, false otherwise.
 */
export async function waitUntilStable(page: Page, opts: StableOptions = {}): Promise<boolean> {
  const interval = opts.intervalMs ?? 300;
  const max = opts.maxIterations ?? 20;
  const threshold = opts.changeThreshold ?? 0.01;
  const need = opts.consecutiveStable ?? 3;

  let prev = await capture(page, opts.region);
  let stableCount = 0;

  for (let i = 0; i < max; i++) {
    await page.waitForTimeout(interval);
    const current = await capture(page, opts.region);
    if (current.width !== prev.width || current.height !== prev.height) {
      prev = current;
      stableCount = 0;
      continue;
    }
    const { ratio } = pixelDiff(prev, current, opts);
    if (ratio < threshold) {
      stableCount++;
      if (stableCount >= need) return true;
    } else {
      stableCount = 0;
    }
    prev = current;
  }
  return false;
}

/**
 * Detect freeze: N consecutive frames identical when motion expected. Returns true
 * if frozen (BAD — game stuck), false if motion present.
 */
export async function detectFreeze(
  page: Page,
  opts: StableOptions = {},
): Promise<boolean> {
  const interval = opts.intervalMs ?? 300;
  const max = opts.maxIterations ?? 5;
  const threshold = opts.changeThreshold ?? 0.001;
  let prev = await capture(page, opts.region);
  for (let i = 0; i < max; i++) {
    await page.waitForTimeout(interval);
    const current = await capture(page, opts.region);
    if (current.width !== prev.width || current.height !== prev.height) {
      return false;
    }
    const { ratio } = pixelDiff(prev, current, opts);
    if (ratio > threshold) return false;
    prev = current;
  }
  return true;
}

/**
 * Black-screen detector: fraction of dark pixels > threshold. Used to detect
 * post-spin crashes or asset-load failures.
 */
export async function detectBlackScreen(
  page: Page,
  blackThreshold = 0.95,
  region?: Region,
): Promise<{ black: boolean; ratio: number }> {
  const png = await capture(page, region);
  const ratio = blackRatio(png);
  return { black: ratio >= blackThreshold, ratio };
}

/**
 * One-shot diff between snapshot and a baseline PNG buffer. Used by validate-registry.
 */
export async function diffVsBaseline(
  page: Page,
  baseline: Buffer | PNG,
  region: Region,
  opts: DetectOptions = {},
): Promise<{ ratio: number; changed: boolean }> {
  const current = await snapshotRegion(page, region);
  const base = baseline instanceof PNG ? baseline : PNG.sync.read(baseline);
  if (base.width !== current.width || base.height !== current.height) {
    return { ratio: 1, changed: true };
  }
  const { ratio } = pixelDiff(base, current, opts);
  return { ratio, changed: ratio > (opts.changeThreshold ?? 0.05) };
}
