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
// Separate worker tuned for NUMERIC widgets (bet/balance/win). The shared text
// worker MUST stay general (popup keywords / error text need letters), so we
// can't globally restrict it to digits. A dedicated worker with PSM=SINGLE_LINE
// + a digit whitelist makes small number crops MUCH more reliable — vanilla
// Tesseract (PSM=AUTO, no whitelist) is flaky on tiny single-line numbers,
// returning "" or garbage on borderline crops (observed: bet "0.20" reads but
// "0.40" returns "").
let numericWorker: import("tesseract.js").Worker | null = null;

async function getWorker(): Promise<import("tesseract.js").Worker> {
  if (worker) return worker;
  const { createWorker } = await import("tesseract.js");
  worker = await createWorker("eng");
  return worker;
}

async function getNumericWorker(): Promise<import("tesseract.js").Worker> {
  if (numericWorker) return numericWorker;
  const { createWorker, PSM } = await import("tesseract.js");
  const w = await createWorker("eng");
  await w.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789.,:$€£¥₫",
  });
  numericWorker = w;
  return w;
}

/** Nearest-neighbour integer upscale of a PNG buffer. Small number crops sit
 *  below Tesseract's sweet spot; enlarging the glyphs (no new detail, but
 *  larger) markedly improves recognition. Pure + sync via pngjs. */
