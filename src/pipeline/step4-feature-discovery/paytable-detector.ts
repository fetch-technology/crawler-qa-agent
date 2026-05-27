// AI: called only during cold-start to parse paytable popup. NEVER per-spin.

import type { Paytable } from "../registry/types.js";
import type { FeatureName, FeatureSignal } from "./types.js";

const TEXT_PATTERNS: Array<{ feature: FeatureName; pattern: RegExp; evidence: string }> = [
  { feature: "freeSpin", pattern: /free\s*spin|scatter.*trigger/i, evidence: "paytable text mentions free spin" },
  { feature: "scatter", pattern: /scatter/i, evidence: "paytable text mentions scatter" },
  { feature: "wild", pattern: /wild|substitute/i, evidence: "paytable text mentions wild" },
  { feature: "buyBonus", pattern: /buy\s*(feature|bonus)/i, evidence: "paytable mentions buy bonus" },
  { feature: "multiplier", pattern: /multiplier|x\s*[0-9]+/i, evidence: "paytable mentions multiplier" },
  { feature: "respin", pattern: /respin|re-?spin/i, evidence: "paytable mentions respin" },
  { feature: "jackpot", pattern: /jackpot/i, evidence: "paytable mentions jackpot" },
  { feature: "megaways", pattern: /megaways/i, evidence: "paytable mentions megaways" },
  { feature: "cascade", pattern: /tumble|cascade|drop/i, evidence: "paytable mentions cascade" },
];

export function detectFromPaytable(paytable: Paytable | null): FeatureSignal[] {
  if (!paytable) return [];
  const signals: FeatureSignal[] = [];
  const seen = new Set<FeatureName>();
  const corpus =
    (paytable.features?.map((f) => `${f.name} ${f.description ?? ""}`).join("\n") ?? "") +
    "\n" +
    paytable.symbols.map((s) => s.name).join(" ");
  for (const { feature, pattern, evidence } of TEXT_PATTERNS) {
    if (seen.has(feature)) continue;
    if (pattern.test(corpus)) {
      signals.push({ feature, source: "paytable", confidence: 0.9, evidence });
      seen.add(feature);
    }
  }
  return signals;
}
