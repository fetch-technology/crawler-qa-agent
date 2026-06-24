// Replay-gate (Phase 2) — the trust anchor for learned/overridden parser
// specs. Re-parses ALREADY-CAPTURED sample responses through a candidate
// parser and checks financial invariants whose "answer key" lives inside the
// data itself (the server's own `tw` total + the wallet's balance movement).
// A candidate spec/overlay is only promoted to `trusted` if it RECONCILES
// here — so a wrong itemization guess (from the deterministic detector OR the
// AI tail) can never silently become "verified". Pure: no I/O, no registry.
//
// Invariants checked:
//   INV1 sumsToTotal      Σ(winBreakdown combos) == serverTotalWin, per
//                         winning round. Validates itemization against the
//                         server's own declared total. Also auto-enforces the
//                         "none" guard: mode="none" → breakdown=[] → Σ=0, so
//                         any winning round fails INV1 (can't hide real wins).
//   INV2 balanceConservation  (balanceAfter − balanceBefore) == (tw − bet).
//                         Validates the `tw`/bet extraction against the wallet.
//   INV3 roundIdUnique    round-end roundIds distinct → dedup grouped rounds
//                         correctly (a wrong grouping makes INV1 meaningless).
//
// Sample-sufficiency: itemization is certified only if the samples actually
// CONTAIN enough winning rounds (>= minWinningRounds, default 5). Reconciling
// on 0–1 wins proves nothing — coverage gates that.

import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { createDedupState, ingestFrame } from "./cascade-dedup.js";
import { sumWinBreakdown } from "./assertion-helpers.js";

export type ReplaySample = { request?: string | null; response: string; url?: string };

type InvariantStat = {
  pass: boolean;
  checked: number;
  mismatches: number;
  examples: string[];
};

export type ReplayGateResult = {
  totalSamples: number;
  parsedSpins: number;
  totalRounds: number;
  invariants: {
    sumsToTotal: InvariantStat;
    balanceConservation: InvariantStat;
    roundIdUnique: { pass: boolean; duplicates: string[] };
  };
  itemization: {
    /** Rounds with a positive server-reported win in the sample set. */
    winningRounds: number;
    /** Enough winning rounds present to certify (>= minWinningRounds). */
    coverageMet: boolean;
    /** INV1 held on every winning round. */
    reconciled: boolean;
    /** reconciled && coverageMet && roundIds grouped uniquely. */
    trusted: boolean;
    reason?: string;
  };
  /** INV4 — state-signal discrimination. Certifies that the parser's FS-vs-base
   *  classification (driven by freeSpinSignal / freeSpinsRemaining) matches what
   *  the WALLET says on real samples, with no ground-truth labels: a frame the
   *  parser calls FREE_SPIN must NOT deduct a wager, a paid base frame must, and
   *  the signal must actually DISCRIMINATE (it can't mark everything or nothing
   *  free). Only present when there is something to verify. */
  stateSignal: {
    /** Rounds the parser classified FREE_SPIN. */
    freeFrames: number;
    /** Rounds the parser classified NORMAL with a real bet deduction. */
    baseFrames: number;
    /** FS frames that WRONGLY deducted a wager (signal too greedy — e.g.
     *  marked the deducting BUY frame as free). */
    freeFramesThatDeducted: number;
    /** Enough of BOTH classes present to prove discrimination. */
    discriminationMet: boolean;
    /** No FS frame deducted AND discrimination met. */
    trusted: boolean;
    examples: string[];
    reason?: string;
  };
};

