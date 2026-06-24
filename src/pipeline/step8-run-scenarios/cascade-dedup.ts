// Pure cascade-frame dedup logic, extracted from case-executor's response
// listener so it can be unit-tested in isolation (no Playwright, no async).
//
// Strategy:
//   1. Match by roundId (primary) — works when parser builds stable IDs
//   2. Match by balance continuity (fallback) — for games where cascade
//      frames have NEW roundIds but continuous balance flow with no bet
//      deduction (PP vswaysmahwin2-style)
//
// On merge: keep first frame's balanceBefore + bet, override balanceAfter
// from latest frame, DERIVE win = balanceAfter - balanceBefore + bet
// (canonical source — PP `tw` is unreliable across providers).

import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export type CascadeDedupOptions = {
  /** Continuity tolerance for float comparison (default 0.01). */
  balanceTolerance?: number;
  /** When true (default), derive win from balance delta + bet on merged
   *  rounds. When false, keep latest frame's parser-reported win. */
  deriveWinFromBalance?: boolean;
  /** When true (default), allow balance-continuity fallback merge. When
   *  false, only roundId-based matching is used. */
  allowBalanceContinuity?: boolean;
};

export type DedupState = {
  spins: NormalizedSpinResult[];
  byRoundId: Map<string, number>;
};

export function createDedupState(): DedupState {
  return { spins: [], byRoundId: new Map() };
}

/**
 * Ingest a single parsed spin (could be initial bet frame or cascade frame).
 * Mutates state. Returns "merged" | "appended" so callers can log.
 */
