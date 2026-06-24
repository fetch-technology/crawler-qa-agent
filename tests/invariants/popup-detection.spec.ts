// INVARIANT — popup keyword detection
//
// OCR detector must:
//   1. Match all keywords in the configured list (no silent miss)
//   2. Be case-insensitive (OCR returns mixed case)
//   3. NOT match keywords that aren't in the list (no hardcoded magic)
//   4. Handle empty text gracefully
//
// If broken: popups go undetected → spin clicks fail silently → cumulative
// case failures with no root cause. The keyword list is the SOURCE OF TRUTH
// for what counts as a "popup state".

import { test, expect } from "@playwright/test";
import {
  POPUP_KEYWORDS,
  SUBSTATE_POPUP_KEYWORDS,
  matchPopupKeywords,
  suppressResultBannerMatches,
  isFreeSpinChainActive,
} from "../../src/pipeline/utils/ocr-popup.js";

test("interstitial keywords are non-empty array of lowercase strings", () => {
  expect(Array.isArray(POPUP_KEYWORDS)).toBe(true);
  expect(POPUP_KEYWORDS.length).toBeGreaterThan(0);
  for (const k of POPUP_KEYWORDS) {
    expect(typeof k).toBe("string");
    expect(k).toBe(k.toLowerCase());
    expect(k.length).toBeGreaterThan(0);
  }
});

test("substate keywords are non-empty array of lowercase strings", () => {
  expect(Array.isArray(SUBSTATE_POPUP_KEYWORDS)).toBe(true);
  expect(SUBSTATE_POPUP_KEYWORDS.length).toBeGreaterThan(0);
  for (const k of SUBSTATE_POPUP_KEYWORDS) {
    expect(typeof k).toBe("string");
    expect(k).toBe(k.toLowerCase());
    expect(k.length).toBeGreaterThan(0);
  }
});

test("includes common interstitial popups: press anywhere, congratulations, free spins, big win", () => {
  expect(POPUP_KEYWORDS).toContain("press anywhere");
  expect(POPUP_KEYWORDS).toContain("congratulations");
  expect(POPUP_KEYWORDS).toContain("free spins");
  expect(POPUP_KEYWORDS).toContain("big win");
});

test("includes common substate popups: paytable, buy feature, autoplay, history", () => {
  expect(SUBSTATE_POPUP_KEYWORDS).toContain("paytable");
  expect(SUBSTATE_POPUP_KEYWORDS).toContain("buy feature");
  expect(SUBSTATE_POPUP_KEYWORDS).toContain("autoplay");
  expect(SUBSTATE_POPUP_KEYWORDS).toContain("history");
});

test("matchPopupKeywords: empty text returns empty array", () => {
  expect(matchPopupKeywords("", POPUP_KEYWORDS)).toEqual([]);
});

test("matchPopupKeywords: text with no keyword returns empty array", () => {
  const innocent = "Spin button balance bet credit 1000";
  const matches = matchPopupKeywords(innocent, POPUP_KEYWORDS);
  expect(matches).toEqual([]);
});

test("matchPopupKeywords: case-insensitive — uppercase OCR text matches lowercase keyword", () => {
  const ocrText = "PRESS ANYWHERE TO CONTINUE";
  const matches = matchPopupKeywords(ocrText, POPUP_KEYWORDS);
  expect(matches).toContain("press anywhere");
  expect(matches).toContain("to continue");
});

test("matchPopupKeywords: mixed case (Title Case)", () => {
  const ocrText = "Congratulations! You Have Won 100 Coins";
  const matches = matchPopupKeywords(ocrText, POPUP_KEYWORDS);
  expect(matches).toContain("congratulations");
  expect(matches).toContain("you have won");
});

test("matchPopupKeywords: substate AUTOPLAY popup detected", () => {
  const ocrText = "AUTOPLAY\nNumber of spins: 10";
  const matches = matchPopupKeywords(ocrText, SUBSTATE_POPUP_KEYWORDS);
  expect(matches).toContain("autoplay");
  expect(matches).toContain("number of spins");
});

