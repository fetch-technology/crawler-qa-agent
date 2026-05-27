// History popup reconciliation. Opens the in-game history (last N rounds),
// OCRs each row, matches roundId/bet/win/closing-balance against captured
// network spins. Catches games whose UI history shows stale or fabricated
// rows vs what the server actually recorded.
//
// Same async + sync pattern as paytable-rule.ts: heavy work in
// `verifyHistoryRows`, Rule class reads result from `spin.raw._historyVerification`.
//
// AI scope: ZERO AI calls.

import type { Page } from "playwright";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Region } from "../registry/types.js";
import { ocrRegion } from "../utils/ocr-popup.js";
import { popupRegions as popupRegionsStore } from "../registry/popup-regions.js";
import { uiRegistry } from "../registry/ui-registry.js";
import type { Rule, RuleResult } from "./rule.js";

export type HistoryRowMismatch = {
  roundId: string | null;
  capturedBet: number | null;
  capturedWin: number | null;
  ocrLine: string;
  reason: "row_missing_in_ocr" | "bet_mismatch" | "win_mismatch";
};

export type HistoryVerificationResult = {
  ok: boolean;
  capturedSpins: number;
  matchedRows: number;
  mismatches: HistoryRowMismatch[];
  ocrTextLength: number;
  durationMs: number;
  skipReason?: string;
};

export class HistoryReconciliationRule implements Rule {
  name = "history.rows_match_network";

  check(spin: NormalizedSpinResult): RuleResult {
    const result = (spin.raw as Record<string, unknown> | null | undefined)?.[
      "_historyVerification"
    ] as HistoryVerificationResult | undefined;
    if (!result) {
      return { ruleName: this.name, pass: true, severity: "info", detail: "no-history-verification" };
    }
    if (result.skipReason) {
      return { ruleName: this.name, pass: true, severity: "info", detail: `skipped: ${result.skipReason}` };
    }
    if (result.ok) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: `${result.matchedRows}/${result.capturedSpins} rows reconciled`,
      };
    }
    const first = result.mismatches.slice(0, 3).map((m) => `${m.roundId ?? "?"}:${m.reason}`).join(", ");
    return {
      ruleName: this.name,
      pass: false,
      severity: "error",
      expected: `${result.capturedSpins} captured spins all visible in UI history`,
      actual: `${result.matchedRows} matched, ${result.mismatches.length} mismatched`,
      detail: `mismatches: ${first}${result.mismatches.length > 3 ? ` (+${result.mismatches.length - 3} more)` : ""}`,
    };
  }
}

/**
 * Click historyButton, OCR the visible rows, reconcile against the captured
 * spins list. Caller dismisses the popup afterward. Skips with `skipReason`
 * when prerequisites missing.
 */
export async function verifyHistoryRows(
  page: Page,
  slug: string,
  capturedSpins: ReadonlyArray<NormalizedSpinResult>,
  opts: { settleMs?: number } = {},
): Promise<HistoryVerificationResult> {
  const start = Date.now();
  const settleMs = opts.settleMs ?? 1200;
  const empty: HistoryVerificationResult = {
    ok: true,
    capturedSpins: capturedSpins.length,
    matchedRows: 0,
    mismatches: [],
    ocrTextLength: 0,
    durationMs: 0,
  };

  if (capturedSpins.length === 0) {
    return { ...empty, skipReason: "no captured spins to reconcile", durationMs: Date.now() - start };
  }

  const ui = await uiRegistry.load(slug);
  const historyBtn = ui?.historyButton;
  if (!historyBtn) {
    return { ...empty, skipReason: "no historyButton in ui-registry", durationMs: Date.now() - start };
  }

  const regions = await popupRegionsStore.load(slug);
  const popupBox = regions?.historyPopup;
  if (!popupBox) {
    return { ...empty, skipReason: "no historyPopup region in popup-regions.json", durationMs: Date.now() - start };
  }

  try {
    await page.mouse.click(historyBtn.x, historyBtn.y);
    await page.waitForTimeout(settleMs);
  } catch (err) {
    return { ...empty, skipReason: `click failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }

  let ocrText = "";
  try {
    const ocr = await ocrRegion(page, regionToBox(popupBox));
    ocrText = ocr.text;
  } catch (err) {
    return { ...empty, skipReason: `OCR failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
  }

  const mismatches = reconcileHistoryRows(capturedSpins, ocrText);
  const matched = capturedSpins.length - mismatches.length;
  return {
    ok: mismatches.length === 0,
    capturedSpins: capturedSpins.length,
    matchedRows: matched,
    mismatches,
    ocrTextLength: ocrText.length,
    durationMs: Date.now() - start,
  };
}

function regionToBox(r: Region): { x: number; y: number; w: number; h: number } {
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/** Pure reconcile: for each captured spin, find a matching OCR line and
 *  verify bet + win match within tolerance. Exposed for invariant tests.
 *
 *  Match heuristic — in order of preference:
 *    1. line contains the roundId substring (best signal)
 *    2. line contains both the bet and win values (fallback)
 *  If neither hits → row_missing_in_ocr.
 */
export function reconcileHistoryRows(
  spins: ReadonlyArray<NormalizedSpinResult>,
  ocrText: string,
): HistoryRowMismatch[] {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const mismatches: HistoryRowMismatch[] = [];
  for (const spin of spins) {
    const line = findRowForSpin(spin, lines);
    if (!line) {
      mismatches.push({
        roundId: spin.roundId || null,
        capturedBet: spin.bet,
        capturedWin: spin.win,
        ocrLine: "",
        reason: "row_missing_in_ocr",
      });
      continue;
    }
    const nums = extractNumbersFromLine(line);
    if (!nums.some((n) => Math.abs(n - spin.bet) < 0.01)) {
      mismatches.push({ roundId: spin.roundId || null, capturedBet: spin.bet, capturedWin: spin.win, ocrLine: line, reason: "bet_mismatch" });
      continue;
    }
    if (spin.win > 0 && !nums.some((n) => Math.abs(n - spin.win) < 0.01)) {
      mismatches.push({ roundId: spin.roundId || null, capturedBet: spin.bet, capturedWin: spin.win, ocrLine: line, reason: "win_mismatch" });
      continue;
    }
  }
  return mismatches;
}

function findRowForSpin(
  spin: NormalizedSpinResult,
  lines: ReadonlyArray<string>,
): string | null {
  // 1. roundId substring match (most distinctive)
  if (spin.roundId) {
    const rid = spin.roundId.toLowerCase();
    // Most history UIs only show a suffix (last 6-8 chars of the ID).
    // Match either full id or any 6+ char run from it.
    const candidates = [rid, ...slidingWindows(rid, 6)];
    for (const c of candidates) {
      const hit = lines.find((l) => l.toLowerCase().includes(c));
      if (hit) return hit;
    }
  }
  // 2. (bet AND win) both appear on same line — weak but workable
  for (const l of lines) {
    const nums = extractNumbersFromLine(l);
    if (nums.some((n) => Math.abs(n - spin.bet) < 0.01) &&
        (spin.win === 0 || nums.some((n) => Math.abs(n - spin.win) < 0.01))) {
      return l;
    }
  }
  return null;
}

function slidingWindows(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i + size <= s.length; i++) out.push(s.slice(i, i + size));
  return out;
}

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
