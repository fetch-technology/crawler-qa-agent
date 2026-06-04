// Unrecoverable game-error detection. PP slot servers occasionally
// throw "Internal server error. The game will be restarted." and other
// fatal popups that cannot be auto-dismissed by clicking. When this
// happens during automation, EVERY downstream click misses (popup
// blocks the play area), every spin fails, and the test results become
// garbage. We need to halt fast + surface the error to QA, not retry.
//
// This module provides:
//   - GAME_ERROR_KEYWORDS — patterns from PP game error popups
//   - detectGameError(page) — scan current screen via OCR, return verdict
//   - GameErrorDetectedError — thrown by automation flows to halt cleanly
//
// Consumers (autoOnboard, executeCase, deepDiscover) call detectGameError
// at strategic points (between phases, before each spin, after popup
// recovery) and throw GameErrorDetectedError on hit. The dashboard
// renders the error in a session-level banner so QA knows to refresh
// the game URL and resume.

import type { Page } from "playwright";
import { ocrRegion } from "./ocr-popup.js";

/** OCR text patterns that indicate the GAME engine itself is broken.
 *  Distinct from per-spin popups (big win, free spin trigger) and
 *  navigable sub-states (paytable, settings) — these REQUIRE manual
 *  intervention (reload URL, refresh balance, etc).
 *
 *  All matching is case-insensitive on lowercased OCR text. Keep
 *  patterns SPECIFIC (avoid generic "error" which appears in many
 *  legit UIs like "error sound off"). */
export const GAME_ERROR_KEYWORDS: ReadonlyArray<string> = [
  // From PP "MESSAGE" popup screenshot — most common variant.
  "internal server error",
  "game will be restarted",
  "will be restarted",
  // Session/connection issues that also halt play.
  "session expired",
  "session timeout",
  "session has expired",
  "connection lost",
  "connection error",
  "lost connection",
  // Reload-required messages.
  "please reload",
  "please refresh",
  "reload the game",
  "refresh the page",
  // Generic fatal-flow phrases observed across providers.
  "an error occurred",
  "an error has occurred",
  "try again later",
  "service unavailable",
  "game unavailable",
];

/** Region the OCR scan targets. PP game error popups are centered modal
 *  dialogs — the "MESSAGE" header + body text live in the middle ~50%
 *  of the viewport. We crop instead of full-screen OCR to (a) speed up
 *  Tesseract (~5x faster on smaller crops) and (b) reduce false
 *  positives from chrome / sidebar UI text. */
function errorScanRegion(vp: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(vp.width * 0.18),
    y: Math.round(vp.height * 0.25),
    w: Math.round(vp.width * 0.64),
    h: Math.round(vp.height * 0.50),
  };
}

export type GameErrorDetectResult = {
  /** True when ANY GAME_ERROR_KEYWORDS pattern matched the OCR text. */
  hasError: boolean;
  /** Patterns that matched (subset of GAME_ERROR_KEYWORDS). */
  matchedKeywords: string[];
  /** Raw OCR text from the scan region — useful for diagnosis when
   *  hasError=true (shows the full error sentence). Truncated to 400
   *  chars to keep logs/dashboard tidy. */
  detectedText: string;
  /** ms wall clock — for tuning. */
  durationMs: number;
};

/** Scan the current page for a game-error popup. Cheap (~300-800ms
 *  OCR) — caller decides when to invoke (between actions, after popup
 *  recovery, before each spin in long suites). Always returns; never
 *  throws on OCR failure (returns hasError=false + empty match list). */
export async function detectGameError(page: Page): Promise<GameErrorDetectResult> {
  const start = Date.now();
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const region = errorScanRegion(vp);
    const { text } = await ocrRegion(page, region);
    const lower = text.toLowerCase();
    const matched = GAME_ERROR_KEYWORDS.filter((k) => lower.includes(k));
    return {
      hasError: matched.length > 0,
      matchedKeywords: matched,
      detectedText: text.trim().slice(0, 400),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // OCR failure shouldn't crash callers — fail-open (no error
    // detected). The next call (a few hundred ms later) will retry.
    console.warn(`[game-error-detect] OCR failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hasError: false, matchedKeywords: [], detectedText: "", durationMs: Date.now() - start };
  }
}

/** Thrown by automation flows when a game-error popup is detected.
 *  Cleanly halts the current operation (autoOnboard, executeCase,
 *  deepDiscover) and propagates to the HTTP route handler which
 *  surfaces the message to the dashboard. Distinct from generic
 *  Error so middleware / catch blocks can recognise it. */
export class GameErrorDetectedError extends Error {
  /** Patterns that matched — useful for log scraping + dashboard hint. */
  readonly matchedKeywords: ReadonlyArray<string>;
  /** Raw OCR text snippet that triggered the detection. */
  readonly detectedText: string;
  /** Where in the automation flow we caught the error (autoOnboard
   *  phase name, "executeCase:<caseId>", "deepDiscover", etc). */
  readonly site: string;

  constructor(result: GameErrorDetectResult, site: string) {
    super(
      `GAME ERROR detected (site=${site}): ${result.matchedKeywords.join(", ")} — ` +
      `OCR text: "${result.detectedText.slice(0, 120)}". Game needs manual intervention (reload URL).`,
    );
    this.name = "GameErrorDetectedError";
    this.matchedKeywords = result.matchedKeywords;
    this.detectedText = result.detectedText;
    this.site = site;
  }
}

/** Convenience: run detectGameError, throw GameErrorDetectedError on hit.
 *  Use this at automation hook points where a hit should halt the flow.
 *  Returns silently when no error detected. */
export async function throwIfGameError(page: Page, site: string): Promise<void> {
  const r = await detectGameError(page);
  if (r.hasError) {
    console.error(`[game-error-detect] ⛔ HALT at ${site} — keywords=${r.matchedKeywords.join(",")} text="${r.detectedText.slice(0, 80)}"`);
    throw new GameErrorDetectedError(r, site);
  }
}
