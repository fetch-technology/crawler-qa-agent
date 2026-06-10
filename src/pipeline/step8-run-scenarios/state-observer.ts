// State Observer (Phase 8.3) — multi-signal state detection.
//
// Combines API state (from last parsed spin), OCR popup keywords, dark
// overlay, and cached state signatures into a single classification of the
// game's current screen. Used by the adaptive runner's observe-act loop to
// decide:
//   - continue with next action (state == EXPECTED)
//   - dispatch interrupt handler (state in allowedInterruptions)
//   - pause + learn (state == UNKNOWN)
//
// Pure where possible; one Page-bound function calls OCR + screenshot.

import type { Page } from "playwright";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import {
  detectAnyPopup,
  detectDarkOverlay,
  matchPopupKeywords,
  POPUP_KEYWORDS,
  SUBSTATE_POPUP_KEYWORDS,
} from "../utils/ocr-popup.js";

/** Canonical observed state labels. Extendable by registry-side state signatures. */
export const OBSERVED_STATES = [
  "MAIN",                  // Ready for next spin
  "SPINNING",              // Spin in progress
  "FREE_SPIN",             // Free spin chain active
  "FREE_SPIN_TRIGGERED",   // Just transitioned into free spin
  "BIG_WIN_POPUP",         // Big-win / mega-win interstitial
  "BONUS_POPUP",           // Bonus game popup
  "BUY_FEATURE_POPUP",     // Buy feature confirmation popup
  "AUTOPLAY_POPUP",        // Autoplay configuration popup
  "PAYTABLE_POPUP",        // Paytable / info screen
  "HISTORY_POPUP",         // History popup
  "SETTINGS_POPUP",        // Settings panel
  "DISCONNECT_POPUP",      // Connection lost / session expired
  "INSUFFICIENT_BALANCE",  // Low balance modal
  "LOADING",               // Game loading / stuck
  "UNKNOWN",               // None of the above matched
] as const;

export type ObservedState = (typeof OBSERVED_STATES)[number];

export type ObserverSignals = {
  /** API spin state (NORMAL/FREE_SPIN/BONUS/...) when last spin response available. */
  apiState?: string;
  /** Free-spin counter from API. */
  apiFreeSpinsRemaining?: number;
  /** OCR-matched keyword set (lowercased). */
  ocrMatched?: string[];
  /** Dark overlay flag. */
  darkOverlay?: boolean;
  /** Detected popup type from OCR signature (when SUBSTATE keyword present). */
  popupType?: "paytable" | "autoplay" | "buy" | "history" | "settings" | null;
  /** Cached state signature ID matched (post-Ship 8.5). */
  signatureMatched?: string;
};

export type ObserveResult = {
  state: ObservedState;
  confidence: number;
  signals: ObserverSignals;
  /** Raw OCR text (truncated) for debugging / AI review. */
  ocrText?: string;
  durationMs: number;
};

export type ObserverOptions = {
  /** Per-game keyword overrides — resolvePopupKeywords output (Phase 7.1C). */
  interstitialKeywords?: ReadonlyArray<string>;
  substateKeywords?: ReadonlyArray<string>;
  /** Custom state signatures (Phase 8.5) — added to taxonomy. */
  customSignatures?: Array<{ id: string; ocrAny?: string[]; ocrAll?: string[] }>;
  /** Last parsed spin — provides API state hint. */
  lastSpin?: NormalizedSpinResult | null;
  /** Skip OCR (e.g., dry-run / unit tests). */
  skipOcr?: boolean;
};

/**
 * Observe current state from a live page. Combines OCR + dark overlay + API
 * state hint to produce a classification.
 */
export async function observeState(page: Page, opts: ObserverOptions = {}): Promise<ObserveResult> {
  const start = Date.now();
  const signals: ObserverSignals = {};

  if (opts.lastSpin) {
    signals.apiState = opts.lastSpin.state;
    signals.apiFreeSpinsRemaining = opts.lastSpin.freeSpinsRemaining ?? undefined;
  }

  // Fast path — if API state already says FREE_SPIN / BONUS / GAMBLE, skip
  // OCR + screenshots entirely. They're expensive (force browser repaint in
  // headed mode → visible flicker) and unnecessary when API tells us.
  // Also QA_OBSERVER_LIGHT=1 → API-only mode (no screenshots, ever).
  const apiStateDecisive = signals.apiState === "FREE_SPIN" || signals.apiState === "BONUS"
    || (signals.apiFreeSpinsRemaining ?? 0) > 0;
  const lightMode = process.env.QA_OBSERVER_LIGHT === "1";
  if (apiStateDecisive || lightMode) {
    const result = classify(signals);
    return { ...result, signals, ocrText: "", durationMs: Date.now() - start };
  }

  let ocrText = "";
  if (!opts.skipOcr) {
    let sharedShot: Buffer | undefined;
    try {
      const ocr = await detectAnyPopup(page, {
        interstitialKeywords: opts.interstitialKeywords,
        substateKeywords: opts.substateKeywords,
      });
      signals.ocrMatched = ocr.matchedKeywords;
      ocrText = ocr.detectedText;
      sharedShot = ocr.screenshot;
    } catch {
      // OCR failure → continue without
    }
    if (process.env.QA_SKIP_DARK_OVERLAY !== "1") {
      try {
        // Reuse the OCR screenshot to avoid a 2nd page.screenshot() call
        // (each one forces browser repaint in headed mode → visible flicker).
        const overlay = await detectDarkOverlay(page, { sharedScreenshot: sharedShot });
        signals.darkOverlay = overlay.overlayPresent;
      } catch {
        // dark overlay check failure
      }
    }
  }

  // Custom signatures (Ship 8.5) match
  if (opts.customSignatures && ocrText) {
    const haystack = ocrText.toLowerCase();
    for (const sig of opts.customSignatures) {
      const anyHit = sig.ocrAny?.some((k) => haystack.includes(k.toLowerCase())) ?? false;
      const allHit = sig.ocrAll?.every((k) => haystack.includes(k.toLowerCase())) ?? true;
      if ((sig.ocrAny ? anyHit : true) && allHit) {
        signals.signatureMatched = sig.id;
        break;
      }
    }
  }

  const result = classify(signals);
  return { ...result, signals, ocrText: ocrText.slice(0, 400), durationMs: Date.now() - start };
}

