import type { NetworkRound } from "../step3-capture-network/types.js";
import type { CandidateScore } from "./types.js";

export function scoreCandidates(rounds: NetworkRound[]): CandidateScore[] {
  const byKey = new Map<string, CandidateScore>();
  for (const round of rounds) {
    for (const res of round.responses) {
      const body = res.body ?? "";
      const method: "GET" | "POST" = round.requests.find((r) => r.url === res.url)?.method === "POST"
        ? "POST"
        : "GET";
      const key = `${method} ${res.url}`;
      const existing = byKey.get(key) ?? { url: res.url, method, score: 0, reasons: [] };
      let score = existing.score;
      const reasons = existing.reasons;
      if (/win/i.test(body)) {
        score += 2;
        reasons.push("body has 'win'");
      }
      if (/balance|bl["\s:=]/i.test(body)) {
        score += 2;
        reasons.push("body has 'balance'");
      }
      if (/reel|rl["\s:=]/i.test(body)) {
        score += 2;
        reasons.push("body has 'reel'");
      }
      if (/round\s*id|roundId|"rid"/i.test(body)) {
        score += 2;
        reasons.push("body has roundId");
      }
      if (method === "POST") score += 1;
      // Penalize asset/bundle/image URLs — they often contain the keywords as source code.
      if (/\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|map)(\?|$)/i.test(res.url)) {
        score -= 8;
        reasons.push("asset URL — likely false positive");
      }
      byKey.set(key, { ...existing, score, reasons });
    }
  }
  return Array.from(byKey.values())
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}
