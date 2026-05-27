import type { NetworkRound } from "../step3-capture-network/types.js";
import type { FeatureName, FeatureSignal } from "./types.js";

const PATTERNS: Array<{ feature: FeatureName; pattern: RegExp; evidence: string }> = [
  { feature: "freeSpin", pattern: /FREE[_\s-]?SPIN|"fs"|freeSpins?/i, evidence: "response contains FREE_SPIN/fs" },
  { feature: "multiplier", pattern: /multiplier|"mp"|"mult"/i, evidence: "response contains multiplier" },
  { feature: "scatter", pattern: /scatter/i, evidence: "response contains scatter" },
  { feature: "wild", pattern: /wild/i, evidence: "response contains wild" },
  { feature: "buyBonus", pattern: /buy[_\s-]?(bonus|feature)|doBonus/i, evidence: "request/response contains buyBonus" },
  { feature: "respin", pattern: /respin|reSpin/i, evidence: "response contains respin" },
  { feature: "gamble", pattern: /gamble|double[_\s-]?up/i, evidence: "response contains gamble" },
  { feature: "jackpot", pattern: /jackpot/i, evidence: "response contains jackpot" },
  { feature: "cascade", pattern: /"sa"|cascade|tumble/i, evidence: "response contains cascade/tumble" },
];

const ASSET_URL = /\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|map|json|wasm)(\?|$)/i;

function isAsset(url: string): boolean {
  return ASSET_URL.test(url);
}

export function detectFromNetwork(rounds: NetworkRound[]): FeatureSignal[] {
  const signals: FeatureSignal[] = [];
  const seen = new Set<FeatureName>();

  for (const round of rounds) {
    for (const item of [...round.requests, ...round.responses]) {
      if (isAsset(item.url)) continue;
      const body = ("body" in item ? item.body : null) ?? "";
      const haystack = `${item.url} ${body}`;
      for (const { feature, pattern, evidence } of PATTERNS) {
        if (seen.has(feature)) continue;
        if (pattern.test(haystack)) {
          signals.push({ feature, source: "network", confidence: 0.85, evidence });
          seen.add(feature);
        }
      }
    }
  }
  return signals;
}