export type ReplayGateOptions = {
  /** Min winning rounds in the sample set required to certify itemization.
   *  Chosen = 5 (project decision). Fewer → coverage not met → not trusted. */
  minWinningRounds?: number;
  /** Currency tolerance for invariant comparisons. */
  tolerance?: number;
  /** INV4 — min FREE_SPIN-classified frames required to certify the state
   *  signal discriminates. Default 2. */
  minFreeFrames?: number;
  /** INV4 — min paid base frames (with a real deduction) required. Default 1. */
  minBaseFrames?: number;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Parse + dedup the samples into round-level spins, then check the financial
 *  invariants. The caller supplies a fully-built parser (provider base ⊕
 *  candidate overlay) so the gate stays decoupled from spec loading/registry. */
export function replayGate(
  parser: BaseParser,
  samples: ReplaySample[],
  opts: ReplayGateOptions = {},
): ReplayGateResult {
  const minWinningRounds = opts.minWinningRounds ?? 5;
  const tol = opts.tolerance ?? 0.01;
  const minFreeFrames = opts.minFreeFrames ?? 2;
  const minBaseFrames = opts.minBaseFrames ?? 1;

  // 1. Parse every sample → dedup into rounds (so winBreakdown accumulates
  //    across tumble frames and rounds group by the game's own markers).
  const state = createDedupState();
  let parsedSpins = 0;
  for (const s of samples) {
    let spin: NormalizedSpinResult | null = null;
    try {
      spin = parser.parseSpinPair
        ? parser.parseSpinPair(s.request ?? null, s.response, s.url)
        : parser.parseResponse(s.response);
    } catch {
      continue; // unparseable / non-spin frame — skip, not a gate failure
    }
    if (!spin) continue;
    parsedSpins++;
    // Chain balanceBefore for frames that omit it (PP spin responses have no
    // `bb`), mirroring the live capture path so conservation can be checked.
    if (spin.balanceBefore == null && state.spins.length > 0) {
      const prev = state.spins[state.spins.length - 1]!;
      if (typeof prev.balanceAfter === "number") spin.balanceBefore = prev.balanceAfter;
    }
    ingestFrame(state, spin, { allowBalanceContinuity: false });
  }

  const rounds = state.spins;

  // 2. INV1 — Σ combos == serverTotalWin, on winning rounds only.
  const sumsToTotal: InvariantStat = { pass: true, checked: 0, mismatches: 0, examples: [] };
  let winningRounds = 0;
  for (const r of rounds) {
    const tw = num(r.serverTotalWin);
    if (tw == null || tw <= tol) continue; // not a winning round → skip
    winningRounds++;
    sumsToTotal.checked++;
    const sigma = sumWinBreakdown(r as Record<string, unknown>);
    if (Math.abs(sigma - tw) > tol) {
      sumsToTotal.mismatches++;
      if (sumsToTotal.examples.length < 5) {
        sumsToTotal.examples.push(`round ${r.roundId}: Σcombos=${sigma.toFixed(2)} ≠ tw=${tw.toFixed(2)}`);
      }
    }
  }
  sumsToTotal.pass = sumsToTotal.mismatches === 0;

  // 3. INV2 — balance conservation: (ba − bb) == (tw − bet). Skips rounds with
  //    unknown balanceBefore. Informational health signal (reported; not part
  //    of the itemization gate to avoid FS/buy-cost edge-case false negatives).
  const balanceConservation: InvariantStat = { pass: true, checked: 0, mismatches: 0, examples: [] };
  for (const r of rounds) {
    const bb = num(r.balanceBefore);
    const ba = num(r.balanceAfter);
    const tw = num(r.serverTotalWin);
    const bet = num(r.bet) ?? 0;
    if (bb == null || ba == null || tw == null) continue;
    balanceConservation.checked++;
    const expectedDelta = tw - bet;
    if (Math.abs((ba - bb) - expectedDelta) > tol) {
      balanceConservation.mismatches++;
      if (balanceConservation.examples.length < 5) {
        balanceConservation.examples.push(
          `round ${r.roundId}: Δbal=${(ba - bb).toFixed(2)} ≠ tw−bet=${expectedDelta.toFixed(2)}`,
        );
      }
    }
  }
  balanceConservation.pass = balanceConservation.mismatches === 0;

  // 4. INV3 — roundId uniqueness across rounds.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const r of rounds) {
    const id = String(r.roundId ?? "");
    if (seen.has(id)) duplicates.push(id);
    else seen.add(id);
  }
  const roundIdUnique = { pass: duplicates.length === 0, duplicates };

  // 5. Itemization verdict — reconciled + coverage + sane grouping.
  const coverageMet = winningRounds >= minWinningRounds;
  const reconciled = sumsToTotal.pass;
  const trusted = reconciled && coverageMet && roundIdUnique.pass;
  let reason: string | undefined;
  if (!trusted) {
    if (!reconciled) reason = `itemization mismatch on ${sumsToTotal.mismatches}/${sumsToTotal.checked} winning round(s)`;
    else if (!coverageMet) reason = `insufficient coverage: ${winningRounds} winning round(s) < ${minWinningRounds} required`;
    else if (!roundIdUnique.pass) reason = `round grouping unstable: ${duplicates.length} duplicate roundId(s)`;
  }

  // 6. INV4 — state-signal discrimination. The wallet is the answer key: a frame
  //    the parser called FREE_SPIN must show NO wager deduction, a paid base
  //    frame must deduct, and BOTH classes must be present (else the signal is
  //    non-discriminating — matches everything or nothing). Skips frames with
  //    unknown balanceBefore.
  let freeFrames = 0;
  let baseFrames = 0;
  let freeFramesThatDeducted = 0;
  const stateExamples: string[] = [];
  for (const r of rounds) {
    const bb = num(r.balanceBefore);
    const ba = num(r.balanceAfter);
    if (bb == null || ba == null) continue;
    const drop = bb - ba;
    if (r.isFreeSpin === true || r.state === "FREE_SPIN") {
      freeFrames++;
      if (drop > tol) {
        freeFramesThatDeducted++;
        if (stateExamples.length < 5) {
          stateExamples.push(`round ${r.roundId}: FREE_SPIN but wallet dropped ${drop.toFixed(2)} (signal too greedy)`);
        }
      }
    } else if (drop > tol) {
      // a NORMAL frame that genuinely deducted a wager
      baseFrames++;
    }
  }
  const discriminationMet = freeFrames >= minFreeFrames && baseFrames >= minBaseFrames;
  const stateSignalTrusted = freeFramesThatDeducted === 0 && discriminationMet;
  let stateReason: string | undefined;
  if (!stateSignalTrusted) {
    if (freeFramesThatDeducted > 0) {
      stateReason = `${freeFramesThatDeducted} FREE_SPIN frame(s) deducted a wager — signal mislabels paid spins`;
    } else if (freeFrames < minFreeFrames) {
      stateReason = `insufficient free-spin coverage: ${freeFrames} FREE_SPIN frame(s) < ${minFreeFrames} required`;
    } else if (baseFrames < minBaseFrames) {
      stateReason = `non-discriminating: ${baseFrames} paid base frame(s) < ${minBaseFrames} required (signal may match every frame)`;
    }
  }

  return {
    totalSamples: samples.length,
    parsedSpins,
    totalRounds: rounds.length,
    invariants: { sumsToTotal, balanceConservation, roundIdUnique },
    itemization: { winningRounds, coverageMet, reconciled, trusted, reason },
    stateSignal: {
      freeFrames,
      baseFrames,
      freeFramesThatDeducted,
      discriminationMet,
      trusted: stateSignalTrusted,
      examples: stateExamples,
      reason: stateReason,
    },
  };
}
