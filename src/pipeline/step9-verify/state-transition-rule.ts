import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { isValidTransition } from "../step6-build-model/state-machine.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

export class StateTransitionRule implements Rule {
  name = "state.valid_transition";

  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult {
    if (ctx.previousState === null) {
      return { ruleName: this.name, pass: true, severity: "info" };
    }
    const pass = isValidTransition(ctx.previousState, spin.state);
    return {
      ruleName: this.name,
      pass,
      expected: `valid from ${ctx.previousState}`,
      actual: spin.state,
      severity: pass ? "info" : "error",
      detail: pass ? undefined : `invalid transition ${ctx.previousState} -> ${spin.state}`,
    };
  }
}
