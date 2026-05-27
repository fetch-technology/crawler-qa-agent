import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";
import type { RuleEngineSummary } from "./types.js";

export class RuleEngine {
  private rules: Rule[] = [];
  private results: Array<{ roundIndex: number; results: RuleResult[] }> = [];

  constructor(rules: Rule[]) {
    this.rules = rules;
  }

  evaluate(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult[] {
    const out: RuleResult[] = [];
    for (const rule of this.rules) {
      if (rule.appliesTo && !rule.appliesTo(spin, ctx)) continue;
      out.push(rule.check(spin, ctx));
    }
    this.results.push({ roundIndex: ctx.roundIndex, results: out });
    return out;
  }

  summary(): RuleEngineSummary {
    let passed = 0;
    let failed = 0;
    for (const r of this.results) {
      for (const x of r.results) {
        if (x.pass) passed++;
        else if (x.severity === "error") failed++;
      }
    }
    return {
      totalSpins: this.results.length,
      totalRules: this.rules.length,
      passed,
      failed,
      results: this.results,
    };
  }
}
