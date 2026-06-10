// Spec-learner (Phase 3) — the deterministic detector that proposes a
// per-game parser overlay from captured samples, then proves it via the
// replay-gate. "Detector tất định": pure rules over the response fields (no
// LLM) handle the ~80% common case; the result is NEVER trusted on the
// detector's say-so — `replayGate` re-parses the real samples and the gate's
// verdict sets `trusted`. When the detector is unsure OR the gate can't
// reconcile despite enough wins, `needsAi` flags the long-tail case for the
// AI fallback (Phase 5).

import type { ProviderSpec, ParserOverlay, WinItemization } from "../step6-build-model/providers/spec-types.js";
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

  const needsAi = !gate.itemization.trusted && gate.itemization.coverageMet && !gate.itemization.reconciled;
  const needMoreSamples = !gate.itemization.coverageMet;

  return { overlay, detector, gate, needsAi, needMoreSamples };
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
  const gate = replayGate(new SpecDrivenParser(candidateSpec, "PragmaticParser"), samples, { minWinningRounds });
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
