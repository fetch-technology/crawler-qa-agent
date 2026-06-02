export type SpinState =
  | "NORMAL"
  | "FREE_SPIN"
  | "BONUS"
  | "GAMBLE"
  | "RETRIGGER"
  | "END_BONUS";

export type NormalizedSpinResult = {
  roundId: string;
  bet: number;
  win: number;
  balanceBefore: number | null;
  balanceAfter: number;
  reels: string[][];
  cascadeFrames: string[][][];
  state: SpinState;
  freeSpinsRemaining: number | null;
  isFreeSpin: boolean;
  hasBonus: boolean;
  raw: Record<string, unknown>;
  /** Per-combo win breakdown parsed from the response (PP `wlc_v`). For cascade
   *  rounds this is ACCUMULATED across all tumble frames by cascade-dedup, so a
   *  merged round carries every winning combo of the whole tumble chain. */
  winBreakdown?: import("./win-breakdown.js").WinCombo[];
  /** Server-reported total win for the round (PP `tw`, cumulative). On a merged
   *  cascade round this is the latest frame's `tw` (= final round total). */
  serverTotalWin?: number;
};
