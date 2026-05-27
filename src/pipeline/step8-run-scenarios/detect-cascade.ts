import type { NetworkRound } from "../step3-capture-network/types.js";
import { readNetworkRounds } from "../../statistical/pipeline-network-source.js";

/**
 * Detect if the game uses cascade/tumble mechanics. Pragmatic Play's tumble
 * games (vs20rnriches, vswayscyhecity, vswaysmahwin2, ...) emit `na=c` (next
 * action = cascade) on intermediate frames; final frame emits `na=s`. simulate
 * must fire doCollect tails so final balance + tw reflect the chain — without
 * this, server auto-settles on next doSpin and we see ~19% wasted doSpin
 * attempts that come back as na=c (cascade-pending) instead of new spins.
 *
 * Signals (response body, parsed as querystring):
 *   - `na=c` — explicit cascade-continue indicator
 *   - `rs_t=1` — Pragmatic running cascade tier flag
 *   - `rs_m` set with `tw` cumulative — cascade multiplier present
 *   - `tmb*` or `stf=tumbl:` — tumble trail markers
 *
 * Resolution order:
 *   1. If `rounds` provided (cold-start with fresh capture) → scan those.
 *   2. Else if `slug` provided → load pipeline-captured rounds from
 *      `fixtures/registry/<slug>/network/network.jsonl` and scan. This makes
 *      warm-start work even when provider-cache is mis-classified ("Generic"
 *      for a real PP cascade game) — the data is authoritative.
 *   3. Provider hint fallback: known cascade providers → true.
 *   4. Otherwise → false (safe; simulate's cascade loop is a no-op for
 *      non-cascade games anyway, so false negatives just waste HTTP).
 */
export function detectCascade(
  rounds: NetworkRound[] | null | undefined,
  provider?: string | null,
  opts?: { slug?: string },
): boolean {
  const effectiveRounds = rounds ?? (opts?.slug ? readNetworkRounds(opts.slug) : []);
  if (effectiveRounds.length > 0) {
    for (const round of effectiveRounds) {
      for (const res of round.responses) {
        if (!res.body) continue;
        const body = res.body;
        if (body.includes("na=c&") || body.endsWith("na=c")) return true;
        if (body.includes("rs_t=1")) return true;
        if (body.includes("stf=tumbl:")) return true;
        if (body.includes("&tmb=") || body.startsWith("tmb=")) return true;
      }
    }
    // We scanned real captures and saw NO cascade markers → trust the data
    // even when provider hint says Pragmatic. Avoids false-positive cascade
    // mode for PP non-tumble games (classic 5-reel paylines).
    return false;
  }
  if (provider && /pragmatic/i.test(provider)) return true;
  return false;
}
