/**
 * Ways mechanic — adjacent-reels left-to-right pay (vd 25/125/243/3125 ways).
 *
 * Wrap existing `calculateWaysWin` từ `rule-engine.ts` (don't move yet — keep
 * 14 callers in tact; provide adapter facade for new code).
 */

import {
  buildPaytable,
  calculateWaysWin,
  decodeReels as decodeColumnMajorWays,
} from "../../runner/rule-engine.js";
import type { GameSpec } from "../../ai/authoring.js";
import type { MechanicAdapter } from "../types.js";

export const waysMechanic: MechanicAdapter = {
  mechanicCode: "ways",
  decodeReels: decodeColumnMajorWays,
  calculateWin: (reels, spec, ctx) => {
    const paytable = buildPaytable(spec);
    const result = calculateWaysWin(reels, paytable, ctx.coin, ctx.wildMultiplier);
    return {
      total: result.finalTotal,
      combos: result.combos.map((c) => ({
        symbol: c.symbol,
        count: c.count,
        multiplier: c.paymentMultiplier,
        ways: c.ways,
        contribution: c.contribution,
      })),
    };
  },
};

// Re-export so external callers can import GameSpec from one place
export type { GameSpec };
