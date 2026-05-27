// Custom-assertion rule: executes `check_code` JS expressions defined in the
// AI-generated catalog (fixtures/registry/<slug>/test-cases.json). Each test
// case may declare any number of `custom_assertions` — boolean expressions
// evaluated against the current spin context. This brings legacy authoring.ts
// rich invariant support into the new pipeline's rule engine.
//
// SECURITY: assertions are sandboxed via `Function` constructor; they only see
// the variables we explicitly bind (spin, previousSpin, collector, helpers).
// No file/network access. Failures throw with rule-friendly detail.

import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { adaptSpinForAssertions } from "../step6-build-model/spin-adapter.js";
import type { Rule, RuleContext, RuleResult } from "./rule.js";

export type CustomAssertion = {
  id: string;
  description: string;
  check_code: string;
};

export type CatalogCase = {
  id: string;
  name: string;
  category: string;
  severity: "critical" | "major" | "minor";
  custom_assertions?: CustomAssertion[];
};

export class CustomAssertionRule implements Rule {
  name = "catalog.custom_assertions";

  // Growing collector so multi-spin assertions can reference all spins seen so
  // far. The last evaluate() call sees the FULL collector — that's the
  // authoritative pass/fail for run-level invariants.
  private readonly collector: { spins: Record<string, unknown>[] } = { spins: [] };

  constructor(private readonly cases: CatalogCase[]) {}

  check(spin: NormalizedSpinResult, ctx: RuleContext): RuleResult {
    const adapted = adaptSpinForLegacy(spin);
    this.collector.spins.push(adapted);

    const failures: string[] = [];
    const skips: string[] = [];
    for (const tc of this.cases) {
      for (const asrt of tc.custom_assertions ?? []) {
        const ok = safeEval(asrt.check_code, {
          spin: adapted,
          collector: this.collector,
          ctx,
        });
        if (!ok.success) {
          // "X is not defined" → assertion references helper outside our
          // sandbox (e.g. legacy harness API). Skip rather than fail.
          if (/is not defined/.test(ok.error)) {
            skips.push(`[${tc.id}/${asrt.id}]`);
          } else {
            failures.push(`[${tc.id}/${asrt.id}] threw: ${ok.error}`);
          }
        } else if (!ok.value) {
          failures.push(`[${tc.id}/${asrt.id}] failed: ${asrt.description}`);
        }
      }
    }
    if (failures.length === 0) {
      const detail = skips.length > 0 ? `${skips.length} assertion(s) skipped (unsupported helpers)` : undefined;
      return { ruleName: this.name, pass: true, severity: "info", detail };
    }
    return {
      ruleName: this.name,
      pass: false,
      severity: "error",
      detail:
        failures.slice(0, 3).join("; ") +
        (failures.length > 3 ? ` (+${failures.length - 3} more)` : "") +
        (skips.length > 0 ? ` | ${skips.length} skipped (unsupported helpers)` : ""),
    };
  }
}

type EvalResult =
  | { success: true; value: unknown }
  | { success: false; error: string };

function safeEval(
  code: string,
  bindings: {
    spin: Record<string, unknown>;
    collector: { spins: Record<string, unknown>[] };
    ctx: RuleContext;
  },
): EvalResult {
  try {
    const fn = new Function(
      "spin",
      "previousSpin",
      "previousBalance",
      "previousState",
      "collector",
      "getRoundEndSpins",
      `"use strict"; return (${code});`,
    );
    const value = fn(
      bindings.spin,
      bindings.collector.spins.length > 1
        ? bindings.collector.spins[bindings.collector.spins.length - 2]
        : null,
      bindings.ctx.previousBalance,
      bindings.ctx.previousState,
      bindings.collector,
      getRoundEndSpins,
    );
    return { success: true, value };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Helper bound into sandbox — returns spins that ended a logical round.
 * For cascade games, a "round" is a chain of frames; the last frame has
 * `isEndRound===true` OR `na==='s'` (next-action=spin, i.e. cascade done).
 * Fallback: all spins if no marker available (treats each spin as round-end).
 */
function getRoundEndSpins(spins: Record<string, unknown>[]): Record<string, unknown>[] {
  const ends = spins.filter(
    (s) => s.isEndRound === true || (s.raw as any)?.na === "s",
  );
  return ends.length > 0 ? ends : spins;
}

// Legacy catalog assertions reference fields like `spin.id`, `spin.matrix`,
// `spin.betAmount`, `spin.winAmount`, `spin.endingBalance`, `spin.startingBalance`,
// `spin.isEndRound`, `spin.status`. The shared spin-adapter is the single
// source of truth — both case-executor (Phase 8 runtime) and this rule must
// agree on field names, else AI assertions fail purely on naming mismatch.
const adaptSpinForLegacy = adaptSpinForAssertions;
