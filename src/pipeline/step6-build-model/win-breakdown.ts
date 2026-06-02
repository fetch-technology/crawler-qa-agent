// Pure parser for Pragmatic Play's per-combo win breakdown (`wlc_v` field).
//
// PP doSpin/cascade responses itemize every winning line/cluster in `wlc_v`,
// e.g.  wlc_v=8~0.25~2~4~11,12,15,17,18~l;3~0.75~3~3~0,11,12,17,22~l
// Each `;`-separated entry is one winning combo, `~`-delimited:
//   [0] symbol      numeric reel symbol index (e.g. "8")
//   [1] win         this combo's payout in currency (e.g. "0.25")
//   [2] ways        ways/multiplier count that produced the combo (e.g. "2")
//   [3] count       number of matching symbols, i.e. N-of-a-kind (e.g. "4")
//   [4] positions   comma-separated grid positions ("11,12,15,17,18")
//   [5] type        "l" (line/ways), "c" (cluster), etc.
//
// We deliberately DO NOT re-derive the win from a paytable here (the numeric
// symbol index -> paytable-symbol mapping isn't reliably available, and the
// coin-scaling formula can't be confirmed from a single bet level). That lives
// in the self-validated payout model (src/ai/payout-model-derive.ts). Here we
// only parse the server's own itemization so a downstream consistency check can
// verify Sigma(combo win) == total win — catching a server that reports a win
// not backed by any winning symbol pattern, with zero paytable guessing.

export type WinCombo = {
  /** Numeric reel symbol index as reported by the server (string-as-given). */
  symbol: string;
  /** This combo's payout in currency units. */
  win: number;
  /** Ways/multiplier count the server attributes to this combo (0 if absent). */
  ways: number;
  /** N-of-a-kind count (0 if absent). */
  count: number;
  /** Grid positions that formed the combo. */
  positions: number[];
  /** Combo type marker ("l", "c", ...); empty string if absent. */
  type: string;
};

/**
 * Parse a raw PP response object's `wlc_v` field into structured combos.
 * Returns [] when the field is absent, empty, or malformed (never throws).
 */
export function parseWlcV(raw: Record<string, unknown> | null | undefined): WinCombo[] {
  if (!raw) return [];
  const field = raw["wlc_v"];
  if (typeof field !== "string" || field.length === 0) return [];

  const combos: WinCombo[] = [];
  for (const entry of field.split(";")) {
    if (!entry) continue;
    const parts = entry.split("~");
    if (parts.length < 2) continue; // need at least symbol + win
    const symbol = (parts[0] ?? "").trim();
    const winStr = (parts[1] ?? "").trim();
    if (symbol === "" || winStr === "") continue; // empty/malformed entry
    const win = Number(winStr);
    if (!Number.isFinite(win)) continue;
    const positions = (parts[4] ?? "")
      .split(",")
      .map((p) => Number(p))
      .filter((n) => Number.isFinite(n));
    combos.push({
      symbol,
      win,
      ways: Number(parts[2] ?? 0) || 0,
      count: Number(parts[3] ?? 0) || 0,
      positions,
      type: (parts[5] ?? "").trim(),
    });
  }
  return combos;
}

/** Sum the payout across a list of combos. Tolerant of null/undefined. */
export function sumWinCombos(combos: ReadonlyArray<WinCombo> | null | undefined): number {
  if (!Array.isArray(combos) || combos.length === 0) return 0;
  const total = combos.reduce((acc, c) => acc + (Number.isFinite(c.win) ? c.win : 0), 0);
  // Round to 2dp to avoid float dust accumulating across many combos.
  return Math.round(total * 100) / 100;
}
