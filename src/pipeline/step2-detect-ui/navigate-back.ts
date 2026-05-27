// Best-effort "navigate back" — try multiple strategies to return to a known
// state after exploring a popup. ESC → click X area → click outside-popup area.

import type { Page } from "playwright";
import type { PNG } from "pngjs";
import { snapshot } from "../utils/pixel-diff/index.js";
import { pixelDiff } from "../utils/pixel-diff/diff.js";

const CLOSE_HOTSPOTS = [
  { x: 1820, y: 80, label: "top-right-X" },
  { x: 1700, y: 80, label: "alt-X" },
  { x: 100, y: 100, label: "outside-top-left" },
  { x: 960, y: 50, label: "top-center-back" },
];

const RETURN_MATCH_THRESHOLD = 0.04;

export async function navigateBackTo(
  page: Page,
  expectedBaseline: PNG,
  knownCloseElement?: { x: number; y: number },
): Promise<{ returned: boolean; method: string }> {
  // 1) Try ESC
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const now = await snapshot(page);
    if (matches(expectedBaseline, now)) return { returned: true, method: "esc" };
  } catch {
    // ignore
  }

  // 2) Try known close element if provided
  if (knownCloseElement) {
    try {
      await page.mouse.click(knownCloseElement.x, knownCloseElement.y);
      await page.waitForTimeout(800);
      const now = await snapshot(page);
      if (matches(expectedBaseline, now)) {
        return { returned: true, method: `close-element(${knownCloseElement.x},${knownCloseElement.y})` };
      }
    } catch {
      // ignore
    }
  }

  // 3) Try hotspot clicks
  for (const c of CLOSE_HOTSPOTS) {
    try {
      await page.mouse.click(c.x, c.y);
      await page.waitForTimeout(600);
      const now = await snapshot(page);
      if (matches(expectedBaseline, now)) {
        return { returned: true, method: `hotspot:${c.label}` };
      }
    } catch {
      // ignore
    }
  }

  return { returned: false, method: "exhausted" };
}

function matches(a: PNG, b: PNG): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const { ratio } = pixelDiff(a, b);
  return ratio < RETURN_MATCH_THRESHOLD;
}
