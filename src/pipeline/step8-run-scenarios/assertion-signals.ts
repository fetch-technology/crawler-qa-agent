// Pure heuristic: scan a custom_assertion's check_code text and decide
// which evidence signals the predicate actually consults. The runtime
// confidence engine attaches these signals so per-assertion confidence
// reflects the depth of cross-checks (not just balance-only as before).
//
// Phase 11.4 — separated for testability. evaluateAssertions imports this
// and feeds the bool map into calcConfidence.
//
// Phase 11.4 refactor (C): ui_ocr signal credit is now PER-FIELD and
// data-availability-strict (mirrors balance-multi-signal.ts behavior).
// Previously a check_code mentioning `screen.bet` got ui_ocr ✓ via text-scan
// alone; now it ONLY credits when ocrBet actually returned a number at
// runtime. Eliminates the false-positive confidence cases where OCR
// silently failed but assertion still showed ui_ocr ✓.

import type { Signals } from "./evidence/types.js";

export type AssertionSignalRefs = {
  api: boolean;        // references spin / collector
  network: boolean;    // references warnings / networkBalance (or baseline traffic)
  ui_ocr: boolean;     // references screen.X AND that field has live OCR data
  state: boolean;      // references stateTimeline / interrupts
  rule: boolean;       // references helpers / arithmetic / type guards
};

export type DetectOpts = {
  spinsCaptured: number;
  hasOcrBalance: boolean;
  hasOcrBet: boolean;
  hasOcrLastWin: boolean;
};

/**
 * Scan check_code text → which signal sources does it reference?
 *
 * Heuristic is permissive for api/network/state/rule: a single mention
 * is enough to count the source. ui_ocr is STRICT — requires both:
 *   1. check_code references a specific screen.X field, AND
 *   2. that field's OCR data is actually available at runtime.
 *
 * Caller AND-combines with `pass` boolean to get the final signal value.
 */
export function detectAssertionSignals(
  checkCode: string,
  opts: DetectOpts = { spinsCaptured: 0, hasOcrBalance: false, hasOcrBet: false, hasOcrLastWin: false },
): AssertionSignalRefs {
  const code = checkCode ?? "";
  const apiRef = /\b(spin|collector|previousSpin)\b/.test(code);
  const networkRef =
    /\b(networkBalance|warnings)\b/.test(code)
    // Baseline: ANY captured-spin assertion implicitly relies on network
    // (responses came from page.on(response)). Avoid double-counting if
    // assertion doesn't touch spin/collector either.
    || (apiRef && opts.spinsCaptured > 0);

  // ui_ocr: per-field, data-strict (Phase 11.4 refactor C).
  //   - screen.balance referenced → only credit if hasOcrBalance
  //   - screen.bet referenced     → only credit if hasOcrBet
  //   - screen.last_win / .win / .total_win referenced → only credit if hasOcrLastWin
  // Multiple fields can be referenced — credit if ANY referenced-field has data.
  const screenBalanceRef = /\bscreen\.balance\b/.test(code);
  const screenBetRef = /\bscreen\.bet\b/.test(code);
  const screenWinRef = /\bscreen\.(last_win|total_win|win)\b/.test(code);
  const uiOcrRef =
    (screenBalanceRef && opts.hasOcrBalance) ||
    (screenBetRef && opts.hasOcrBet) ||
    (screenWinRef && opts.hasOcrLastWin);

  const stateRef = /\b(stateTimeline|interrupts)\b/.test(code);
  // `rule` signal fires when the assertion does ANY structured/typed check
  // beyond a bare equality. Includes:
  //   - Known helpers (detectBuyFeatureDeduction, etc.)
  //   - Math.* tolerance arithmetic
  //   - typeof guards
  //   - Array.isArray / Array structural checks (.length, .every, .some,
  //     .filter, .map, .reduce — these are the bread-and-butter of multi-spin
  //     assertions and used to be invisible to the heuristic)
  //   - Comparison against a literal (=== 5, >= 0.20, <= 0.01, !== null)
  //   - new Set(...) cardinality checks (uniqueness of round ids)
  //   - Numeric tolerance literal patterns (0.01, 0.001)
  const ruleRef =
    /\b(detectBuyFeatureDeduction|getRoundEndSpins|getCurrentBalance)\b/.test(code)
    || /\bMath\.(abs|max|min|round|floor|ceil)\b/.test(code)
    || /\btypeof\s+\w/.test(code)
    || /\bArray\.isArray\b/.test(code)
    || /\.(every|some|filter|map|reduce|find)\s*\(/.test(code)
    || /\bnew\s+Set\s*\(/.test(code)
    || /\.length\s*([<>!=]=?|===)/.test(code)
    || /[<>!=]==?\s*null\b/.test(code);
  return {
    api: apiRef,
    network: networkRef,
    ui_ocr: uiOcrRef,
    state: stateRef,
    rule: ruleRef,
  };
}

/**
 * Convert ref-map + verdict → Signals (bool map ready for calcConfidence).
 * AND-combine ref ∧ pass: only count a signal as "true" when the
 * assertion (which would consult that source) actually passed.
 */
export function signalsFromRefs(refs: AssertionSignalRefs, pass: boolean): Signals {
  return {
    api: refs.api && pass,
    network: refs.network && pass,
    ui_ocr: refs.ui_ocr && pass,
    state: refs.state && pass,
    rule: refs.rule && pass,
  };
}
