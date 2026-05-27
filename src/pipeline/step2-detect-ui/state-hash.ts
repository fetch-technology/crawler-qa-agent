// Pixel-diff based state identity. Two UI states are "same" if their screenshots
// differ by less than `STATE_SAME_THRESHOLD`. Used during graph exploration to
// detect when a click returns to an already-known state vs reveals a new one.
//
// Why not perceptual hash (pHash)? Pixel-diff with existing utils is simpler
// and good enough — slot games have stable popup layouts; background animation
// noise is < 1% per frame which we already tolerate.

import { PNG } from "pngjs";
import { pixelDiff } from "../utils/pixel-diff/index.js";

export type StateFingerprint = {
  id: string;          // human-readable state id e.g. "main", "menu", "history"
  pngBuffer: Buffer;   // canonical screenshot
};

export type StateMatch =
  | { kind: "match"; stateId: string; diffRatio: number }
  | { kind: "new"; diffRatio: number };

/** Two screenshots are considered the same state if pixel diff ratio < this. */
export const STATE_SAME_THRESHOLD = 0.04;

/**
 * Find which known state (if any) the given screenshot matches.
 * Returns "new" if no known state is close enough.
 */
export function classifyState(
  current: PNG,
  knownStates: Array<{ id: string; baseline: PNG }>,
): StateMatch {
  let bestRatio = 1;
  let bestId: string | null = null;
  for (const state of knownStates) {
    if (state.baseline.width !== current.width || state.baseline.height !== current.height) {
      continue;
    }
    const { ratio } = pixelDiff(state.baseline, current);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestId = state.id;
    }
  }
  if (bestId != null && bestRatio < STATE_SAME_THRESHOLD) {
    return { kind: "match", stateId: bestId, diffRatio: bestRatio };
  }
  return { kind: "new", diffRatio: bestRatio };
}

/** Compact identifier from arbitrary string (for new state IDs). */
export function nextStateId(existing: Set<string>, prefix = "state"): string {
  let i = existing.size;
  while (existing.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}
