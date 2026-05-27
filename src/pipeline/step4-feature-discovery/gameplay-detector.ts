import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { FeatureSignal } from "./types.js";

export function detectFromGameplay(spins: NormalizedSpinResult[]): FeatureSignal[] {
  const signals: FeatureSignal[] = [];
  let prev: NormalizedSpinResult | null = null;
  let sawFreeSpin = false;
  let sawBonus = false;
  let sawRetrigger = false;
  let sawCascade = false;

  for (const s of spins) {
    if (s.isFreeSpin && !sawFreeSpin) {
      signals.push({
        feature: "freeSpin",
        source: "gameplay",
        confidence: 0.99,
        evidence: `observed FREE_SPIN state at roundId ${s.roundId}`,
      });
      sawFreeSpin = true;
    }
    if (s.hasBonus && !sawBonus) {
      signals.push({
        feature: "buyBonus",
        source: "gameplay",
        confidence: 0.95,
        evidence: `observed BONUS state at roundId ${s.roundId}`,
      });
      sawBonus = true;
    }
    if (s.state === "RETRIGGER" && !sawRetrigger) {
      signals.push({
        feature: "respin",
        source: "gameplay",
        confidence: 0.9,
        evidence: `observed RETRIGGER at roundId ${s.roundId}`,
      });
      sawRetrigger = true;
    }
    if (s.cascadeFrames.length > 0 && !sawCascade) {
      signals.push({
        feature: "cascade",
        source: "gameplay",
        confidence: 0.95,
        evidence: `observed ${s.cascadeFrames.length} cascade frame(s) at roundId ${s.roundId}`,
      });
      sawCascade = true;
    }
    prev = s;
  }
  void prev;
  return signals;
}
