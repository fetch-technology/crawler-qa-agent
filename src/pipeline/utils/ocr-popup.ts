// OCR-based popup detection + auto-dismiss. Uses tesseract.js (deterministic,
// no AI). Detects common interstitial popup keywords ("PRESS ANYWHERE",
// "CONTINUE", "CONGRATULATIONS", etc.), clicks viewport center to dismiss,
// re-checks until cleared or max attempts reached.
//
// Note: Tesseract first-call downloads ~10MB English language data — cold
// start ~5-15s. Subsequent calls in same process ~1-2s per OCR pass.

import type { Page } from "playwright";

// Lazy import of tesseract.js — avoid 30MB import cost when feature not used.
let worker: import("tesseract.js").Worker | null = null;

async function getWorker(): Promise<import("tesseract.js").Worker> {
  if (worker) return worker;
  const { createWorker } = await import("tesseract.js");
  worker = await createWorker("eng");
  return worker;
}

/**
 * OCR a specific region of the page (vs full viewport). Cheaper than
 * full-screen OCR + dramatically less noise — region content is the only
 * text Tesseract sees. Used for stable-region readings like balance/win
 * widgets where the surrounding game art / animations cause flaky output
 * if OCRed wholesale.
 *
 * Returns the cropped PNG buffer alongside the OCR text so callers can
 * persist it as evidence (case-executor saves per-region PNGs for the
 * dashboard "OCR Evidence" panel — QA sees the exact pixels Tesseract
 * was looking at, helps spot when bbox is mis-aligned or covered by an
 * animation).
 */
export async function ocrRegion(
  page: import("playwright").Page,
  region: { x: number; y: number; w: number; h: number },
): Promise<{ text: string; durationMs: number; imageBuf: Buffer }> {
  const start = Date.now();
  const imageBuf = await page.screenshot({
    type: "png",
    clip: { x: region.x, y: region.y, width: region.w, height: region.h },
  });
  const w = await getWorker();
  const result = await w.recognize(imageBuf);
  return {
    text: (result.data.text ?? "").trim(),
    durationMs: Date.now() - start,
    imageBuf,
  };
}

/**
 * Parse a numeric value from OCR'd text. Strips currency symbols, commas,
 * spaces. Returns null if no number found.
 *
 * Tesseract artifacts handled:
 *   - Currency: `$`, `€`, `£`, `¥`, `₫` stripped
 *   - Thousand separators: `,` and `;` stripped. (`;` is a common mis-OCR of
 *     the thousands `,` — a comma with a stray dot — e.g. `$99,996;103.04`.
 *     Without this the regex stops at the `;` → reads 99996 instead of
 *     99996103.04.)
 *   - Whitespace: stripped
 *   - Colon mis-OCR of decimal point: `99,998,033:29` → `.29` (common on
 *     small fonts where Tesseract reads "." as ":")
 *   - Apostrophe mis-OCR (some Swiss locales use ' as thousand sep)
 */