export function ingestFrame(
  state: DedupState,
  spin: NormalizedSpinResult,
  opts: CascadeDedupOptions = {},
): "merged" | "appended" {
  const tol = opts.balanceTolerance ?? 0.01;
  const deriveWin = opts.deriveWinFromBalance !== false;
  const allowContinuity = opts.allowBalanceContinuity !== false;

  const rid = spin.roundId;
  const last = state.spins.length > 0 ? state.spins[state.spins.length - 1] : null;

  const matchByRid = rid && state.byRoundId.has(rid) ? state.byRoundId.get(rid)! : -1;

  // Cascade/tumble continuation — AUTHORITATIVE merge via the game's own tumble
  // markers (not a balance heuristic). PP tumble games (e.g. vs20swordofares)
  // emit MULTIPLE doSpin responses for ONE bet: a round-start frame
  // (na=s, rs_c=1, rs_p=0) followed by continuation frames, then a doCollect.
  // CRITICAL: each frame is a SEPARATE doSpin request with an INCREMENTING
  // index, so buildRoundId (`req-<index>-<counter>`) yields a DIFFERENT roundId
  // for every frame → the roundId path can never merge them. They also don't
  // move balance until the round's doCollect. So continuation frames leak as
  // separate spins (autoplay 10 → 12+ captured) unless caught by markers.
  //
  // Continuation markers (any one ⇒ this frame belongs to the previous round):
  //   - rs_t > 0     — running cascade-tier flag (set on tumble frames)
  //   - rs_p > 0     — tumble phase advanced past the round-start
  //   - rs_c > 1     — tumble-frame counter past the first
  // Round-start frames are rs_c=1/rs_p=0 and no rs_t → NOT a continuation.
  // Classic line games have none of these → Number(undefined)=NaN → no false
  // positives. Markers work even when balance-continuity is disabled
  // (case-executor turns it off to avoid mis-merging distinct autoplay rounds).
  // A continuation merges into the LAST appended round, since frames arrive
  // contiguously before the next bet's doSpin.
  //
  // NOTE (2026-06-15): `na === "c"` was REMOVED as a standalone marker. In PP
  // `na` is "next action" — `na=c` means "this spin produced a win, next action
  // is doCollect", which is true of EVERY winning line-spin, NOT just tumble
  // continuations. On vs10hottuna (line game, BRL) consecutive winning spins
  // (#5 lose → #6 win, distinct roundIds, each its own bet+collect) were being
  // merged because #6 carried na=c → the merged record showed bet=90 (45+45),
  // the spin count undercounted (collectedSpins didn't grow → executor logged
  // "debounced"), and the bet-consistency assertion saw false drift. A genuine
  // tumble continuation ALWAYS carries a tumble marker (swordofares frames pair
  // na=c WITH rs_t>0), so requiring rs_t/rs_p/rs_c keeps tumble merges working
  // while no longer fusing independent winning spins.
  const raw = spin.raw as Record<string, unknown> | undefined;
  const toNum = (v: unknown): number => (v == null ? NaN : Number(v));
  const rsPhase = toNum(raw?.["rs_p"]);
  const rsCount = toNum(raw?.["rs_c"]);
  const rsTier = toNum(raw?.["rs_t"]);
  const isCascadeContinuation =
    (Number.isFinite(rsTier) && rsTier > 0)
    || (Number.isFinite(rsPhase) && rsPhase > 0)
    || (Number.isFinite(rsCount) && rsCount > 1);
  // FS-frame exclusion (mirrors the balance-continuity gate below): a clone may
  // OVERLOAD a tumble marker as a free-spin index — vs20daydead's free respins
  // carry rs_p=1/2/3, which would (wrongly) match isCascadeContinuation and
  // swallow the whole FS chain into the buy round (1 spin captured instead of N,
  // bet balance-derived). A genuine tumble continuation is never a free spin
  // (base-game tumbles keep state=NORMAL; cascades WITHIN a free spin share a
  // roundId and merge on the matchByRid path above), so gating on !isFreeSpin is
  // safe and keeps real tumble merges working. Requires upstream FS detection
  // (parser fs field / Layer-4 heuristic / learned signal) to have run first.
  const matchByCascadeMarker =
    isCascadeContinuation && !spin.isFreeSpin && last ? state.spins.length - 1 : -1;

  // Balance-continuity fallback: merges frames where balance flow is continuous
  // (last.ba ≈ spin.bb) AND no deduction (spin.ba ≈ spin.bb). Designed for
  // cascade frames within ONE spin (same logical round, multiple visual frames).
  //
  // 2026-05-26 fix: SKIP this fallback when current spin is FREE SPIN
  // (isFreeSpin=true). FS chain frames have:
  //   - bb ≈ prev.ba (no deduction — exactly the "continuity" pattern)
  //   - Different roundIds (each FS frame is a separate logical spin)
  // Without this gate, all FS frames in a chain merge into the BUY spin (or
  // the FS trigger spin) → engine reports "1 spin captured" instead of the
  // full N-frame chain. Cascade-within-FS still merges correctly via the
  // roundId path (those frames share a roundId).
  const matchByBalance = allowContinuity
    && last
    && typeof last.balanceAfter === "number"
    && typeof spin.balanceBefore === "number"
    && typeof spin.balanceAfter === "number"
    && !spin.isFreeSpin                                            // ← gate
    && Math.abs(last.balanceAfter - spin.balanceBefore) < tol      // continuous balance
    && spin.balanceAfter >= spin.balanceBefore - tol               // no new deduction
    ? state.spins.length - 1
    : -1;

  const mergeIdx = matchByRid !== -1 ? matchByRid
    : matchByCascadeMarker !== -1 ? matchByCascadeMarker
    : matchByBalance;

  if (mergeIdx !== -1) {
    const prev = state.spins[mergeIdx]!;
    const merged: NormalizedSpinResult = {
      ...prev,
      balanceAfter: spin.balanceAfter,
      cascadeFrames: spin.cascadeFrames.length > 0 ? spin.cascadeFrames : prev.cascadeFrames,
      // Accumulate per-combo win breakdown across every tumble frame. Without
      // this the merge keeps only the FIRST frame's `raw` (and thus only its
      // wlc_v), so later tumbles' winning combos would be lost — breaking the
      // payout-integrity check (Sigma combos == total win) on multi-tumble rounds.
      winBreakdown: [...(prev.winBreakdown ?? []), ...(spin.winBreakdown ?? [])],
      // `tw` is cumulative per round, so the latest frame carries the round
      // total. Prefer the newer frame's value when present.
      serverTotalWin: spin.serverTotalWin ?? prev.serverTotalWin,
    };
    if (
      deriveWin
      && typeof merged.balanceBefore === "number"
      && typeof merged.balanceAfter === "number"
      && typeof merged.bet === "number"
    ) {
      merged.win = Math.round((merged.balanceAfter - merged.balanceBefore + merged.bet) * 100) / 100;
    } else {
      merged.win = spin.win;
    }
    state.spins[mergeIdx] = merged;
    if (rid) state.byRoundId.set(rid, mergeIdx);
    return "merged";
  }

  if (rid) state.byRoundId.set(rid, state.spins.length);
  state.spins.push(spin);
  return "appended";
}
