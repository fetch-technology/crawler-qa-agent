// Spec-learner (Phase 3) — the deterministic detector that proposes a
// per-game parser overlay from captured samples, then proves it via the
// replay-gate. "Detector tất định": pure rules over the response fields (no
// LLM) handle the ~80% common case; the result is NEVER trusted on the
// detector's say-so — `replayGate` re-parses the real samples and the gate's
// verdict sets `trusted`. When the detector is unsure OR the gate can't
// reconcile despite enough wins, `needsAi` flags the long-tail case for the
// AI fallback (Phase 5).

import type { ProviderSpec, ParserOverlay, WinItemization, FsCreditTiming } from "../step6-build-model/providers/spec-types.js";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { SpecDrivenParser, parseBodyBySpec } from "../step6-build-model/providers/spec-driven-parser.js";
import { replayGate, type ReplaySample, type ReplayGateResult } from "./spec-replay-gate.js";

export type ItemizationDetection = {
  value: WinItemization;
  confidence: "high" | "low";
  /** What fields the detector observed across samples (diagnostics + AI input). */
  evidence: { wlcvFrames: number; clusterFrames: number; winningFrames: number };
  reason: string;
};

/** Deterministic itemization detector — inspects which itemization fields the
 *  provider emits. High confidence when exactly one format is seen; "auto"
 *  (let parseWlcV try wlc_v then cluster) at low confidence when none or both
 *  are seen, deferring the decision to the gate (and AI tail if it fails). */
export function detectWinItemization(
  samples: ReplaySample[],
  wireFormat: ProviderSpec["wireFormat"],
): ItemizationDetection {
  let wlcvFrames = 0;
  let clusterFrames = 0;
  let winningFrames = 0;
  for (const s of samples) {
    const parsed = parseBodyBySpec(s.response, wireFormat);
    if (!parsed) continue;
    const tw = Number(parsed["tw"]);
    if (Number.isFinite(tw) && tw > 0) winningFrames++;
    const wlcv = parsed["wlc_v"];
    if (typeof wlcv === "string" && wlcv.length > 0) wlcvFrames++;
    if (Object.keys(parsed).some((k) => /^l\d+$/.test(k) && typeof parsed[k] === "string" && (parsed[k] as string).length > 0)) {
      clusterFrames++;
    }
  }
  const evidence = { wlcvFrames, clusterFrames, winningFrames };
  if (wlcvFrames > 0 && clusterFrames === 0) {
    return { value: "wlc_v", confidence: "high", evidence, reason: `wlc_v present in ${wlcvFrames} frame(s)` };
  }
  if (clusterFrames > 0 && wlcvFrames === 0) {
    return { value: "cluster", confidence: "high", evidence, reason: `cluster l0/l1 present in ${clusterFrames} frame(s)` };
  }
  if (wlcvFrames > 0 && clusterFrames > 0) {
    return { value: "auto", confidence: "low", evidence, reason: "both wlc_v and cluster fields seen — gate will decide" };
  }
  return {
    value: "auto",
    confidence: "low",
    evidence,
    reason: winningFrames > 0
      ? "winning frames but no recognized itemization field — candidate for AI tail"
      : "no winning frames in sample — cannot determine itemization",
  };
}

export type FsTimingDetection = {
  /** null = cannot determine (no FS chain with a winning mid-chain frame, or
   *  inconsistent evidence). */
  value: FsCreditTiming | null;
  trusted: boolean;
  evidence: { fsFrames: number; winningFsFrames: number; immediateHits: number; deferredHits: number };
  reason: string;
};

/** Detect WHEN this game credits free-spin wins to the wallet, from captured
 *  samples. Self-validating classification: each winning FS frame is tested
 *  against BOTH hypotheses on the server's own balance fields —
 *    immediate: balanceAfter == balanceBefore + win (credited per round)
 *    deferred:  balanceAfter == balanceBefore        (flat; credited at chain end)
 *  Trusted only when ≥1 winning FS frame exists AND every one agrees on a
 *  single hypothesis. Games differ — runtime conservation checks consult this
 *  instead of assuming one model. */
