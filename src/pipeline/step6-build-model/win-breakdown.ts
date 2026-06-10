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
  // No `wlc_v` → this is a cluster / pays-anywhere tumble game (e.g.
  // vs20fruitsw) that itemizes wins as `l0`,`l1`,… instead. Fall back to the
  // cluster parser, which resolves the symbol from the reel grid.
  if (typeof field !== "string" || field.length === 0) return parseClusterWins(raw);

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

/**
 * Parse the cluster / pays-anywhere win format used by tumble games that emit
 * each winning cluster as `l0`, `l1`, … instead of `wlc_v`. One field per
 * cluster, `~`-delimited:
 *   <marker> ~ <win> ~ <pos> ~ <pos> ~ …
 *   [0] marker   constant per observation (0); NOT the symbol
 *   [1] win      this cluster's payout in currency
 *   [2…] positions  reel-grid indices forming the cluster
 *
 * The winning SYMBOL is not in the field — it's the value of the reel grid
 * `s` (comma-separated numeric codes) at the cluster's positions (uniform
 * within a cluster, so the first position suffices). count = cluster size,
 * ways = 1 (cluster pays have no ways multiplier). Returns [] when there is no
 * grid to resolve symbols or no `lN` fields. Never throws.
 */
export function parseClusterWins(raw: Record<string, unknown> | null | undefined): WinCombo[] {
  if (!raw) return [];
  const gridStr = raw["s"];
  if (typeof gridStr !== "string" || gridStr.length === 0) return [];
  const grid = gridStr.split(",").map((x) => x.trim());

  const lFields = Object.keys(raw)
    .map((k) => /^l(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => ({ key: m[0], n: Number(m[1]) }))
    .sort((a, b) => a.n - b.n);

  const combos: WinCombo[] = [];
  for (const { key } of lFields) {
    const field = raw[key];
    if (typeof field !== "string" || field.length === 0) continue;
    const parts = field.split("~");
    if (parts.length < 3) continue; // need marker + win + >=1 position
    const win = Number((parts[1] ?? "").trim());
    if (!Number.isFinite(win) || win <= 0) continue;
    const positions = parts
      .slice(2)
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isFinite(n));
    if (positions.length === 0) continue;
    const firstPos = positions[0]!;
    const symbol = firstPos >= 0 && firstPos < grid.length ? grid[firstPos]! : "";
    if (symbol === "") continue; // position out of grid range → can't resolve
    combos.push({ symbol, win, ways: 1, count: positions.length, positions, type: "cluster" });
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
