import type { Page } from "playwright";
import { PNG } from "pngjs";
import { decodePng, cropRegion } from "./diff.js";
import type { Region } from "./types.js";

export async function snapshot(page: Page): Promise<PNG> {
  const buf = await page.screenshot({ type: "png" });
  return decodePng(buf);
}

export async function snapshotRegion(page: Page, region: Region): Promise<PNG> {
  const buf = await page.screenshot({
    type: "png",
    clip: { x: region.x, y: region.y, width: region.width, height: region.height },
  });
  return decodePng(buf);
}

export function regionAround(
  centerX: number,
  centerY: number,
  width = 80,
  height = 80,
): Region {
  return {
    x: Math.max(0, Math.round(centerX - width / 2)),
    y: Math.max(0, Math.round(centerY - height / 2)),
    width,
    height,
  };
}

export { cropRegion };
