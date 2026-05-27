import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

const DEFAULT_TOLERANCE = 0.01;

export class FinancialRule implements Rule {
  name = "financial.balance_equation";

  appliesTo(spin: NormalizedSpinResult): boolean {
    return spin.state === "NORMAL" || spin.state === "BONUS";
  }

  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult {
    const before = spin.balanceBefore ?? ctx.previousBalance;
    if (before === null) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "no previous balance — skipped",
      };
    }
    const expected = before - spin.bet + spin.win;
    const actual = spin.balanceAfter;
    const pass = Math.abs(expected - actual) < DEFAULT_TOLERANCE;
    return {
      ruleName: this.name,
      pass,
      expected,
      actual,
      severity: pass ? "info" : "error",
      detail: pass
        ? undefined
        : `expected balance ${expected.toFixed(4)} but got ${actual.toFixed(4)}`,
    };
  }
}
