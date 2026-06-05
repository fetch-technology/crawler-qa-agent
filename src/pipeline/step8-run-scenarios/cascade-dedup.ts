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
  // (rs_c=1, rs_p=0) followed by continuation frames (rs_p>0 / rs_c>1 / rs_more
  // set) that re-use the SAME index+counter and do NOT move balance until the
  // round's doCollect. When the request body is missing, buildRoundId falls
  // back to `index + sa` (reel-state) which DIFFERS on every tumble frame, so
  // continuation frames would otherwise leak as separate spins (autoplay 10 →
  // 12 captured). Markers stay reliable even when balance-continuity is
  // disabled (case-executor turns it off to avoid mis-merging distinct autoplay
  // rounds). Absent on classic line games → Number(undefined)=NaN → no false
  // positives. A continuation always merges into the LAST appended round (the
  // round-start frame), since tumble frames arrive contiguously before the next
  // bet's doSpin.
  const raw = spin.raw as Record<string, unknown> | undefined;
  const toNum = (v: unknown): number => (v == null ? NaN : Number(v));
  const rsPhase = toNum(raw?.["rs_p"]);
  const rsCount = toNum(raw?.["rs_c"]);
  const isCascadeContinuation =
    (Number.isFinite(rsPhase) && rsPhase > 0)
    || (Number.isFinite(rsCount) && rsCount > 1);
  const matchByCascadeMarker = isCascadeContinuation && last ? state.spins.length - 1 : -1;

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
