// Per-mechanic crown-jewel invariants (Phase 6). Pure helpers exposed to the
// assertion sandbox so catalog/builtin assertions can verify combo-level
// fairness now that winBreakdown is populated + gate-verified (Phase 0–5).
//
// Two tiers:
//   - ROBUST (no grid geometry): comboWellFormed — safe to run always-on for
//     ANY mechanic; vacuously true when there are no combos.
//   - GEOMETRY (need grid dims): clusterConnected / distinctReels — opt-in via
//     per-category templates. PP grids are COLUMN-MAJOR: a flat position `p`
//     maps to reel = floor(p / height), row = p % height. NOTE: assumes
//     UNIFORM reel height; Megaways (variable height) needs the actual grid —
//     callers should guard accordingly.

export type WinComboLike = {
  symbol?: string;
  win?: number;
  ways?: number;
  count?: number;
  positions?: number[];
  type?: string;
};

/** ROBUST — a winning combo is structurally sound, no grid needed:
 *  finite non-negative win, ≥1 position, count ≥ 1, and count ≤ positions
 *  (a symbol spanning N reels must occupy at least N cells). Catches parser
 *  garbage (empty positions, count inflated past the cells, NaN win). */
export function comboWellFormed(c: WinComboLike | null | undefined): boolean {
  if (!c) return false;
  const win = c.win;
  const count = c.count;
  const positions = c.positions;
  return (
    typeof win === "number" && Number.isFinite(win) && win >= 0 &&
    Array.isArray(positions) && positions.length >= 1 &&
    positions.every((p) => Number.isFinite(p) && p >= 0) &&
    typeof count === "number" && count >= 1 && count <= positions.length
  );
}

/** GEOMETRY — distinct reel columns a combo's positions touch (column-major).
 *  For a ways win, this should equal the combo's `count`. */
export function distinctReels(positions: number[], height: number): number {
  if (!Array.isArray(positions) || !(height > 0)) return 0;
  const reels = new Set<number>();
  for (const p of positions) {
    if (Number.isFinite(p) && p >= 0) reels.add(Math.floor(p / height));
  }
  return reels.size;
}

/** GEOMETRY — true if all positions form ONE 4-connected region on a
 *  width×height column-major grid (the defining property of a "cluster" pay).
 *  Empty/singleton position sets are trivially connected. */
export function clusterConnected(positions: number[], width: number, height: number): boolean {
  if (!Array.isArray(positions) || positions.length <= 1) return positions?.length >= 0;
  if (!(width > 0) || !(height > 0)) return false;
  const cells = new Set<number>();
  for (const p of positions) {
    if (!Number.isFinite(p) || p < 0 || p >= width * height) return false; // off-grid
    cells.add(p);
  }
  const rc = (p: number): [number, number] => [Math.floor(p / height), p % height];
  const idx = (r: number, c: number): number => r * height + c;
  const start = positions[0]!;
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const p = stack.pop()!;
    const [r, c] = rc(p);
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]] as const) {
      if (nr < 0 || nr >= width || nc < 0 || nc >= height) continue;
      const np = idx(nr, nc);
      if (cells.has(np) && !seen.has(np)) { seen.add(np); stack.push(np); }
    }
  }
  return seen.size === cells.size;
}
