// Spin field adapter — exposes a NormalizedSpinResult through a richer shape
// that includes ALL field-name aliases AI-generated assertions may reference.
//
// Canonical fields (from NormalizedSpinResult):
//   roundId, bet, win, balanceBefore, balanceAfter, reels, state,
//   isFreeSpin, hasBonus, freeSpinsRemaining
//
// Aliases (legacy / alternative provider conventions):
//   id            ≡ roundId
//   betAmount     ≡ bet
//   winAmount     ≡ win
//   startingBalance ≡ balanceBefore
//   endingBalance ≡ balanceAfter
//   matrix        ≡ reels   (RG / Sweet Bonanza schema)
//   grid          ≡ reels
//   status        = "RESOLVED" (legacy)
//   isEndRound    = derived from raw.na (PP-specific)
//
// Currently aliases are hardcoded here. Phase 7.1A (per architecture plan)
// will move them to field-mapping.json so QA can add new aliases without
// touching code.
//
// IMPORTANT: this is the SINGLE SOURCE OF TRUTH. Both case-executor (Phase 7
// runtime) and custom-assertion-rule (Phase 9 verify) must call this — no
// per-file copies.

import type { NormalizedSpinResult } from "./normalized.js";

export type AdaptedSpin = Record<string, unknown>;

export function adaptSpinForAssertions(spin: NormalizedSpinResult): AdaptedSpin {
  const na = (spin.raw as Record<string, unknown> | undefined)?.na;
  return {
    // Canonical
    roundId: spin.roundId,
    bet: spin.bet,
    win: spin.win,
    balanceBefore: spin.balanceBefore ?? null,
    balanceAfter: spin.balanceAfter,
    reels: spin.reels,
    state: spin.state,
    isFreeSpin: spin.isFreeSpin,
    hasBonus: spin.hasBonus,
    freeSpinsRemaining: spin.freeSpinsRemaining,

    // Aliases
    id: spin.roundId,
    betAmount: spin.bet,
    winAmount: spin.win,
    startingBalance: spin.balanceBefore ?? null,
    endingBalance: spin.balanceAfter,
    matrix: spin.reels,
    grid: spin.reels,
    status: "RESOLVED",
    isEndRound: na === "s" || na === undefined,

    raw: spin.raw,
  };
}

/** Set of canonical field names plus all known aliases. Used by invariant
 *  tests and (later) by AI catalog validation to flag unknown field names
 *  in assertions before they fail at runtime. */
export const KNOWN_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Canonical
  "roundId", "bet", "win", "balanceBefore", "balanceAfter", "reels",
  "state", "isFreeSpin", "hasBonus", "freeSpinsRemaining",
  // Aliases
  "id", "betAmount", "winAmount", "startingBalance", "endingBalance",
  "matrix", "grid", "status", "isEndRound", "raw",
]);
