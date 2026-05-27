// Pure helpers exposed to custom_assertion check_code at runtime.
//
// Phase 11.1 — close the vocab gap between the catalog generator's EXPAND
// prompt (which promises these helpers exist) and the runtime binding
// (which previously only had spin/previousSpin/collector + an identity
// `getRoundEndSpins`). Re-implemented inline here so the case-executor
// doesn't need to import the legacy runner/test-harness.ts module
// (which pulls heavy Playwright deps).
//
// Each helper is pure (no I/O, no async, deterministic) → safe to expose
// inside `new Function(...)` sandboxes.

/** Loose spin shape — assertions are JS predicates run on adapted spins. */
type LooseSpin = Record<string, unknown>;

/**
 * Pick out the spins that represent the END of a logical round. Cascade /
 * cluster games emit MANY responses per click; only the final frame holds
 * the canonical round outcome. Strategy:
 *
 *   1. If any spin has explicit `isEndRound === true` → return those only.
 *   2. Else group by `round` / `roundId` and return the LAST entry per group.
 *   3. Else (no flags, no round key) → treat every spin as its own round.
 *
 * NOTE: For PP cascade games the cascade-dedup module already collapses
 * cascade frames into single entries before assertions run, so this helper
 * typically returns the input unchanged. Still useful for providers whose
 * dedup is partial.
 */
export function getRoundEndSpins(spins: LooseSpin[]): LooseSpin[] {
  if (!Array.isArray(spins) || spins.length === 0) return [];

  const flagged = spins.filter((s) => s?.isEndRound === true);
  if (flagged.length > 0) return flagged;

  const roundKey = (s: LooseSpin): string | null => {
    const r = s?.round ?? s?.roundId ?? s?.id;
    return typeof r === "string" || typeof r === "number" ? String(r) : null;
  };
  const haveKey = spins.some((s) => roundKey(s) != null);
  if (haveKey) {
    const out: LooseSpin[] = [];
    for (let i = 0; i < spins.length; i++) {
      const cur = roundKey(spins[i]!);
      const next = i + 1 < spins.length ? roundKey(spins[i + 1]!) : null;
      if (cur !== next) out.push(spins[i]!);
    }
    if (out.length > 0) return out;
  }

  return spins;
}

/**
 * Read the LATEST balance the collector has observed. Falls back to null
 * when no spins or balances available. Useful when an assertion needs a
 * stable balance reference but doesn't want to assume `spin.endingBalance`
 * is the most recent.
 */
export function getCurrentBalance(
  collector: { spins: LooseSpin[] } | undefined,
): number | null {
  if (!collector || !Array.isArray(collector.spins) || collector.spins.length === 0) {
    return null;
  }
  const last = collector.spins[collector.spins.length - 1] as LooseSpin;
  const ending = last?.endingBalance ?? last?.balanceAfter ?? last?.balance;
  return typeof ending === "number" ? ending : null;
}

/**
 * Detect a buy-feature deduction: returns the first round AFTER `startIndex`
 * whose effective bet (balance drop + win) is significantly larger than the
 * base spin bet. Catalog assertions check the `ratio` field to confirm a
 * buy actually happened (e.g. `ratio >= 50` for "buy 50× base bet").
 *
 * Returns null when:
 *   - no round-end spins after startIndex
 *   - balanceBefore can't be resolved (no caller hint + no prior spin)
 *   - first end-spin doesn't expose endingBalance
 */
export function detectBuyFeatureDeduction(
  spins: LooseSpin[],
  startIndex = 0,
  balanceBefore?: number | null,
): {
  deduction: number;
  baseBet: number;
  ratio: number;
  spin: LooseSpin;
} | null {
  if (!Array.isArray(spins)) return null;
  const after = spins.slice(startIndex);
  const ends = getRoundEndSpins(after);
  if (ends.length === 0) return null;
  const first = ends[0]!;
  const baseBet = typeof first.betAmount === "number"
    ? (first.betAmount as number)
    : typeof first.bet === "number" ? (first.bet as number) : 0;
  const win = typeof first.winAmount === "number"
    ? (first.winAmount as number)
    : typeof first.win === "number" ? (first.win as number) : 0;

  let before = typeof balanceBefore === "number" ? balanceBefore : null;
  if (before == null && startIndex > 0) {
    const prior = spins[startIndex - 1];
    const v = prior?.endingBalance ?? prior?.balanceAfter ?? prior?.balance;
    if (typeof v === "number") before = v;
  }
  const afterBalance = first.endingBalance ?? first.balanceAfter ?? first.balance;
  if (before == null || typeof afterBalance !== "number") return null;

  const deduction = before - afterBalance + win;
  return {
    deduction,
    baseBet,
    ratio: baseBet > 0 ? deduction / baseBet : 0,
    spin: first,
  };
}