export function detectFsCreditTiming(
  parser: BaseParser,
  samples: ReplaySample[],
  tol = 0.01,
): FsTimingDetection {
  let fsFrames = 0;
  let winningFsFrames = 0;
  let immediateHits = 0;
  let deferredHits = 0;
  let prev: NormalizedSpinResult | null = null;
  for (const s of samples) {
    let spin: NormalizedSpinResult | null = null;
    try {
      spin = parser.parseSpinPair
        ? parser.parseSpinPair(s.request ?? null, s.response, s.url)
        : parser.parseResponse(s.response);
    } catch { continue; }
    if (!spin) continue;
    if (spin.balanceBefore == null && prev && typeof prev.balanceAfter === "number") {
      spin.balanceBefore = prev.balanceAfter;
    }
    if (spin.isFreeSpin === true) {
      fsFrames++;
      const bb = spin.balanceBefore;
      const ba = spin.balanceAfter;
      const win = spin.win;
      if (bb != null && Number.isFinite(ba) && typeof win === "number" && win > tol) {
        winningFsFrames++;
        if (Math.abs(ba - (bb + win)) <= tol) immediateHits++;
        else if (Math.abs(ba - bb) <= tol) deferredHits++;
      }
    }
    prev = spin;
  }
  const evidence = { fsFrames, winningFsFrames, immediateHits, deferredHits };
  if (winningFsFrames === 0) {
    return { value: null, trusted: false, evidence, reason: fsFrames > 0 ? "FS frames seen but none with a win — cannot classify credit timing" : "no FS frames in samples" };
  }
  if (immediateHits === winningFsFrames && deferredHits === 0) {
    return { value: "immediate", trusted: true, evidence, reason: `${immediateHits}/${winningFsFrames} winning FS frame(s) credited per-round` };
  }
  if (deferredHits === winningFsFrames && immediateHits === 0) {
    return { value: "deferred", trusted: true, evidence, reason: `${deferredHits}/${winningFsFrames} winning FS frame(s) flat — total credited at chain end` };
  }
  return { value: null, trusted: false, evidence, reason: `inconsistent: ${immediateHits} immediate vs ${deferredHits} deferred hit(s) across ${winningFsFrames} winning FS frame(s)` };
}

export type LearnResult = {
  overlay: ParserOverlay;
  detector: ItemizationDetection;
  gate: ReplayGateResult;
  /** Gate failed to reconcile DESPITE enough winning rounds → the format is
   *  genuinely unrecognized → escalate to the AI tail (Phase 5). Distinct from
   *  "not enough samples" (needMoreSamples). */
  needsAi: boolean;
  /** Gate couldn't certify only because too few winning rounds were captured. */
  needMoreSamples: boolean;
};

/** Learn a per-game parser overlay from captured samples. Deterministic
 *  detector proposes; replay-gate disposes. The returned overlay's
 *  `winItemization.trusted` is the GATE's verdict, never the detector's.
 *  Pure — caller stamps `validatedAt` + persists the overlay. */
export function learnParserOverlay(
  baseSpec: ProviderSpec,
  samples: ReplaySample[],
  opts: { minWinningRounds?: number } = {},
): LearnResult {
  const detector = detectWinItemization(samples, baseSpec.wireFormat);

  // Build a candidate spec with the detected itemization FORCED in (trust is
  // decided by the gate, not by inserting it), then validate by replay.
  const candidateSpec: ProviderSpec = {
    ...baseSpec,
    response: { ...baseSpec.response, winItemization: detector.value },
  };
  const parser = new SpecDrivenParser(candidateSpec, "PragmaticParser");
  const gate = replayGate(parser, samples, { minWinningRounds: opts.minWinningRounds });

  const invariantsPassed: string[] = [];
  if (gate.invariants.sumsToTotal.pass) invariantsPassed.push("sums-to-total");
  if (gate.invariants.balanceConservation.pass) invariantsPassed.push("balance-conservation");
  if (gate.invariants.roundIdUnique.pass) invariantsPassed.push("roundid-unique");

  const overlay: ParserOverlay = {
    schemaVersion: 1,
    basedOnProvider: baseSpec.name.toLowerCase(),
    winItemization: { value: detector.value, trusted: gate.itemization.trusted },
    validation: {
      samplesReplayed: gate.parsedSpins,
      reconciled: gate.itemization.winningRounds,
      invariants: invariantsPassed,
    },
  };
  attachFsCreditTiming(overlay, parser, samples);

  const needsAi = !gate.itemization.trusted && gate.itemization.coverageMet && !gate.itemization.reconciled;
  const needMoreSamples = !gate.itemization.coverageMet;

  return { overlay, detector, gate, needsAi, needMoreSamples };
}

