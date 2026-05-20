/**
 * Balance reconciliation — verify the running balance is conserved across a
 * sequence of spins.
 *
 * Conservation rule:
 *   normal spin:  balanceAfter[i] = balanceAfter[i-1] - bet[i] + win[i]
 *   free spin:    balanceAfter[i] = balanceAfter[i-1] + win[i]      (no deduction)
 *
 * The caller passes a list of `SpinResponse` (from the GameAdapter). Each
 * spin's `isFreeSpin` flag drives whether bet is deducted. Returns one
 * `BalanceMismatch` per spin that breaks the chain (empty array = clean).
 */

import type { SpinResponse } from "../adapters/types.js";

export type BalanceMismatch = {
  spinIndex: number;
  expected: number;
  actual: number;
  delta: number;
  isFreeSpin: boolean;
  detail: string;
};

export type ReconcileOpts = {
  /** Tolerance for float comparison. Default 0.01. */
  tolerance?: number;
  /** Starting balance. If null, taken from spins[0].balanceBefore. */
  startingBalance?: number | null;
};

/**
 * Reconcile a series of spins. Returns mismatches (empty = OK).
 *
 * Notes:
 *   - If `spin.balanceBefore` is present, it's checked against the previous
 *     spin's balanceAfter (catches server-side jumps).
 *   - First-spin's `balanceBefore` is checked against `startingBalance`
 *     (when both provided).
 */
export function reconcileBalances(
  spins: SpinResponse[],
  opts: ReconcileOpts = {},
): BalanceMismatch[] {
  const tolerance = opts.tolerance ?? 0.01;
  const errors: BalanceMismatch[] = [];
  let runningBalance: number | null =
    opts.startingBalance ?? spins[0]?.balanceBefore ?? null;

  for (let i = 0; i < spins.length; i++) {
    const spin = spins[i]!;

    // If we know the starting balance for this spin, verify it matches running.
    if (spin.balanceBefore != null && runningBalance != null) {
      const drift = Math.abs(spin.balanceBefore - runningBalance);
      if (drift > tolerance) {
        errors.push({
          spinIndex: i,
          expected: runningBalance,
          actual: spin.balanceBefore,
          delta: spin.balanceBefore - runningBalance,
          isFreeSpin: spin.isFreeSpin,
          detail: `Spin ${i} balanceBefore=${spin.balanceBefore} doesn't match running ${runningBalance}`,
        });
        // Resync to server's value to avoid cascading errors
        runningBalance = spin.balanceBefore;
      }
    }

    if (runningBalance == null) {
      // No reference; resync from this spin's after-value
      runningBalance = spin.balanceAfter;
      continue;
    }

    const deduction = spin.isFreeSpin ? 0 : spin.bet;
    const expectedAfter = runningBalance - deduction + spin.win;
    const drift = Math.abs(spin.balanceAfter - expectedAfter);
    if (drift > tolerance) {
      errors.push({
        spinIndex: i,
        expected: expectedAfter,
        actual: spin.balanceAfter,
        delta: spin.balanceAfter - expectedAfter,
        isFreeSpin: spin.isFreeSpin,
        detail:
          `Spin ${i} balanceAfter=${spin.balanceAfter} ≠ ` +
          `expected ${expectedAfter.toFixed(4)} ` +
          `(prev=${runningBalance} ${spin.isFreeSpin ? "[free-spin: no deduction]" : `- bet=${spin.bet}`} + win=${spin.win})`,
      });
    }
    runningBalance = spin.balanceAfter;
  }

  return errors;
}

/** Convenience: throw if any mismatch — for use in test assertions. */
export function assertBalancesReconcile(
  spins: SpinResponse[],
  opts: ReconcileOpts = {},
): void {
  const errors = reconcileBalances(spins, opts);
  if (errors.length === 0) return;
  const sample = errors.slice(0, 3).map((e) => `  • ${e.detail}`).join("\n");
  throw new Error(
    `BALANCE_MISMATCH: ${errors.length} spin(s) failed reconciliation:\n${sample}` +
      (errors.length > 3 ? `\n  …and ${errors.length - 3} more` : ""),
  );
}