test("matchPopupKeywords: PAYTABLE popup detected", () => {
  const ocrText = "PAYTABLE\nSymbol payouts × 5 = 100";
  const matches = matchPopupKeywords(ocrText, SUBSTATE_POPUP_KEYWORDS);
  expect(matches).toContain("paytable");
});

test("matchPopupKeywords: substring matching — 'pay table' (with space) matches if listed", () => {
  // Both 'paytable' and 'pay table' should be in the list for OCR tolerance.
  expect(SUBSTATE_POPUP_KEYWORDS).toContain("pay table");
  const ocrText = "Pay Table for game";
  const matches = matchPopupKeywords(ocrText, SUBSTATE_POPUP_KEYWORDS);
  expect(matches).toContain("pay table");
});

test("matchPopupKeywords: no false positive on partial-word similarity", () => {
  // 'play table' contains 'lay table' but should NOT match 'pay table'.
  const ocrText = "Player table game";
  const matches = matchPopupKeywords(ocrText, SUBSTATE_POPUP_KEYWORDS);
  expect(matches).not.toContain("pay table");
});

test("matchPopupKeywords: empty keyword list → always returns empty matches", () => {
  expect(matchPopupKeywords("Press anywhere to continue", [])).toEqual([]);
});

test("matchPopupKeywords: multiple distinct keywords found in same text", () => {
  const ocrText = "CONGRATULATIONS! You won big! Free spins triggered!";
  const matches = matchPopupKeywords(ocrText, POPUP_KEYWORDS);
  // Note: "you won" is also a keyword, so we just check >= 2 distinct hits
  expect(matches.length).toBeGreaterThanOrEqual(2);
  expect(matches).toContain("congratulations");
  expect(matches).toContain("free spins");
});

test("matchPopupKeywords result order matches keyword list order (deterministic)", () => {
  const ocrText = "Big win bonus complete congratulations";
  const matches = matchPopupKeywords(ocrText, POPUP_KEYWORDS);
  // POPUP_KEYWORDS order: ..., congratulations, ..., big win, ..., bonus complete
  // Filter preserves source order, so we verify matches appear in that order.
  const congratIdx = matches.indexOf("congratulations");
  const bigWinIdx = matches.indexOf("big win");
  const bonusIdx = matches.indexOf("bonus complete");
  if (congratIdx >= 0 && bigWinIdx >= 0) {
    expect(congratIdx).toBeLessThan(bigWinIdx);
  }
  if (bigWinIdx >= 0 && bonusIdx >= 0) {
    expect(bigWinIdx).toBeLessThan(bonusIdx);
  }
});

// === Result-banner suppression (2026-05-27) ===
// "FREE SPINS COMPLETED" on the MAIN screen contains "free spins" → falsely
// matched the popup keyword → ensure-main looped forever. suppressResultBanner
// drops these false positives unless a real blocking affordance is present.

test("REGRESSION: 'FREE SPINS COMPLETED' main banner → 'free spins' suppressed", () => {
  const text = "win $35.95 free spins completed bet $0.50 autoplay";
  const matched = matchPopupKeywords(text, POPUP_KEYWORDS); // includes "free spins"
  expect(matched).toContain("free spins");
  const effective = suppressResultBannerMatches(text, matched);
  expect(effective).not.toContain("free spins");
  expect(effective).toEqual([]); // no real popup → ensure-main proceeds
});

test("real FS popup ('press anywhere to continue') is NOT suppressed", () => {
  const text = "congratulations you won 10 free spins press anywhere to continue";
  const matched = matchPopupKeywords(text, POPUP_KEYWORDS);
  const effective = suppressResultBannerMatches(text, matched);
  // Blocking affordance present → keep matches (genuine popup to dismiss)
  expect(effective).toContain("free spins");
  expect(effective.length).toBeGreaterThan(0);
});

test("no result-banner phrase → matches pass through unchanged", () => {
  const text = "big win you won mega win";
  const matched = matchPopupKeywords(text, POPUP_KEYWORDS);
  const effective = suppressResultBannerMatches(text, matched);
  expect(effective).toEqual(matched);
});

