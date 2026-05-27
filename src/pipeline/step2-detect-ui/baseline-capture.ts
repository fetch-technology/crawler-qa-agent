import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";
import { snapshotRegion, regionAround } from "../utils/pixel-diff/index.js";

const DEFAULT_SIZE = 80;

/**
 * For each detected UI element, capture a tight region around (x,y) and persist as
 * baseline PNG. validate-registry later pixel-diffs cached baseline vs live state
 * to detect UI drift (game version update moved buttons, etc.)
 */
export async function captureBaselines(
  page: Page,
  gameSlug: string,
  uiMap: UiRegistry,
  size = DEFAULT_SIZE,
): Promise<UiRegistry> {
  const baseDir = path.join(dirForGame(gameSlug), "baselines");
  await mkdir(baseDir, { recursive: true });

  const updated: UiRegistry = { ...uiMap };
  for (const [key, el] of Object.entries(uiMap)) {
    if (!el) continue;
    const region = regionAround(el.x, el.y, size, size);
    const png = await snapshotRegion(page, region);
    const fileName = `${key}.png`;
    await writeFile(path.join(baseDir, fileName), PNG.sync.write(png));
    updated[key] = { ...el, baselineScreenshot: fileName };
  }
  return updated;
}
