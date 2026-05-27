import type { NetworkRound } from "../step3-capture-network/types.js";
import type { CandidateScore } from "./types.js";

export type ConfirmResult = {
  ok: boolean;
  expected: number;
  actual: number;
  uniqueRoundIds: number;
};

export function confirmByCount(
  candidate: CandidateScore,
  rounds: NetworkRound[],
  expectedSpins: number,
): ConfirmResult {
  let actual = 0;
  const roundIds = new Set<string>();
  for (const round of rounds) {
    for (const res of round.responses) {
      if (res.url === candidate.url) {
        actual++;
        const match = res.body?.match(/"(?:rid|roundId|round_id)"\s*[:=]\s*"?([^",&\s]+)"?/i);
        if (match && match[1]) roundIds.add(match[1]);
      }
    }
  }
  return {
    ok: actual === expectedSpins,
    expected: expectedSpins,
    actual,
    uniqueRoundIds: roundIds.size,
  };
}
