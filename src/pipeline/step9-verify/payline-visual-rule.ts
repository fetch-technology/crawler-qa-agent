import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleResult } from "./rule.js";

/**
 * Payline visual rule: when a winning spin happens, the reels area must visually
 * change (line highlight, glow, line numbers). The UI-mode runner attaches the
 * post-click reels-region diff ratio to `spin.raw.__winDisplayDiff`.
 *
 *   - win > 0 AND diff >= minHighlightRatio → PASS
 *   - win > 0 AND diff < minHighlightRatio  → FAIL (server paid, UI didn't show it)
 *   - win == 0                              → no check
 *   - diff not set (api-mode)                → inconclusive INFO
 */
export class PaylineVisualRule implements Rule {
  name = "payline.visual_highlight";

  constructor(private readonly minHighlightRatio = 0.02) {}

  check(spin: NormalizedSpinResult): RuleResult {
    const diff = (spin.raw as Record<string, unknown>)["__winDisplayDiff"];
    if (typeof diff !== "number") {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "no win-display diff (likely api-mode)",
      };
    }
    if (spin.win === 0) {
      return { ruleName: this.name, pass: true, severity: "info" };
    }
    const pass = diff >= this.minHighlightRatio;
    return {
      ruleName: this.name,
      pass,
      expected: `diff >= ${this.minHighlightRatio}`,
      actual: diff,
      severity: pass ? "info" : "error",
      detail: pass
        ? undefined
        : `server win=${spin.win} but reels region diff ${diff.toFixed(3)} < ${this.minHighlightRatio} — UI did not display highlight`,
    };
  }
}
