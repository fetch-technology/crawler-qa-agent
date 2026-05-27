// Shared helpers for invariant tests. Pure synthetic factories — no I/O,
// no browser. Tests should run in milliseconds and have zero flakiness.

import type { NormalizedSpinResult, SpinState } from "../../src/pipeline/step6-build-model/normalized.js";

export function synthSpin(overrides: Partial<NormalizedSpinResult> = {}): NormalizedSpinResult {
  // Use 'in' check to distinguish "not provided" from "explicitly null".
  // `??` operator coerces null to default — that breaks tests for null
  // balanceBefore (first-spin scenario).
  const balanceBefore: number | null = "balanceBefore" in overrides
    ? overrides.balanceBefore as number | null
    : 1000;
  const bet = overrides.bet ?? 10;
  const win = overrides.win ?? 0;
  const defaultBalanceAfter = (typeof balanceBefore === "number" ? balanceBefore : 1000) - bet + win;
  return {
    roundId: overrides.roundId ?? "round-1",
    bet,
    win,
    balanceBefore,
    balanceAfter: overrides.balanceAfter ?? defaultBalanceAfter,
    reels: overrides.reels ?? [["A", "B", "C"], ["D", "E", "F"], ["G", "H", "I"]],
    cascadeFrames: overrides.cascadeFrames ?? [],
    state: overrides.state ?? ("NORMAL" as SpinState),
    freeSpinsRemaining: overrides.freeSpinsRemaining ?? null,
    isFreeSpin: overrides.isFreeSpin ?? false,
    hasBonus: overrides.hasBonus ?? false,
    raw: overrides.raw ?? {},
  };
}

/**
 * Compute drop = balanceBefore - balanceAfter (positive when balance decreased).
 * Used by balance-rule invariants.
 */
export function computeDrop(spin: NormalizedSpinResult): number | null {
  if (spin.balanceBefore === null) return null;
  return spin.balanceBefore - spin.balanceAfter;
}

/**
 * Expected drop given bet and win for a non-free spin:
 *   drop == bet - win
 * For free spin (no deduction): drop should equal -win (balance only rises).
 */
export function expectedDrop(spin: NormalizedSpinResult): number {
  if (spin.isFreeSpin) return -spin.win;
  return spin.bet - spin.win;
}

/**
 * Check whether observed balance change matches expected.
 * Tolerance: 0.01 for float jitter.
 */
export function balanceConserved(spin: NormalizedSpinResult, tolerance = 0.01): boolean {
  const drop = computeDrop(spin);
  if (drop === null) return true; // skip when startingBalance unknown
  return Math.abs(drop - expectedDrop(spin)) <= tolerance;
}

/**
 * PP-style querystring request body builder for parser-determinism tests.
 */
export function ppRequestBody(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/**
 * PP-style response body builder. Minimal valid shape for canParseResponse.
 */
export function ppResponseBody(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}
