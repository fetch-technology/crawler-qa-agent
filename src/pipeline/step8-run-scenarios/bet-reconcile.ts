// Pure bet-from-balance reconciliation, extracted so it can be unit-tested in
// isolation (no Playwright, no async). Used by case-executor's response
// listener right after balanceBefore is resolved.
//
// Why this exists: some providers apply a bet surcharge SERVER-SIDE that never
// appears in the doSpin request — most notably Pragmatic's "Ante Bet" / Double
// Chance (×1.25, sometimes ×1.5/×1.9). The parser can only read request fields,
// so on an ante-ON spin it returns the BASE wager (or, when the request encodes
// the stake via a field the parser doesn't treat as the multiplier, it can even
// return the bare coin). The balance is the ground truth: drop = bet − win, and
// the server's round win (`serverTotalWin` / PP `tw`, empirically validated
// reliable for PP at round level) lets us recover bet = drop + win.
//
// IMPORTANT: this is a NO-OP except on the exact failure mode, so the rounds
// whose request bet is already correct — and games where the request encodes a
// genuine per-level stake multiplier (e.g. PP `bl` as a bet level) — are never
// touched. The request-field formula stays the source of truth; balance only
// CORRECTS it when the two provably disagree.

import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export type ReconcileInput = Pick<
  NormalizedSpinResult,
  "bet" | "win" | "balanceBefore" | "balanceAfter" | "serverTotalWin" | "isFreeSpin" | "freeSpinsRemaining" | "hasBonus"
>;

/**
 * Returns the balance-derived { bet, win } when the parser's request-derived bet
 * violates money conservation, or null when no correction applies (the common
 * case). Pure — exercised by tests/invariants/bet-reconcile.spec.ts.
 */
export function reconcileBetFromBalance(spin: ReconcileInput, tol = 0.01): { bet: number; win: number } | null {
  // Free spins carry no deduction — bet is 0 by design, balance is flat.
  if (spin.isFreeSpin) return null;

  // Feature buys / scatter triggers: the deduction includes a purchase premium
  // (a buy is 50–500× the base bet) that must NOT be folded into the per-spin
  // bet — the buy-cost ratio assertion depends on bet staying = base wager.
  // A buy always grants free spins / a bonus, so this flag separates it from a
  // plain ante-inflated spin (which never triggers a feature).
  if ((spin.freeSpinsRemaining ?? 0) > 0 || spin.hasBonus === true) return null;

  const { balanceBefore, balanceAfter, serverTotalWin } = spin;
  if (balanceBefore == null || !Number.isFinite(balanceAfter as number)) return null;
  if (typeof serverTotalWin !== "number" || !Number.isFinite(serverTotalWin)) return null;

  const drop = (balanceBefore as number) - (balanceAfter as number);

  // Wallet moved by EXACTLY the request bet → that bet is correct and any
  // serverTotalWin is simply NOT YET credited. PP credits tumble / round wins
  // on a later `doCollect`; a frame captured before that shows drop = bet with
  // the win still pending. `impliedBet = drop + serverTotalWin` would then fold
  // the uncredited win INTO bet (observed: 1.00 → 6.60 on a 5.60 tumble win).
  // Only a deduction that DIFFERS from the request bet signals a hidden
  // surcharge (ante / Double-Chance) worth reconciling.
  if (Math.abs(drop - spin.bet) <= tol) return null;

  const impliedBet = Math.round((drop + serverTotalWin) * 100) / 100;

  // Already conserved (drop = bet − win) → request bet is correct, leave it.
  if (Math.abs((spin.bet - serverTotalWin) - drop) <= tol) return null;

  // Implausible (e.g. a credit-only frame) — don't invent a non-positive bet.
  if (!(impliedBet > 0)) return null;

  return { bet: impliedBet, win: serverTotalWin };
}
