export type { Rule, RuleContext, RuleResult } from "./rule.js";

export type RuleEngineSummary = {
  totalSpins: number;
  totalRules: number;
  passed: number;
  failed: number;
  results: Array<{ roundIndex: number; results: import("./rule.js").RuleResult[] }>;
};
