// Lightweight, browserless predicates shared by auto-onboard gating in
// manual-session.ts AND the disk-only eligibility checker used by the
// auto-onboard scheduler. Kept in registry/ (no Playwright / server deps) so
// the eligibility checker can import them without pulling in the heavy
// ManualSessionManager module or creating an import cycle.

import type { UiElement } from "./types.js";

// historyButton intentionally EXCLUDED — in PP-style games it lives inside the
// MENU popup (menuButton__historyButton), not on the main screen. Mirrors
// EXPECTED_UI_ELEMENTS_DEFAULTS / the dashboard LEVEL1_EXPECTED_KEYS.
export const LEVEL1_EXPECTED_KEYS = [
  "spinButton",
  "betPlus",
  "betMinus",
  "menuButton",
  "paytableButton",
  "autoButton",
  "buyBonusButton",
] as const;

/** A registry element is usable as a level-1 anchor when it has finite coords
 *  and is QA-verified. */
export function hasUsableRegistryCoord(el: UiElement | undefined): boolean {
  return !!el
    && Number.isFinite(el.x)
    && Number.isFinite(el.y)
    && el.status === "verified";
}

/** A balance/bet OCR region is usable when it has finite, positive geometry.
 *  Single source of truth — autoOnboard() and the browserless eligibility
 *  checker both reference this. */
export function isValidOcrRegion(
  r: { x?: number; y?: number; width?: number; height?: number } | null | undefined,
): boolean {
  return !!r
    && Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.width) && Number.isFinite(r.height)
    && (r.width as number) > 0 && (r.height as number) > 0;
}
