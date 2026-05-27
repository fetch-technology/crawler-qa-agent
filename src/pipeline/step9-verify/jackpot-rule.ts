import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleResult } from "./rule.js";

export class JackpotOnceOnlyRule implements Rule {
  name = "jackpot.added_once_only";
  private seenIds = new Set<string>();

  check(spin: NormalizedSpinResult): RuleResult {
    const jackpotId = (spin.raw as Record<string, unknown>)["jackpotId"];
    if (typeof jackpotId !== "string") {
      return { ruleName: this.name, pass: true, severity: "info" };
    }
    if (this.seenIds.has(jackpotId)) {
      return {
        ruleName: this.name,
        pass: false,
        severity: "error",
        detail: `duplicate jackpot ${jackpotId}`,
      };
    }
    this.seenIds.add(jackpotId);
    return { ruleName: this.name, pass: true, severity: "info" };
  }
}
