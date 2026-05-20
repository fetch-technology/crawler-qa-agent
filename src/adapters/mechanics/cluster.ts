/**
 * Cluster mechanic — flood-fill connected ≥N same-symbol groups
 * (vd Sweet Bonanza: ≥8 anywhere on grid).
 *
 * Algorithm:
 *   1. For each cell not yet visited:
 *      - BFS connected cells of same symbol (4-directional adjacency).
 *      - Wild substitutes for any picture symbol — include wilds into
 *        every cluster they touch (no double-pay enforced).
 *   2. If cluster size >= `ctx.minClusterSize` (default 5):
 *      - Pay = paytable[symbol][bucket(size)] × coin × wildMultiplier.
 *      - Bucket: paytable.pays maps min-size → multiplier; pick largest
 *        size ≤ cluster size.
 *
 * Note: doesn't simulate cascade tumble. Caller passes final-frame matrix.
 */

import { decodeColumnMajor } from "../providers/generic.js";
import { buildPaytable, type PaytableEntry } from "../../runner/rule-engine.js";
import type { MechanicAdapter } from "../types.js";

function findWildSymbol(paytable: PaytableEntry[]): string | null {
  const w = paytable.find((e) => e.type === "WILD");
  return w ? w.symbol.toLowerCase() : null;
}

/** Pick the largest "min size" tier in paytable.pays that ≤ clusterSize. */
function payTierFor(entry: PaytableEntry, clusterSize: number): number {
  let best = 0;
  for (const [tier, mul] of Object.entries(entry.pays)) {
    const t = Number(tier);
    if (Number.isFinite(t) && t <= clusterSize && mul > best) best = mul;
  }
  return best;
}

function bfsCluster(
  reels: string[][],
  visited: boolean[][],
  startR: number,
  startC: number,
  target: string,
  wild: string | null,
): Array<{ reel: number; row: number }> {
  const width = reels.length;
  const height = reels[0]?.length ?? 0;
  const queue: Array<{ reel: number; row: number }> = [{ reel: startR, row: startC }];
  const cells: Array<{ reel: number; row: number }> = [];
  while (queue.length > 0) {
    const { reel, row } = queue.shift()!;
    if (reel < 0 || reel >= width || row < 0 || row >= height) continue;
    if (visited[reel]![row]) continue;
    const s = (reels[reel]![row] ?? "").toLowerCase();
    if (s !== target && (!wild || s !== wild)) continue;
    visited[reel]![row] = true;
    cells.push({ reel, row });
    queue.push({ reel: reel + 1, row });
    queue.push({ reel: reel - 1, row });
    queue.push({ reel, row: row + 1 });
    queue.push({ reel, row: row - 1 });
  }
  return cells;
}

export const clusterMechanic: MechanicAdapter = {
  mechanicCode: "cluster",
  decodeReels: decodeColumnMajor,
  calculateWin: (reels, spec, ctx) => {
    const width = reels.length;
    const height = reels[0]?.length ?? 0;
    if (width === 0 || height === 0) return { total: 0, combos: [] };

    const paytable = buildPaytable(spec);
    const wild = findWildSymbol(paytable);
    const minSize = ctx.minClusterSize ?? 5;
    const wildMul = ctx.wildMultiplier > 0 ? ctx.wildMultiplier : 1;

    const combos: ReturnType<MechanicAdapter["calculateWin"]>["combos"] = [];
    let total = 0;

    // Cluster expansion is per-symbol — start BFS from each picture symbol.
    // Re-init visited grid for each target to allow wild to be claimed by
    // multiple clusters (typical cluster-pay rule).
    for (const entry of paytable) {
      if (entry.type !== "PICTURE_SYMBOL") continue;
      const target = entry.symbol.toLowerCase();
      const visited: boolean[][] = Array.from({ length: width }, () =>
        Array.from({ length: height }, () => false),
      );
      for (let r = 0; r < width; r++) {
        for (let c = 0; c < height; c++) {
          if (visited[r]![c]) continue;
          const cellSym = (reels[r]![c] ?? "").toLowerCase();
          // Only seed from the target symbol — wild alone shouldn't seed
          // (otherwise wild gets double-counted across symbols).
          if (cellSym !== target) continue;
          const cluster = bfsCluster(reels, visited, r, c, target, wild);
          if (cluster.length < minSize) continue;
          const payMul = payTierFor(entry, cluster.length);
          if (payMul === 0) continue;
          const contribution = payMul * ctx.coin * wildMul;
          total += contribution;
          combos.push({
            symbol: target,
            count: cluster.length,
            multiplier: payMul,
            cluster,
            contribution,
          });
        }
      }
    }

    return { total, combos };
  },
};
