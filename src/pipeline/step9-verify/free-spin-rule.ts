import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

export class FreeSpinNoDeductRule implements Rule {
  name = "free_spin.no_balance_deduct";

  appliesTo(spin: NormalizedSpinResult): boolean {
    return spin.state === "FREE_SPIN" || spin.isFreeSpin;
  }

  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult {
    const before = spin.balanceBefore ?? ctx.previousBalance;
    if (before === null) {
      return { ruleName: this.name, pass: true, severity: "info", detail: "no previous balance" };
    }
    const expected = before + spin.win;
    const actual = spin.balanceAfter;
    const pass = Math.abs(expected - actual) < 0.01;
    return {
      ruleName: this.name,
      pass,
      expected,
      actual,
      severity: pass ? "info" : "error",
      detail: pass ? undefined : `free spin must not deduct bet; expected ${expected} got ${actual}`,
    };
  }
}
