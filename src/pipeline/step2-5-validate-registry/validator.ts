import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { UiRegistry, ValidationResult } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";
import { diffVsBaseline, regionAround } from "../utils/pixel-diff/index.js";

const TOLERANCE = 0.15;

export type ValidateOptions = {
  /** Game slug used to resolve baseline paths. Pass null to skip baseline pixel-diff. */
  gameSlug?: string | null;
  /** Per-pixel sensitivity. Default 0.1. */
  pixelThreshold?: number;
  /** Region size around cached (x,y) coord. Default 80x80. */
  regionSize?: number;
};

/**
 * Validate cached UI registry against current live game state.
 *
 * Two checks:
 *   1. Required elements present (currently: spinButton).
 *   2. For each element with a baselineScreenshot path: capture the same region
 *      from the live page and pixel-diff against the saved baseline. If the
 *      diff exceeds TOLERANCE, mark that element invalid.
 */
export async function validateRegistry(
  page: Page,
  uiMap: UiRegistry | null,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  if (!uiMap || !uiMap.spinButton) {
    return { ok: false, invalidEntries: ["spinButton"], reason: "missing spinButton" };
  }

  const invalid: string[] = [];
  const reasons: string[] = [];

  if (opts.gameSlug) {
    const baseDir = path.join(dirForGame(opts.gameSlug), "baselines");
    for (const [key, el] of Object.entries(uiMap)) {
      if (!el?.baselineScreenshot) continue;
      const baselinePath = path.isAbsolute(el.baselineScreenshot)
        ? el.baselineScreenshot
        : path.join(baseDir, el.baselineScreenshot);
      let baseline: Buffer;
      try {
        baseline = await readFile(baselinePath);
      } catch {
        continue;
      }
      const size = opts.regionSize ?? 80;
      const region = regionAround(el.x, el.y, size, size);
      try {
        const { ratio, changed } = await diffVsBaseline(page, baseline, region, {
          pixelThreshold: opts.pixelThreshold ?? 0.1,
          changeThreshold: TOLERANCE,
        });
        if (changed) {
          invalid.push(key);
          reasons.push(`${key}: diff ratio ${ratio.toFixed(3)} > ${TOLERANCE}`);
        }
      } catch (err) {
        // Corrupt baseline file — skip validation for this entry; coord is still
        // usable. Caller can regenerate baselines via captureBaselines.
        console.warn(`[validate-registry] baseline ${key} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (invalid.length === 0) {
    return { ok: true, invalidEntries: [] };
  }
  return { ok: false, invalidEntries: invalid, reason: reasons.join("; ") };
}
