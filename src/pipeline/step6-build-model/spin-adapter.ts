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
  const raw = spin.raw as Record<string, unknown> | undefined;
  // A frame is the END of a paid round UNLESS it is a tumble CONTINUATION.
  // `na` alone is not enough: PP sets na="c" ("next action = collect") on BOTH
  // (a) a mid-cascade tumble frame AND (b) a completed WINNING line-spin whose
  // win just needs collecting. Treating na="c" as "not ended" wrongly dropped
  // every winning line-spin from the round-end set (vs10hottuna autoplay: 3 of
  // 10 winning rounds excluded → "at least 10 round-end" failed at 7, and the
  // round-end-only balance reconciliation was off by the excluded wins). A real
  // tumble continuation always carries a tumble marker (rs_t>0 / rs_p>0 /
  // rs_c>1) — same discriminator as cascade-dedup — so only THOSE are non-end.
  // Post-dedup the surviving frame of a merged tumble round is its na="s" start,
  // which is correctly an end-round here too.
  const toNum = (v: unknown): number => (v == null ? NaN : Number(v));
  const rsTier = toNum(raw?.["rs_t"]);
  const rsPhase = toNum(raw?.["rs_p"]);
  const rsCount = toNum(raw?.["rs_c"]);
  const isTumbleContinuation =
    (Number.isFinite(rsTier) && rsTier > 0)
    || (Number.isFinite(rsPhase) && rsPhase > 0)
    || (Number.isFinite(rsCount) && rsCount > 1);

  // Balance-derived win (2026-06-05). Providers like Pragmatic Play debit the
  // bet on `doSpin` but credit the win asynchronously on `doCollect` (round
  // end), so the per-response `win` field can read 0 even when that round pays
  // — the credit then shows up on a LATER response. Summing the server `win`
  // across an autoplay batch therefore under-counts, and
  // `start − Σbet + Σwin` drifts from the real wallet delta (observed: 0.28).
  // Deriving win from the wallet movement itself (balanceAfter − balanceBefore
  // + bet) re-attributes each credit to the response where it actually landed,
  // so Σwin reconciles to the true balance change. Falls back to the
  // server-reported win when either balance is unknown.
  // NOTE: this only affects the assertion-facing shape (collector.spins / win /
  // winAmount). The per-spin FinancialRule reads NormalizedSpinResult.win
  // directly, so it keeps the raw server win and is NOT made tautological.
  // Payout-integrity (winBreakdown / serverTotalWin) is preserved untouched.
  const bb = spin.balanceBefore;
  const ba = spin.balanceAfter;
  const bet = typeof spin.bet === "number" ? spin.bet : 0;
  const balanceDerivedWin =
    typeof bb === "number" && Number.isFinite(bb) && Number.isFinite(ba)
      ? Math.round((ba - bb + bet) * 100) / 100 // round to currency precision
      : null;
  const serverWin = spin.win;
  const win = balanceDerivedWin ?? serverWin;

  return {
    // Canonical
    roundId: spin.roundId,
    bet: spin.bet,
    win,
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
    winAmount: win,
    startingBalance: spin.balanceBefore ?? null,
    endingBalance: spin.balanceAfter,
    matrix: spin.reels,
    grid: spin.reels,
    status: "RESOLVED",
    isEndRound: !isTumbleContinuation,

    raw: spin.raw,

    // Raw server-reported win for assertions that explicitly need the
    // provider's per-response value (not the balance-derived one).
    serverWin,

    // Payout-integrity inputs (PP wlc_v). winBreakdown is accumulated across
    // tumble frames by cascade-dedup; serverTotalWin is the round's `tw`.
    winBreakdown: spin.winBreakdown ?? [],
    serverTotalWin: spin.serverTotalWin ?? null,
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
  // Raw server win (balance-derived win is the default for win/winAmount)
  "serverWin",
  // Payout-integrity
  "winBreakdown", "serverTotalWin",
]);
