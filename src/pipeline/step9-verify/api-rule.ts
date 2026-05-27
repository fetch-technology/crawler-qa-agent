import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleResult } from "./rule.js";

export class ApiResponseShapeRule implements Rule {
  name = "api.response_shape";
  private seenRoundIds = new Set<string>();

  check(spin: NormalizedSpinResult): RuleResult {
    if (!spin.roundId) {
      return { ruleName: this.name, pass: false, severity: "error", detail: "missing roundId" };
    }
    if (this.seenRoundIds.has(spin.roundId)) {
      return {
        ruleName: this.name,
        pass: false,
        severity: "error",
        detail: `duplicate roundId ${spin.roundId}`,
      };
    }
    this.seenRoundIds.add(spin.roundId);
    if (spin.balanceAfter < 0) {
      return {
        ruleName: this.name,
        pass: false,
        severity: "error",
        detail: `negative balanceAfter ${spin.balanceAfter}`,
      };
    }
    return { ruleName: this.name, pass: true, severity: "info" };
  }
}
