import type { SpinState } from "./normalized.js";

const TRANSITIONS: Record<SpinState, SpinState[]> = {
  NORMAL: ["NORMAL", "BONUS", "FREE_SPIN", "GAMBLE"],
  BONUS: ["FREE_SPIN", "BONUS", "END_BONUS"],
  FREE_SPIN: ["FREE_SPIN", "RETRIGGER", "END_BONUS"],
  RETRIGGER: ["FREE_SPIN", "END_BONUS"],
  GAMBLE: ["NORMAL"],
  END_BONUS: ["NORMAL"],
};

export function isValidTransition(from: SpinState, to: SpinState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function validTransitionsFrom(from: SpinState): SpinState[] {
  return TRANSITIONS[from];
}