/**
 * Pure classifier — given signals, decide state + confidence. Separated
 * from `observeState` so it's directly invariant-testable.
 */
export function classify(signals: ObserverSignals): { state: ObservedState; confidence: number } {
  const ocr = signals.ocrMatched ?? [];

  // 0. Custom signature (highest priority — explicit QA labeled)
  if (signals.signatureMatched) {
    const sigUpper = signals.signatureMatched.toUpperCase();
    if (OBSERVED_STATES.includes(sigUpper as ObservedState)) {
      return { state: sigUpper as ObservedState, confidence: 0.95 };
    }
    // Custom name not in canonical list → still trust signature
    return { state: "UNKNOWN", confidence: 0.4 };
  }

  // 1. API state hints (strong signal)
  if (signals.apiState === "FREE_SPIN" || (signals.apiFreeSpinsRemaining ?? 0) > 0) {
    return { state: "FREE_SPIN", confidence: 0.9 };
  }
  if (signals.apiState === "BONUS") return { state: "BONUS_POPUP", confidence: 0.8 };

  // 2. OCR keyword classification
  const ocrLower = ocr.map((k) => k.toLowerCase());
  const hasFree = ocrLower.some((k) => k.includes("free spin") || k.includes("free spins"));
  const hasBigWin = ocrLower.some((k) => k.includes("big win") || k.includes("mega win") || k.includes("huge win") || k.includes("max win"));
  const hasCongrats = ocrLower.some((k) => k.includes("congratulations") || k.includes("you have won") || k.includes("you won"));
  const hasContinue = ocrLower.some((k) => k.includes("press anywhere") || k.includes("to continue"));
  const hasPaytable = ocrLower.some((k) => k.includes("paytable") || k.includes("pay table"));
  // "autoplay"/"auto play" ALONE is a false positive: many games render a
  // PERMANENT autoplay button on the MAIN screen (e.g. Gates of Olympus), so a
  // closed-popup main reads as AUTOPLAY_POPUP and breaks return-to-main checks.
  // Only treat it as an OPEN popup when corroborated by a phrase that appears
  // solely inside the autoplay dialog ("number of spins"/"loss limit"/…) OR by
  // a dark overlay dimming the screen. Mirrors the ensureMainScreen filter.
  const hasAutoplayPopupPhrase = ocrLower.some((k) =>
    k.includes("number of spins") || k.includes("loss limit") || k.includes("single win limit"));
  const hasAutoplayLabel = ocrLower.some((k) => k.includes("autoplay") || k.includes("auto play"));
  const hasAutoplay = hasAutoplayPopupPhrase || (hasAutoplayLabel && signals.darkOverlay === true);
  const hasBuy = ocrLower.some((k) => k.includes("buy feature") || k.includes("buy bonus") || k.includes("buy free spins"));
  const hasHistory = ocrLower.some((k) => k.includes("history"));
  const hasSettings = ocrLower.some((k) => k.includes("settings"));

  if (hasBigWin) return { state: "BIG_WIN_POPUP", confidence: 0.85 };
  if (hasFree && (hasCongrats || hasContinue)) return { state: "FREE_SPIN_TRIGGERED", confidence: 0.85 };
  if (hasPaytable) return { state: "PAYTABLE_POPUP", confidence: 0.85 };
  if (hasAutoplay) return { state: "AUTOPLAY_POPUP", confidence: 0.85 };
  if (hasBuy) return { state: "BUY_FEATURE_POPUP", confidence: 0.85 };
  if (hasHistory) return { state: "HISTORY_POPUP", confidence: 0.8 };
  if (hasSettings) return { state: "SETTINGS_POPUP", confidence: 0.8 };
  if (hasCongrats || hasContinue) return { state: "BIG_WIN_POPUP", confidence: 0.6 };

  // 3. Dark overlay alone is noisy on some themes (dark corners / vignette)
  // in cloud rendering. Without OCR evidence, prefer MAIN to avoid flaky
  // MAIN->UNKNOWN transitions.
  if (signals.darkOverlay) {
    if (ocrLower.length === 0) return { state: "MAIN", confidence: 0.55 };
    return { state: "UNKNOWN", confidence: 0.4 };
  }

  // 4. No signals → assume MAIN
  return { state: "MAIN", confidence: 0.7 };
}
