/**
 * Paylines mechanic — fixed-line pay.
 *
 * Algorithm:
 *   For each payline (an array of row indices, length = reel count):
 *     1. Walk left-to-right, collect symbol at (reel_i, payline[i]).
 *     2. Find the longest leading prefix matching first-non-wild symbol
 *        (or all-wild = pays first wild-listed symbol if highest payout).
 *     3. Payout = paytable[symbol][prefixLen] × coin × wildMultiplier.
 *
 * Wild substitution: WILD counts as any PICTURE_SYMBOL.
 * Scatter: NOT counted in paylines (paid separately on count anywhere).
 *
 * If `ctx.paylines` is missing, falls back to default "all-rows" lines
 * (one payline per row index — equivalent to ways with rigid rows).
 */

import { decodeColumnMajor } from "../providers/generic.js";
import { buildPaytable, type PaytableEntry } from "../../runner/rule-engine.js";
import type { GameSpec } from "../../ai/authoring.js";
import type { MechanicAdapter } from "../types.js";

function findWildSymbol(paytable: PaytableEntry[]): string | null {
  const w = paytable.find((e) => e.type === "WILD");
  return w ? w.symbol.toLowerCase() : null;
}

function defaultPaylines(width: number, height: number): number[][] {
  const lines: number[][] = [];
  for (let row = 0; row < height; row++) {
    lines.push(Array.from({ length: width }, () => row));
  }
  return lines;
}

export const paylinesMechanic: MechanicAdapter = {
  mechanicCode: "paylines",
  decodeReels: decodeColumnMajor,
  calculateWin: (reels, spec, ctx) => {
    const width = reels.length;
    const height = reels[0]?.length ?? 0;
    if (width === 0 || height === 0) return { total: 0, combos: [] };

    const paytable = buildPaytable(spec);
    const wild = findWildSymbol(paytable);
    const paylines = ctx.paylines ?? defaultPaylines(width, height);
    const wildMul = ctx.wildMultiplier > 0 ? ctx.wildMultiplier : 1;

    const combos: ReturnType<MechanicAdapter["calculateWin"]>["combos"] = [];
    let total = 0;

    for (let pi = 0; pi < paylines.length; pi++) {
      const line = paylines[pi]!;
      if (line.length !== width) continue;

      const lineSymbols: string[] = [];
      for (let r = 0; r < width; r++) {
        const row = line[r]!;
        if (row < 0 || row >= height) {
          lineSymbols.push("");
          continue;
        }
        lineSymbols.push((reels[r]![row] ?? "").toLowerCase());
      }

      // Find target symbol: first non-wild symbol on the line
      let target: string | null = null;
      for (const s of lineSymbols) {
        if (!s) break;
        if (wild && s === wild) continue;
        target = s;
        break;
      }
      if (!target) continue;

      // Count consecutive prefix matching target (or wild)
      let prefix = 0;
      for (const s of lineSymbols) {
        if (s === target || (wild && s === wild)) prefix++;
        else break;
      }
      if (prefix < 3) continue;

      // Find paytable entry for target
      const entry = paytable.find((e) => e.symbol === target && e.type === "PICTURE_SYMBOL");
      if (!entry) continue;
      const payMul = entry.pays[prefix] ?? 0;
      if (payMul === 0) continue;

      const contribution = payMul * ctx.coin * wildMul;
      total += contribution;
      combos.push({
        symbol: target,
        count: prefix,
        multiplier: payMul,
        paylineIndex: pi,
        contribution,
      });
    }

    return { total, combos };
  },
};
