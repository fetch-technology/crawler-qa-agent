import type { Page } from "playwright";
import type { StrategyResult } from "./types.js";

const SPIN_SELECTORS = [
  "#spin",
  ".spin-button",
  "[data-testid='spin']",
  "button:has-text('Spin')",
];

export async function tryDom(page: Page, elementKind: string): Promise<StrategyResult> {
  if (elementKind !== "spinButton") return { found: false };
  for (const selector of SPIN_SELECTORS) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      const box = await locator.first().boundingBox().catch(() => null);
      if (box) {
        return {
          found: true,
          element: {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
            strategy: "dom",
            confidence: 1,
            selector,
            detectedAt: new Date().toISOString(),
          },
        };
      }
    }
  }
  return { found: false };
}
