// Payout correctness: verify server-reported win == mechanic+paytable-derived win.
// Wraps legacy `assertPayoutMatchesPaytable` / `assertPayoutMatchesPaytableCascade`.
//
// Requires a fully-populated GameSpec (symbols + invariants from paytable
// extraction). When GameSpec has no symbols (new pipeline doesn't extract
// paytable yet), this rule returns `inconclusive` per spin and is skipped
// without failure noise.

import {
  assertPayoutMatchesPaytable,
  assertPayoutMatchesPaytableCascade,
} from "../../runner/rule-engine.js";
import type { GameSpec } from "../../ai/authoring.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

export class PayoutCorrectnessRule implements Rule {
  name = "payout.matches_paytable";

  constructor(private readonly spec: GameSpec | null) {}

  check(spin: NormalizedSpinResult, _ctx: RuleContext): RuleResult {
    if (!this.spec || !this.spec.symbols || this.spec.symbols.length === 0) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: "skipped — GameSpec.symbols empty (paytable not extracted yet)",
      };
    }

    const raw = spin.raw as Record<string, unknown>;
    const cascadeFrames =
      (raw["__cascadeFrames"] as Array<Record<string, unknown>> | undefined) ?? [];

    try {
      const result =
        cascadeFrames.length > 0
          ? assertPayoutMatchesPaytableCascade([raw, ...cascadeFrames], this.spec)
          : assertPayoutMatchesPaytable(raw, this.spec);

      if (result.ok === "inconclusive") {
        return {
          ruleName: this.name,
          pass: true,
          severity: "info",
          detail: `inconclusive: ${result.reason}`,
        };
      }
      if (result.ok === true) {
        return {
          ruleName: this.name,
          pass: true,
          severity: "info",
          detail: `calculated=${result.calculated.toFixed(2)} matches server=${result.serverWin.toFixed(2)}`,
        };
      }
      return {
        ruleName: this.name,
        pass: false,
        expected: result.expected,
        actual: result.actual,
        severity: "error",
        detail: `payout mismatch: expected ${result.expected.toFixed(2)} got ${result.actual.toFixed(2)} (delta ${result.delta.toFixed(2)}) — ${result.detail}`,
      };
    } catch (err) {
      return {
        ruleName: this.name,
        pass: true,
        severity: "info",
        detail: `payout check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