test("'feature complete' banner suppresses generic win triggers", () => {
  const text = "feature complete you won 12.00";
  const matched = matchPopupKeywords(text, POPUP_KEYWORDS);
  const effective = suppressResultBannerMatches(text, matched);
  expect(effective).not.toContain("you won");
});

test("result-banner phrase but a substate keyword (paytable) is NOT a banner trigger", () => {
  // suppressResultBannerMatches only filters generic banner triggers; a real
  // substate match like "paytable" passed in stays (not in banner-trigger set).
  const effective = suppressResultBannerMatches("free spins completed paytable", ["free spins", "paytable"]);
  expect(effective).not.toContain("free spins");
  expect(effective).toContain("paytable");
});

test("empty matches → empty (no throw)", () => {
  expect(suppressResultBannerMatches("free spins completed", [])).toEqual([]);
});

// === Active free-spin chain detection (2026-05-27) ===
// A leftover FS chain (from a previous case in the shared session) can't be
// dismissed — it must be waited out. isFreeSpinChainActive distinguishes an
// in-progress chain (FS counter, no dismiss affordance) from a dismissable
// FS-start celebration ("press anywhere").

test("FS counter in progress (no dismiss affordance) → active chain", () => {
  expect(isFreeSpinChainActive(["free spins"])).toBe(true);
});

test("FS-start celebration ('press anywhere') → NOT an active chain (dismissable)", () => {
  expect(isFreeSpinChainActive(["free spins", "press anywhere"])).toBe(false);
});

test("'to continue' affordance → dismissable, not active chain", () => {
  expect(isFreeSpinChainActive(["free spins", "to continue"])).toBe(false);
});

test("no FS keyword → not active chain", () => {
  expect(isFreeSpinChainActive(["paytable"])).toBe(false);
  expect(isFreeSpinChainActive([])).toBe(false);
});

test("case-insensitive FS keyword match", () => {
  expect(isFreeSpinChainActive(["FREE SPIN"])).toBe(true);
});

// REGRESSION 2026-05-31: paytable popup that opens to a "FREE SPINS rules"
// page produces matchedKeywords=["free spins","rules"]. Old logic returned
// true (no dismiss affordance + FS keyword) → ensure-main skipped recover and
// blocked every subsequent probe. Substate-popup keywords now veto.
test("FS keyword + substate popup keyword (rules) → popup, NOT active chain", () => {
  expect(isFreeSpinChainActive(["free spins", "rules"])).toBe(false);
});

test("FS keyword + paytable keyword → popup, NOT active chain", () => {
  expect(isFreeSpinChainActive(["free spins", "paytable"])).toBe(false);
});

test("FS keyword + buy bonus keyword → popup, NOT active chain", () => {
  expect(isFreeSpinChainActive(["free spins", "buy bonus"])).toBe(false);
});

test("FS keyword + autoplay keyword → popup, NOT active chain", () => {
  expect(isFreeSpinChainActive(["free spins", "autoplay"])).toBe(false);
});

// REGRESSION 2026-06-23 (Black Wolf 2): the pre-game intro splash "TAP ANYWHERE
// TO START!" matched NONE of the interstitial keywords → ensure-main thought the
// game was on-main → the main-screen QA picker opened against the splash and
// every element read "missing". The intro splash must be a dismissable popup.
test("intro splash 'TAP ANYWHERE TO START' is detected as an interstitial popup", () => {
  const matched = matchPopupKeywords("Collect 20 BONUS symbols. TAP ANYWHERE TO START!", POPUP_KEYWORDS);
  expect(matched.length).toBeGreaterThan(0);
  expect(matched).toContain("tap anywhere");
});

test("intro splash variants are detected", () => {
  expect(matchPopupKeywords("TAP TO START", POPUP_KEYWORDS)).toContain("tap to start");
  expect(matchPopupKeywords("TAP TO PLAY", POPUP_KEYWORDS)).toContain("tap to play");
  expect(matchPopupKeywords("CLICK TO START", POPUP_KEYWORDS)).toContain("click to start");
});

test("a plain main screen with bet/balance text is NOT a popup", () => {
  expect(matchPopupKeywords("BALANCE 1000.00 BET 0.20 TOTAL BET", POPUP_KEYWORDS)).toEqual([]);
});
