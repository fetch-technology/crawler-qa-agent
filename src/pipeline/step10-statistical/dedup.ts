// Cascade dedup: PP-style games emit MULTIPLE response frames per spin (initial
// drop + cascade tier collects). Each shares the same roundId from the original
// request. For RTP / hit-rate we want 1 row per logical spin.
//
// Win semantics:
//   - PP `tw` is CUMULATIVE total-win across cascade tiers. Last frame's `tw` =
//     final round win. (Parser picks `tw` first, so spin.win is cumulative.)
//   - Therefore dedup picks MAX(win) across frames, which equals the final
//     cumulative value. Summing would double-count.
//   - balanceAfter: take frame with largest balance OR latest in array order.
//   - cascadeFrames: union (for payline-math rule).
//   - state: prefer FREE_SPIN > BONUS > NORMAL.

import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export function dedupByRoundId(spins: NormalizedSpinResult[]): NormalizedSpinResult[] {
  const byRound = new Map<string, NormalizedSpinResult[]>();
  for (const s of spins) {
    const list = byRound.get(s.roundId) ?? [];
    list.push(s);
    byRound.set(s.roundId, list);
  }
  const out: NormalizedSpinResult[] = [];
  for (const list of byRound.values()) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    const first = list[0]!;
    // Final round win = max win across cascade frames (since PP tw is cumulative).
    const maxWin = list.reduce((m, s) => Math.max(m, s.win), 0);
    // Latest balance = balance from the frame with highest balanceAfter, OR
    // last in array order if balances tie.
    const last = list[list.length - 1]!;
    let balanceAfter = last.balanceAfter;
    for (const f of list) {
      if (typeof f.balanceAfter === "number" && f.balanceAfter > balanceAfter) {
        balanceAfter = f.balanceAfter;
      }
    }
    const cascadeAll: string[][][] = [];
    for (const f of list) cascadeAll.push(...f.cascadeFrames);
    const state =
      list.find((s) => s.state === "FREE_SPIN")?.state ??
      list.find((s) => s.state === "BONUS")?.state ??
      first.state;
    out.push({
      ...first,
      win: maxWin,
      balanceAfter,
      cascadeFrames: cascadeAll,
      state,
      isFreeSpin: list.some((s) => s.isFreeSpin),
      hasBonus: list.some((s) => s.hasBonus),
    });
  }
  // Preserve input order by roundId first appearance
  const order = new Map<string, number>();
  spins.forEach((s, i) => {
    if (!order.has(s.roundId)) order.set(s.roundId, i);
  });
  out.sort((a, b) => (order.get(a.roundId) ?? 0) - (order.get(b.roundId) ?? 0));
  return out;
}
