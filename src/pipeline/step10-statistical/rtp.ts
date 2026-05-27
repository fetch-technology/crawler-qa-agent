import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export function computeRtp(spins: NormalizedSpinResult[]): {
  totalBet: number;
  totalWin: number;
  rtp: number;
} {
  let totalBet = 0;
  let totalWin = 0;
  for (const s of spins) {
    if (!s.isFreeSpin) totalBet += s.bet;
    totalWin += s.win;
  }
  return {
    totalBet,
    totalWin,
    rtp: totalBet === 0 ? 0 : totalWin / totalBet,
  };
}