export function parseNumericFromOcr(text: string): number | null {
  if (!text) return null;
  const cleaned = text
    .replace(/[\s,;'$€£¥₫]/g, "")
    .replace(/:/g, ".");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

export async function terminateOcr(): Promise<void> {
  if (worker) {
    await worker.terminate().catch(() => undefined);
    worker = null;
  }
}

/** Keywords that indicate a dismissable interstitial popup. */
export const POPUP_KEYWORDS = [
  "press anywhere",
  "to continue",
  "click to continue",
  "tap to continue",
  "congratulations",
  "you have won",
  "you won",
  "you've won",
  "free spins",
  "big win",
  "huge win",
  "mega win",
  "max win",
  "bonus complete",
];

/** Keywords found on common sub-state popups (paytable / buy / settings / etc).
 *  Detected to flag "not on main" but NOT auto-dismissed (QA may want to
 *  inspect; explicit close-button click required). */
/**
 * Pure keyword matcher — no OCR, no Page dependency. Lowercases haystack +
 * each keyword, returns the list of matched keywords. Used by invariant
 * tests + by detectAnyPopup at runtime (which calls this on OCR'd text).
 */
export function matchPopupKeywords(
  text: string,
  keywords: ReadonlyArray<string>,
): string[] {
  const haystack = text.toLowerCase();
  return keywords.filter((k) => haystack.includes(k.toLowerCase()));
}

// Result / summary banners shown ON the MAIN screen after a feature ENDS.
// They contain popup-ish words ("free spins", "win") but the game is back on
// main + playable — NOT a blocking popup. e.g. "FREE SPINS COMPLETED".
export const ON_MAIN_RESULT_PHRASES = [
  "free spins completed",
  "free spins complete",
  "free spin completed",
  "spins completed",
  "feature completed",
  "feature complete",
  "free spins finished",
  "free spins over",
];

// "Blocking affordance" phrases — when present it IS a real interstitial popup
// that must be dismissed, even if a result phrase coexists.
const BLOCKING_AFFORDANCE_PHRASES = [
  "press anywhere",
  "tap anywhere",
  "to continue",
  "click to continue",
  "tap to continue",
];

// Generic interstitial keywords that a result banner can falsely trip.
const BANNER_TRIGGER_KEYWORDS = new Set(
  ["free spins", "you won", "you have won", "you've won", "congratulations", "big win", "huge win", "mega win", "max win"].map((k) => k.toLowerCase()),
);

/**
 * Drop interstitial keyword matches that are actually caused by a MAIN-SCREEN
 * result banner (e.g. "FREE SPINS COMPLETED"). When a completion phrase is
 * present AND there's no real blocking affordance ("press anywhere" / "to
 * continue"), the generic banner-trigger keywords are false positives → remove
 * them. Pure; exercised by invariant tests.
 */
export function suppressResultBannerMatches(text: string, matches: string[]): string[] {
  const t = text.toLowerCase();
  const hasResultBanner = ON_MAIN_RESULT_PHRASES.some((p) => t.includes(p));
  if (!hasResultBanner) return matches;
  const hasBlocking = BLOCKING_AFFORDANCE_PHRASES.some((p) => t.includes(p));
  if (hasBlocking) return matches; // genuine popup despite the result text
  return matches.filter((m) => !BANNER_TRIGGER_KEYWORDS.has(m.toLowerCase()));
}

/**
 * True when matched popup keywords indicate an ACTIVE free-spin chain (FS
 * counter / spins in progress) rather than a dismissable popup — i.e. a
 * "free spin" keyword matched but NO "press anywhere" / "continue" dismiss
 * affordance. An active chain CANNOT be dismissed (ESC/click won't stop it) —
 * it must be waited out. Pure; exercised by invariant tests.
 */
export function isFreeSpinChainActive(matchedKeywords: ReadonlyArray<string>): boolean {
  const hasFs = matchedKeywords.some((k) => k.toLowerCase().includes("free spin"));
  const hasDismiss = matchedKeywords.some((k) => /press anywhere|continue/i.test(k));
  return hasFs && !hasDismiss;
}

export const SUBSTATE_POPUP_KEYWORDS = [
  "paytable",
  "pay table",
  "buy feature",
  "buy bonus",
  "buy free spins",
  "purchase",
  "history",
  "settings",
  "autoplay",
  "auto play",
  "number of spins",
  "loss limit",
  "single win limit",
  "rules",
  "game info",
  "how to play",
];

/**
 * Scan current screenshot for any popup signal — both interstitial popups
 * (which are dismissable by clicking) AND sub-state popups (paytable, buy
 * feature, etc.) which need an explicit close. Used by ensure-main pre-flight
 * to decide whether to recover before running a case.
 */
export async function detectAnyPopup(
  page: Page,
  opts: {
    /** Override default interstitial keyword list (Phase 7.1C per-game). */
    interstitialKeywords?: ReadonlyArray<string>;
    /** Override default substate keyword list. */
    substateKeywords?: ReadonlyArray<string>;
    /** Reuse a buffer already captured by the caller — skips the screenshot. */
    sharedScreenshot?: Buffer;
  } = {},
): Promise<{
  hasPopup: boolean;
  interstitial: boolean;
  substate: boolean;
  matchedKeywords: string[];
  detectedText: string;
  durationMs: number;
  /** PNG buffer used for this scan. Callers can pass to detectDarkOverlay
   *  via `sharedScreenshot` to avoid a second page.screenshot() call —
   *  in headed mode each screenshot forces a browser repaint → flicker. */
  screenshot: Buffer;
}> {
  const start = Date.now();
  const interstitial = opts.interstitialKeywords ?? POPUP_KEYWORDS;
  const substate = opts.substateKeywords ?? SUBSTATE_POPUP_KEYWORDS;
  const buf = opts.sharedScreenshot ?? await page.screenshot({ type: "png", fullPage: false });
  const w = await getWorker();
  const result = await w.recognize(buf);
  const text = (result.data.text ?? "").toLowerCase();
  // Suppress interstitial false positives from main-screen result banners
  // ("FREE SPINS COMPLETED" etc.) so ensure-main doesn't loop forever trying
  // to dismiss a non-existent popup.
  const interstitialMatches = suppressResultBannerMatches(text, interstitial.filter((k) => text.includes(k)));
  const substateMatches = substate.filter((k) => text.includes(k));
  return {
    hasPopup: interstitialMatches.length > 0 || substateMatches.length > 0,
    interstitial: interstitialMatches.length > 0,
    substate: substateMatches.length > 0,
    matchedKeywords: [...interstitialMatches, ...substateMatches],
    detectedText: text.trim().slice(0, 400),
    durationMs: Date.now() - start,
    screenshot: buf,
  };
}

/**
 * Layer 2 of "on main?" check: sample pixels from the 4 viewport corners to
 * detect a semi-transparent dark overlay (typical popup dimmer). If 3+ of 4
 * corners are noticeably darker than the configured baseline brightness,
 * something is overlaying the play area.
 *
 * Heuristic, no baseline file required — assumes a slot game's main screen
 * has bright/colorful corners (UI chrome, background art), so a dim corner
 * usually means popup overlay.
 */
export async function detectDarkOverlay(
  page: Page,
  opts: { sampleSize?: number; darknessThreshold?: number; minCornersDark?: number; sharedScreenshot?: Buffer } = {},
): Promise<{ overlayPresent: boolean; cornerBrightness: number[]; durationMs: number }> {
  const start = Date.now();
  const sampleSize = opts.sampleSize ?? 80;
  const darknessThreshold = opts.darknessThreshold ?? 60; // 0-255 avg channel
  const minCornersDark = opts.minCornersDark ?? 3;
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };

  // Take ONE full screenshot, crop in memory for all 4 corners. Headed mode
  // page.screenshot forces browser repaint → previously 4 screenshots caused
  // visible flicker. Callers can also pass `sharedScreenshot` to reuse a
  // screenshot already captured (e.g., from preceding OCR call) — eliminates
  // even this 1 screenshot.
  const { PNG } = await import("pngjs");
  const buf = opts.sharedScreenshot ?? await page.screenshot({ type: "png", fullPage: false });
  const png = PNG.sync.read(buf);

  const corners = [
    { x: 0, y: 0 },                                  // TL
    { x: png.width - sampleSize, y: 0 },             // TR
    { x: 0, y: png.height - sampleSize },            // BL
    { x: png.width - sampleSize, y: png.height - sampleSize }, // BR
  ];
  const brightness: number[] = [];
  for (const c of corners) {
    let total = 0;
    let count = 0;
    for (let dy = 0; dy < sampleSize; dy++) {
      for (let dx = 0; dx < sampleSize; dx++) {
        const px = c.x + dx;
        const py = c.y + dy;
        if (px < 0 || px >= png.width || py < 0 || py >= png.height) continue;
        const idx = (py * png.width + px) * 4;
        total += (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3;
        count++;
      }
    }
    brightness.push(count > 0 ? total / count : 0);
  }
  void vp; // viewport hint retained for API back-compat
  const darkCount = brightness.filter((b) => b < darknessThreshold).length;
  return {
    overlayPresent: darkCount >= minCornersDark,
    cornerBrightness: brightness.map((b) => Math.round(b)),
    durationMs: Date.now() - start,
  };
}

export type DetectResult = {
  hasPopup: boolean;
  detectedText: string;
  matchedKeywords: string[];
  durationMs: number;
};

/**
 * Run OCR on current page screenshot. Returns detected text + which popup
 * keywords matched (case-insensitive).
 */
export async function detectPopup(page: Page): Promise<DetectResult> {
  const start = Date.now();
  const buf = await page.screenshot({ type: "png", fullPage: false });
  const w = await getWorker();
  const result = await w.recognize(buf);
  const text = (result.data.text ?? "").toLowerCase();
  const matched = suppressResultBannerMatches(text, POPUP_KEYWORDS.filter((k) => text.includes(k)));
  return {
    hasPopup: matched.length > 0,
    detectedText: text.trim().slice(0, 400),
    matchedKeywords: matched,
    durationMs: Date.now() - start,
  };
}

/**
 * Detect + auto-dismiss popups. Up to maxAttempts (default 5):
 *   1. OCR current screen
 *   2. If popup keywords detected → click center 2x, wait 800ms each
 *   3. Re-OCR; if still detected → repeat
 *   4. Exit when no popup OR maxAttempts reached
 *
 * Returns final state. ok=true if no popup remains.
 */
export async function dismissPopupsLoop(
  page: Page,
  opts: { maxAttempts?: number; interClickMs?: number } = {},
): Promise<{ ok: boolean; attempts: number; finalDetect: DetectResult; trace: DetectResult[] }> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const interClickMs = opts.interClickMs ?? 800;
  const trace: DetectResult[] = [];
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = Math.round(vp.width / 2);
  const cy = Math.round(vp.height / 2);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const det = await detectPopup(page);
    trace.push(det);
    console.log(`[ocr/popup-detect] attempt ${attempt}: hasPopup=${det.hasPopup} matched=[${det.matchedKeywords.join(",")}] ms=${det.durationMs}`);
    if (!det.hasPopup) {
      return { ok: true, attempts: attempt, finalDetect: det, trace };
    }
    // Dismiss: click center twice with gap
    try {
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(interClickMs);
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(interClickMs);
    } catch {
      break;
    }
  }
  const final = trace[trace.length - 1]!;
  return { ok: !final.hasPopup, attempts: maxAttempts, finalDetect: final, trace };
}
