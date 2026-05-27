import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

export class BuyBonusCostRule implements Rule {
  name = "buy_bonus.exact_cost_deducted";

  constructor(private expectedCost: number) {}

  appliesTo(spin: NormalizedSpinResult): boolean {
    return spin.hasBonus && spin.state === "BONUS";
  }

  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult {
    const before = spin.balanceBefore ?? ctx.previousBalance;
    if (before === null) {
      return { ruleName: this.name, pass: true, severity: "info" };
    }
    const expected = before - this.expectedCost + spin.win;
    const actual = spin.balanceAfter;
    const pass = Math.abs(expected - actual) < 0.01;
    return {
      ruleName: this.name,
      pass,
      expected,
      actual,
      severity: pass ? "info" : "error",
      detail: pass ? undefined : `buy bonus cost ${this.expectedCost} mismatch`,
    };
  }
}
