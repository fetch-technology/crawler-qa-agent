import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleResult } from "./rule.js";

/**
 * UI balance OCR vs API balance cross-check.
 *
 * How it gets data: this rule reads `spin.raw._ocrBalance` (number) if
 * present. Upstream (typically case-executor, or any orchestrator that has a
 * live Page) is responsible for OCRing the balance widget at end-of-spin and
 * stamping the value into the spin's raw record. When absent, the rule
 * returns pass=true with detail "no-ocr-data" so it's a no-op in pipelines
 * that don't have a Page (massive-spin api-mode samples have no UI to OCR).
 *
 * Tolerance: 0.05 — OCR rounds at the cent level and slot UIs sometimes
 * display an animating balance that hasn't quite landed when the snapshot
 * fires. Larger drift than 5¢ usually indicates a real desync (cached UI
 * balance vs settled server balance).
 *
 * Why a separate rule (not folded into FinancialRule): FinancialRule checks
 * API-level invariants (server math). This rule checks CLIENT-DISPLAY
 * accuracy — orthogonal failure modes. A game can have correct server math
 * but a UI lag bug.
 */
const DEFAULT_TOLERANCE = 0.05;

export class UiBalanceMatchesApiRule implements Rule {
  name = "ui.balance_matches_api";

  check(spin: NormalizedSpinResult): RuleResult {
    const ocr = readOcrBalance(spin);
    if (ocr === null) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "no-ocr-data",
      };
    }
    if (!Number.isFinite(spin.balanceAfter)) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "no-api-balance",
      };
    }
    const diff = Math.abs(ocr - spin.balanceAfter);
    const pass = diff < DEFAULT_TOLERANCE;
    return {
      ruleName: this.name,
      pass,
      expected: spin.balanceAfter,
      actual: ocr,
      severity: pass ? "info" : "error",
      detail: pass
        ? undefined
        : `UI displayed ${ocr.toFixed(2)} but API settled at ${spin.balanceAfter.toFixed(2)} (diff ${diff.toFixed(2)})`,
    };
  }
}

function readOcrBalance(spin: NormalizedSpinResult): number | null {
  const raw = spin.raw as Record<string, unknown> | null | undefined;
  if (!raw) return null;
  const v = raw["_ocrBalance"];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}