async function upscalePng(buf: Buffer, factor: number): Promise<Buffer> {
  if (factor <= 1) return buf;
  const mod = await import("pngjs");
  const PNG = (mod as { PNG?: typeof import("pngjs").PNG }).PNG
    ?? (mod as { default?: { PNG: typeof import("pngjs").PNG } }).default!.PNG;
  const src = PNG.sync.read(buf);
  const f = Math.round(factor);
  const dst = new PNG({ width: src.width * f, height: src.height * f });
  for (let y = 0; y < dst.height; y++) {
    const sy = Math.floor(y / f);
    for (let x = 0; x < dst.width; x++) {
      const sx = Math.floor(x / f);
      const si = (sy * src.width + sx) << 2;
      const di = (y * dst.width + x) << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(dst);
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
  opts: { numeric?: boolean } = {},
): Promise<{ text: string; durationMs: number; imageBuf: Buffer }> {
  const start = Date.now();
  const raw = await page.screenshot({
    type: "png",
    clip: { x: region.x, y: region.y, width: region.w, height: region.h },
  });
  // Upscale small crops (target ~120px tall, 2–4×) — vanilla Tesseract is
  // unreliable on tiny glyphs. Falls back to the raw buffer if upscale fails.
  const factor = Math.max(1, Math.min(4, Math.round(120 / Math.max(1, region.h))));
  let imageBuf = raw;
  if (factor > 1) {
    try { imageBuf = await upscalePng(raw, factor); } catch { imageBuf = raw; }
  }
  // Numeric widgets use the digit-whitelisted single-line worker; everything
  // else (popup keywords, error/paytable text) uses the general text worker.
  const w = opts.numeric ? await getNumericWorker() : await getWorker();
  const result = await w.recognize(imageBuf);
  return {
    text: (result.data.text ?? "").trim(),
    durationMs: Date.now() - start,
    imageBuf,
  };
}

/**
 * OCR an already-captured PNG buffer (no Playwright page involved). Used
 * by the OCR-region auto-detector to ground-truth AI's `value_read` claim:
 * vision models can hallucinate ("I see $99,991,116.99" when the crop is
 * actually empty), so we re-OCR the EXACT pixels the model approved and
 * confirm the digits match before saving the bbox.
 */
export async function ocrBuffer(buf: Buffer): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();
  const w = await getWorker();
  const result = await w.recognize(buf);
  return { text: (result.data.text ?? "").trim(), durationMs: Date.now() - start };
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
/** Try to read a run of ADJACENT numeric tokens as ONE number whose thousands
 *  separators OCR mangled into spaces: "1 000,004.31" → 1000004.31. Valid
 *  grouping = first group 1-3 digits, every later group EXACTLY 3 digits, the
 *  last optionally carrying ".dd" decimals. Anything else (e.g. "13"+"0.20",
 *  "50"+"10") is NOT grouping → null → tokens stay separate numbers. */
function tryThousandGrouping(run: string[]): { value: number; hasDecimals: boolean } | null {
  if (run.length < 2) return null;
  const groups: string[] = [];
  for (const tok of run) {
    for (const p of tok.split(/[,;']/)) if (p) groups.push(p);
  }
  if (groups.length < 2) return null;
  if (!/^\d{1,3}$/.test(groups[0]!)) return null;
  for (let k = 1; k < groups.length - 1; k++) {
    if (!/^\d{3}$/.test(groups[k]!)) return null;
  }
  const last = groups[groups.length - 1]!;
  const dm = last.match(/^(\d{3})\.(\d+)$/);
  if (!dm && !/^\d{3}$/.test(last)) return null;
  const intStr = groups.slice(0, -1).join("") + (dm ? dm[1] : last);
  const v = Number(dm ? `${intStr}.${dm[2]}` : intStr);
  return Number.isFinite(v) ? { value: v, hasDecimals: dm != null } : null;
}

export function parseNumericFromOcr(text: string): number | null {
  if (!text) return null;
  // CURRENCY SYMBOLS are HARD boundaries — two distinct values never share
  // one ("£13 $0.20" = badge 13 + bet 0.20). WHITESPACE inside a segment is
  // ambiguous: it may separate distinct numbers ("Win: 50 Bet: 10") or be an
  // OCR-mangled thousands separator ("$1 000,004.31" = 1000004.31). Adjacent
  // numeric tokens are first tried as one thousand-grouped number; only when
  // the 3-digit-group structure doesn't hold do they stay separate. In-token
  // separators (, ; ') still merge: "$99,996;103.04" → 99996103.04.
  const candidates: Array<{ value: number; hasDecimals: boolean }> = [];
  for (const segment of text.split(/[$€£¥₫]+/)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const cleaned0 = tokens[i]!.replace(/[,;']/g, "").replace(/:/g, ".");
      const m0 = cleaned0.match(/-?\d+(\.\d+)?/);
      if (!m0) { i++; continue; }
      // Collect the adjacent purely-numeric run after this token.
      const run: string[] = [tokens[i]!];
      let j = i + 1;
      while (j < tokens.length && /^[\d.,;':]+$/.test(tokens[j]!)) {
        run.push(tokens[j]!);
        j++;
      }
      const grouped = tryThousandGrouping(run);
      if (grouped) {
        candidates.push(grouped);
      } else {
        for (const tok of run) {
          const cleaned = tok.replace(/[,;']/g, "").replace(/:/g, ".");
          const m = cleaned.match(/-?\d+(\.\d+)?/);
          if (!m) continue;
          const n = Number(m[0]);
          if (Number.isFinite(n)) candidates.push({ value: n, hasDecimals: m[1] != null });
        }
      }
      i = j;
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.value;
  // Multiple numbers in the crop: the monetary value is written WITH decimals
  // ("0.20", "1,234.56"); stray neighbors (multiplier badges, counters) are
  // integers. Prefer the FIRST decimal-bearing token; else first overall —
  // preserving the long-standing "first number wins" contract.
  const decimal = candidates.find((c) => c.hasDecimals);
  return (decimal ?? candidates[0]!).value;
}

export async function terminateOcr(): Promise<void> {
  if (worker) {
    await worker.terminate().catch(() => undefined);
    worker = null;
  }
  if (numericWorker) {
    await numericWorker.terminate().catch(() => undefined);
    numericWorker = null;
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
 * counter / spins in progress) rather than a dismissable popup. An active
 * chain CANNOT be dismissed (ESC/click won't stop it) — it must be waited out.
 * Pure; exercised by invariant tests.
 *
 * Disambiguation: "free spins" alone is ambiguous — it appears in (a) the
 * real in-progress chain, (b) FS-trigger banner ("press anywhere"), (c) the
 * paytable's "FREE SPINS rules" page, and (d) the buy-bonus popup. A real
 * chain has FS text + NO dismiss affordance + NO substate-popup keywords. If
 * we also see paytable/buy/settings/etc. content, this is a POPUP about free
 * spins, not a chain in progress — recovery should dismiss it normally.
 * (Bug observed 2026-05-30: paytableButton opened a "FREE SPINS rules" popup
 * → matchedKeywords=["free spins","rules"] → wrongly classified as chain →
 * ensure-main skipped recover and blocked all subsequent probes.)
 */
const POPUP_CONTENT_DISCRIMINATORS = [
  "paytable",
  "pay table",
  "rules",
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
  "game info",
  "how to play",
];

export function isFreeSpinChainActive(matchedKeywords: ReadonlyArray<string>): boolean {
  const lower = matchedKeywords.map((k) => k.toLowerCase());
  const hasFs = lower.some((k) => k.includes("free spin"));
  if (!hasFs) return false;
  const hasDismiss = lower.some((k) => /press anywhere|continue/i.test(k));
  if (hasDismiss) return false;
  const hasPopupContent = lower.some((k) => POPUP_CONTENT_DISCRIMINATORS.some((p) => k.includes(p)));
  if (hasPopupContent) return false; // popup about FS, not chain in progress
  return true;
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
 * Interstitial detector historically treated any OCR hit containing
 * "free spins" as dismissable popup content. That is too broad: buy-feature
 * dialogs and paytable/rules pages also contain "free spins" but should not
 * be handled by the generic ESC+corner dismiss loop.
 *
 * Keep strong interstitial phrases ("press anywhere", "to continue",
 * "congratulations", "you won", etc.) while dropping the ambiguous lone
 * "free spins" match when there is no blocking affordance and OCR text looks
 * like substate content.
 */
function suppressAmbiguousFreeSpinsMatches(text: string, matches: string[]): string[] {
  if (!matches.some((m) => m.toLowerCase().includes("free spin"))) return matches;
  const lower = text.toLowerCase();
  const hasBlockingAffordance = BLOCKING_AFFORDANCE_PHRASES.some((p) => lower.includes(p));
  if (hasBlockingAffordance) return matches;
  const hasStrongInterstitialSignal =
    lower.includes("congratulations") ||
    lower.includes("you have won") ||
    lower.includes("you won") ||
    lower.includes("you've won") ||
    lower.includes("big win") ||
    lower.includes("huge win") ||
    lower.includes("mega win") ||
    lower.includes("max win") ||
    lower.includes("bonus complete");
  if (hasStrongInterstitialSignal) return matches;
  const hasSubstateContent = POPUP_CONTENT_DISCRIMINATORS.some((k) => lower.includes(k));
  if (!hasSubstateContent) return matches;
  return matches.filter((m) => !m.toLowerCase().includes("free spin"));
}

function explainFreeSpinsSuppression(text: string, before: string[], after: string[]): string | null {
  const hadFreeSpins = before.some((m) => m.toLowerCase().includes("free spin"));
  const hasFreeSpinsAfter = after.some((m) => m.toLowerCase().includes("free spin"));
  if (!hadFreeSpins || hasFreeSpinsAfter) return null;
  const lower = text.toLowerCase();
  const hasBlockingAffordance = BLOCKING_AFFORDANCE_PHRASES.some((p) => lower.includes(p));
  const hasStrongInterstitialSignal =
    lower.includes("congratulations") ||
    lower.includes("you have won") ||
    lower.includes("you won") ||
    lower.includes("you've won") ||
    lower.includes("big win") ||
    lower.includes("huge win") ||
    lower.includes("mega win") ||
    lower.includes("max win") ||
    lower.includes("bonus complete");
  const hasSubstateContent = POPUP_CONTENT_DISCRIMINATORS.some((k) => lower.includes(k));
  return `suppressed ambiguous free-spins interstitial hit (blockingAffordance=${hasBlockingAffordance}, strongInterstitial=${hasStrongInterstitialSignal}, substateContent=${hasSubstateContent})`;
}

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
  const rawMatches = POPUP_KEYWORDS.filter((k) => text.includes(k));
  const bannerFiltered = suppressResultBannerMatches(text, rawMatches);
  const matched = suppressAmbiguousFreeSpinsMatches(text, bannerFiltered);
  const suppressionReason = explainFreeSpinsSuppression(text, bannerFiltered, matched);
  if (suppressionReason) {
    const before = bannerFiltered.join(",");
    const after = matched.join(",");
    console.log(`[ocr/popup-detect] ${suppressionReason}; before=[${before}] after=[${after}]`);
  }
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const det = await detectPopup(page);
    trace.push(det);
    console.log(`[ocr/popup-detect] attempt ${attempt}: hasPopup=${det.hasPopup} matched=[${det.matchedKeywords.join(",")}] ms=${det.durationMs}`);
    if (!det.hasPopup) {
      return { ok: true, attempts: attempt, finalDetect: det, trace };
    }
    // Dismiss strategy: ESC press + safe-corner click at (5, 5).
    // NEVER click viewport center (2026-06-01 incident on vs20rnriches):
    // many PP slot games interpret a canvas tap as "spin command", so a
    // center-click during dismiss can land on the reel grid → trigger a
    // real spin → scatter combo → free-spin chain → every subsequent probe
    // blocked for ~10 minutes while the chain plays out (and a real bet is
    // spent each time, which is the actual cost). ESC works on most modal
    // popups; if it doesn't, (5, 5) is empty chrome / lobby margin on
    // nearly every game UI — even if it lands on something, it's never
    // spin. When popups need an explicit X-close in a non-corner position
    // and respond to neither ESC nor corner-click, this loop bails after
    // maxAttempts; caller (recoverToMain / probePendingElements) then
    // decides whether to retry or report stuck.
    try {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(Math.max(150, Math.floor(interClickMs / 2)));
      await page.mouse.click(5, 5);
      await page.waitForTimeout(interClickMs);
    } catch {
      break;
    }
  }
  const final = trace[trace.length - 1]!;
  return { ok: !final.hasPopup, attempts: maxAttempts, finalDetect: final, trace };
}
