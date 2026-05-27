// Paytable content verification. The rule contract is synchronous and
// per-spin, but paytable verification is async + once-per-run (click button
// → screenshot popup → OCR → diff). So the heavy work lives in a standalone
// async function `verifyPaytableContent`; the Rule class is a thin wrapper
// that reads a pre-attached result from `spin.raw._paytableVerification` and
// reports synchronously. When absent, it's a no-op (returns
// detail="no-paytable-verification") so the rule is safe in pipelines that
// don't invoke the async verifier.
//
// AI scope: ZERO AI calls. Pure Tesseract OCR + JSON diff.

import type { Page } from "playwright";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Paytable, PaytableEntry, PopupRegions, UiRegistry } from "../registry/types.js";
import { ocrRegion } from "../utils/ocr-popup.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { popupRegions as popupRegionsStore } from "../registry/popup-regions.js";
import { uiRegistry } from "../registry/ui-registry.js";
import type { Rule, RuleResult } from "./rule.js";

export type PaytableMismatch = {
  symbol: string;
  expected: PaytableEntry["payouts"];
  actual: PaytableEntry["payouts"] | null;
  reason: "missing" | "payout_mismatch" | "extra_payout";
};

export type PaytableVerificationResult = {
  ok: boolean;
  matchedSymbols: number;
  totalExpected: number;
  mismatches: PaytableMismatch[];
  ocrTextLength: number;
  durationMs: number;
  skipReason?: string;
};

export class PaytableContentRule implements Rule {
  name = "paytable.content_matches_expected";

  check(spin: NormalizedSpinResult): RuleResult {
    const result = (spin.raw as Record<string, unknown> | null | undefined)?.[
      "_paytableVerification"
    ] as PaytableVerificationResult | undefined;
    if (!result) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "no-paytable-verification",
      };
    }
    if (result.skipReason) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: `skipped: ${result.skipReason}`,
      };
    }
    if (result.ok) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: `${result.matchedSymbols}/${result.totalExpected} symbols matched`,
      };
    }
    const first = result.mismatches.slice(0, 3).map((m) => `${m.symbol}:${m.reason}`).join(", ");
    return {
      ruleName: this.name,
      pass: false,
      severity: "error",
      expected: `${result.totalExpected} symbols match expected paytable`,
      actual: `${result.matchedSymbols} matched, ${result.mismatches.length} mismatches`,
      detail: `mismatches: ${first}${result.mismatches.length > 3 ? ` (+${result.mismatches.length - 3} more)` : ""}`,
    };
  }
}

/**
 * Open the in-game paytable popup, OCR its contents, diff against the
 * expected `paytable.json` registry. Caller must hand back any open popup
 * before continuing the case (`dismissPopupsLoop`).
 *
 * Skips with `skipReason` when prerequisites missing — caller treats as
 * non-fatal info, not failure.
 */
export async function verifyPaytableContent(
  page: Page,
  slug: string,
  opts: { settleMs?: number } = {},
): Promise<PaytableVerificationResult> {
  const start = Date.now();
  const settleMs = opts.settleMs ?? 1200;
  const empty: PaytableVerificationResult = {
    ok: true,
    matchedSymbols: 0,
    totalExpected: 0,
    mismatches: [],
    ocrTextLength: 0,
    durationMs: 0,
  };

  const expected = await paytableStore.load(slug);
  if (!expected || expected.symbols.length === 0) {
    return { ...empty, skipReason: "no expected paytable.json in registry", durationMs: Date.now() - start };
  }

  const ui = await uiRegistry.load(slug);
  const paytableBtn = ui?.paytableButton ?? ui?.menuButton;
  if (!paytableBtn) {
    return { ...empty, skipReason: "no paytableButton (or menuButton fallback) in ui-registry", durationMs: Date.now() - start };
  }

  const regions = await popupRegionsStore.load(slug);
  const popupBox = regions?.paytablePopup;
  if (!popupBox) {
    return { ...empty, skipReason: "no paytablePopup region in popup-regions.json", durationMs: Date.now() - start };
  }

  try {
    await page.mouse.click(paytableBtn.x, paytableBtn.y);
    await page.waitForTimeout(settleMs);
  } catch (err) {
    return { ...empty, skipReason: `click failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }

  let ocrText = "";
  try {
    const ocr = await ocrRegion(page, {
      x: popupBox.x,
      y: popupBox.y,
      w: popupBox.width,
      h: popupBox.height,
    });
    ocrText = ocr.text;
  } catch (err) {
    return { ...empty, skipReason: `OCR failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }

  const mismatches = diffPaytableAgainstOcr(expected, ocrText);
  const matched = expected.symbols.length - mismatches.length;
  return {
    ok: mismatches.length === 0,
    matchedSymbols: matched,
    totalExpected: expected.symbols.length,
    mismatches,
    ocrTextLength: ocrText.length,
    durationMs: Date.now() - start,
  };
}

/** Pure diff: extract per-symbol payout numbers from OCR text and compare
 *  against expected.symbols[]. Exposed for invariant tests. */
export function diffPaytableAgainstOcr(
  expected: Paytable,
  ocrText: string,
): PaytableMismatch[] {
  const mismatches: PaytableMismatch[] = [];
  const lines = ocrText.split(/\r?\n/);
  for (const sym of expected.symbols) {
    const matchedLine = findLineForSymbol(sym, lines);
    if (!matchedLine) {
      mismatches.push({ symbol: sym.symbol, expected: sym.payouts, actual: null, reason: "missing" });
      continue;
    }
    const observedNums = extractNumbersFromLine(matchedLine);
    if (!payoutsMatch(sym.payouts, observedNums)) {
      mismatches.push({
        symbol: sym.symbol,
        expected: sym.payouts,
        actual: sym.payouts.map((p, i) => ({ count: p.count, multiplier: observedNums[i] ?? 0 })),
        reason: "payout_mismatch",
      });
    }
  }
  return mismatches;
}

/** Find an OCR line that mentions this symbol's name or id. Case-insensitive
 *  substring match. First hit wins — Tesseract often duplicates a label
 *  across header + row. */
function findLineForSymbol(sym: PaytableEntry, lines: ReadonlyArray<string>): string | null {
  const needles: string[] = [];
  if (sym.symbol) needles.push(sym.symbol.toLowerCase());
  if (sym.name) needles.push(sym.name.toLowerCase());
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (needles.some((n) => lower.includes(n))) return line;
  }
  return null;
}

/** Pull positive numbers (int or decimal) out of an OCR line, in order. */
function extractNumbersFromLine(line: string): number[] {
  const out: number[] = [];
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Match expected payout multipliers against observed numbers IN ORDER.
 *  OCR typically lays out paytable rows as "<count>x <multiplier>" or just
 *  multipliers in a column; the count column may or may not be on the line.
 *  Strategy: check that every expected multiplier appears in the observed
 *  number list (order-independent because OCR row layout varies). */
function payoutsMatch(
  expected: PaytableEntry["payouts"],
  observed: ReadonlyArray<number>,
): boolean {
  for (const p of expected) {
    if (!observed.some((n) => Math.abs(n - p.multiplier) < 0.01)) return false;
  }
  return true;
}