/** Learn the FS credit-timing aspect from the same samples and attach it to
 *  the overlay (omitted when undeterminable — absent = unknown, runtime then
 *  reports INCONCLUSIVE instead of guessing a model). */
function attachFsCreditTiming(overlay: ParserOverlay, parser: BaseParser, samples: ReplaySample[]): void {
  const t = detectFsCreditTiming(parser, samples);
  if (t.value != null) {
    overlay.fsCreditTiming = { value: t.value, trusted: t.trusted };
  }
}

/** Build the overlay for a specific candidate itemization, validated by the
 *  gate. Shared by the deterministic path and the AI tail so trust is decided
 *  identically. */
function gateCandidate(
  baseSpec: ProviderSpec,
  samples: ReplaySample[],
  value: WinItemization,
  minWinningRounds: number | undefined,
): { overlay: ParserOverlay; gate: ReplayGateResult } {
  const candidateSpec: ProviderSpec = {
    ...baseSpec,
    response: { ...baseSpec.response, winItemization: value },
  };
  const parser = new SpecDrivenParser(candidateSpec, "PragmaticParser");
  const gate = replayGate(parser, samples, { minWinningRounds });
  const invariantsPassed: string[] = [];
  if (gate.invariants.sumsToTotal.pass) invariantsPassed.push("sums-to-total");
  if (gate.invariants.balanceConservation.pass) invariantsPassed.push("balance-conservation");
  if (gate.invariants.roundIdUnique.pass) invariantsPassed.push("roundid-unique");
  const overlay: ParserOverlay = {
    schemaVersion: 1,
    basedOnProvider: baseSpec.name.toLowerCase(),
    winItemization: { value, trusted: gate.itemization.trusted },
    validation: { samplesReplayed: gate.parsedSpins, reconciled: gate.itemization.winningRounds, invariants: invariantsPassed },
  };
  attachFsCreditTiming(overlay, parser, samples);
  return { overlay, gate };
}

export type LearnWithAiResult = LearnResult & {
  /** Whether the AI tail was invoked (deterministic path was insufficient). */
  aiUsed: boolean;
  /** The AI's one-line rationale, when invoked. */
  aiReasoning?: string;
};

/** Learn an overlay with the AI tail. Runs the deterministic learner first;
 *  ONLY when it flags `needsAi` (gate failed despite enough wins) and an
 *  `aiPropose` impl is supplied does it ask the model for a strategy and
 *  RE-VALIDATE it through the gate. The AI is never the source of truth — a
 *  reconciling gate is. Falls back to the deterministic (untrusted) overlay
 *  when AI is unavailable or its pick also fails the gate. */
export async function learnParserOverlayWithAi(
  baseSpec: ProviderSpec,
  samples: ReplaySample[],
  opts: {
    minWinningRounds?: number;
    aiPropose?: (sampleResponses: string[]) => Promise<{ value: WinItemization; reasoning: string } | null>;
  } = {},
): Promise<LearnWithAiResult> {
  const base = learnParserOverlay(baseSpec, samples, { minWinningRounds: opts.minWinningRounds });
  if (!base.needsAi || !opts.aiPropose) {
    return { ...base, aiUsed: false };
  }

  const proposal = await opts.aiPropose(samples.map((s) => s.response));
  if (!proposal) return { ...base, aiUsed: false };

  const { overlay, gate } = gateCandidate(baseSpec, samples, proposal.value, opts.minWinningRounds);
  return {
    overlay,
    detector: base.detector,
    gate,
    needsAi: !gate.itemization.trusted && gate.itemization.coverageMet && !gate.itemization.reconciled,
    needMoreSamples: !gate.itemization.coverageMet,
    aiUsed: true,
    aiReasoning: proposal.reasoning,
  };
}
