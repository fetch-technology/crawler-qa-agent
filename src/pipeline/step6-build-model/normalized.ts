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
};
