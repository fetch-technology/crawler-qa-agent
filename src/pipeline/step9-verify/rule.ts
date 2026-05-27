import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export type RuleResult = {
  ruleName: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
  severity: "error" | "warn" | "info";
};

export type RuleContext = {
  previousBalance: number | null;
  previousState: NormalizedSpinResult["state"] | null;
  roundIndex: number;
};

export interface Rule {
  name: string;
  appliesTo?: (spin: NormalizedSpinResult, ctx: RuleContext) => boolean;
  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult;
}
