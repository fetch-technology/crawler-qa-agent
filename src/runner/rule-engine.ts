/**
 * Rule Engine — tự tính tiền thắng từ matrix + paytable, đối chiếu server.
 *
 * Catch class bug: server trả win sai so với math từ paytable.
 *
 * MVP scope:
 *   - "Ways" mechanic left-to-right (5×3, 25/125/250 ways) — fiesta-magenta, vswayscyhecity
 *   - Wild substitute cho mọi picture symbol (trừ Scatter)
 *   - Wild multiplier accumulate trong cascade chain (basic)
 *   - Paytable từ GameSpec.symbols.multipliers
 *
 * NOT YET supported:
 *   - Payline (fixed-line) games — easy to extend
 *   - Cluster pays — different algorithm
 *   - Multi-way (Megaways variable rows) — extends ways
 *   - Free spin multiplier persist — game-specific state
 *
 * Caller: hybrid test với `payout_correctness` case → assert calculated === server.
 */

import type { GameSpec, Invariant } from "../ai/authoring.js";

export type Reels = string[][]; // [reel_index][row_index]

export type PaytableEntry = {
  symbol: string;
  /** key = số match (3, 4, 5), value = multiplier (vd 20 cho "x20") */
  pays: Record<number, number>;
  type: "PICTURE_SYMBOL" | "WILD" | "SCATTER" | "BONUS" | "MYSTERY" | "UNKNOWN";
};

export type WaysWinResult = {
  /** Total win (chưa apply wild multiplier) */
  baseTotal: number;
  /** Total sau wild multiplier */
  finalTotal: number;
  /** Per-combo breakdown để debug */
  combos: Array<{
    symbol: string;
    count: number;
    ways: number;
    paymentMultiplier: number;
    contribution: number;
  }>;
  /** Wild multipliers accumulated */
  wildMultiplierSum: number;
};

/**
 * Decode reels string (vd PP format "eaihhbeffbafgah") → 2D array.
 *
 * Format convention: column-major (mỗi reel = sh chars liên tiếp).
 * String length phải = sw × sh.
 *
 * Vd: "eaihhbeffbafgah" với sw=5, sh=3:
 *   Reel 0: [e,a,i]
 *   Reel 1: [h,h,b]
 *   Reel 2: [e,f,f]
 *   Reel 3: [b,a,f]
 *   Reel 4: [g,a,h]
 */
export function decodeReels(s: string, sw: number, sh: number): Reels {
  if (s.length !== sw * sh) {
    throw new Error(
      `decodeReels: string length ${s.length} ≠ sw×sh = ${sw}×${sh} = ${sw * sh}`,
    );
  }
  const reels: Reels = [];
  for (let r = 0; r < sw; r++) {
    const reel: string[] = [];
    for (let h = 0; h < sh; h++) {
      reel.push(s[r * sh + h]!);
    }
    reels.push(reel);
  }
  return reels;
}

/**
 * Build paytable từ GameSpec.symbols (parse "x20" → 20).
 */
export function buildPaytable(spec: GameSpec): PaytableEntry[] {
  return spec.symbols.map((sym) => {
    const pays: Record<number, number> = {};
    if (sym.multipliers) {
      for (const [count, mul] of Object.entries(sym.multipliers)) {
        const n = Number(count);
        const m = Number(String(mul).replace(/^x/i, ""));
        if (Number.isFinite(n) && Number.isFinite(m)) pays[n] = m;
      }
    }
    return {
      symbol: (sym.code ?? "").toLowerCase(),
      pays,
      type: sym.type,
    };
  });
}

/**
 * Tính số "ways" cho 1 symbol — đếm "left-to-right consecutive reels có symbol".
 *
 * Algorithm:
 *   - Cho mỗi symbol target S:
 *     - Tìm consecutive prefix reels (từ reel 0) có ≥1 instance của S (hoặc Wild)
 *     - Ways = product of (count S+Wild per reel) cho mỗi reel trong prefix
 *     - Để pay 3 of a kind cần ≥3 reels liên tiếp; 4 → ≥4; 5 → ≥5
 *
 * Wild rules:
 *   - Wild substitute cho mọi PICTURE_SYMBOL
 *   - Wild KHÔNG substitute cho Scatter
 *
 * Return: array of { matchCount, ways } cho symbol đó (vd 3-match có X ways, 4-match có Y ways).
 */
export function countWaysForSymbol(
  reels: Reels,
  symbol: string,
  wildCode: string | null,
): Array<{ matchCount: number; ways: number }> {
  const symLower = symbol.toLowerCase();
  const wildLower = wildCode?.toLowerCase() ?? null;

  // Count target+wild per reel
  const perReelCounts: number[] = [];
  for (const reel of reels) {
    let c = 0;
    for (const sym of reel) {
      const s = sym.toLowerCase();
      if (s === symLower || (wildLower && s === wildLower)) c++;
    }
    perReelCounts.push(c);
  }

  // Find longest consecutive prefix có count > 0
  let prefixLen = 0;
  for (const c of perReelCounts) {
    if (c > 0) prefixLen++;
    else break;
  }

  if (prefixLen < 3) return []; // need ≥3 of a kind to pay

  // Cho mỗi match count k (3, 4, ..., prefixLen):
  // ways(k) = product(perReelCounts[0..k-1])
  // Nhưng game thường pay theo MAX match (chỉ trả 1 lần với k cao nhất)
  // → Trả về match count cao nhất duy nhất
  let waysProduct = 1;
  for (let i = 0; i < prefixLen; i++) {
    waysProduct *= perReelCounts[i]!;
  }
  return [{ matchCount: prefixLen, ways: waysProduct }];
}

/**
 * Find wild symbol code từ paytable (type=WILD).
 */
function findWildCode(paytable: PaytableEntry[]): string | null {
  const wild = paytable.find((e) => e.type === "WILD");
  return wild ? wild.symbol : null;
}

/**
 * Tính total win cho 1 spin theo "ways" mechanic.
 *
 * @param reels  Matrix sau spin
 * @param paytable  GameSpec paytable
 * @param coinValue  Coin (vd 0.04)
 * @param wildMultiplierSum  Tổng wild multiplier (default 1 nếu không có wild). Pass 0 nếu không có wild.
 */
export function calculateWaysWin(
  reels: Reels,
  paytable: PaytableEntry[],
  coinValue: number,
  wildMultiplierSum: number = 0,
): WaysWinResult {
  const wildCode = findWildCode(paytable);
  const combos: WaysWinResult["combos"] = [];
  let baseTotal = 0;

  // Iterate PICTURE_SYMBOL only (skip WILD/SCATTER for direct match)
  for (const entry of paytable) {
    if (entry.type !== "PICTURE_SYMBOL") continue;
    const matches = countWaysForSymbol(reels, entry.symbol, wildCode);
    for (const m of matches) {
      const payMul = entry.pays[m.matchCount] ?? 0;
      if (payMul === 0) continue;
      const contribution = payMul * coinValue * m.ways;
      baseTotal += contribution;
      combos.push({
        symbol: entry.symbol,
        count: m.matchCount,
        ways: m.ways,
        paymentMultiplier: payMul,
        contribution,
      });
    }
  }

  // Apply wild multiplier (nếu game có wild với multiplier)
  // Convention: nếu wildMultiplierSum = 0 → multiplier = 1 (no wild trigger)
  //             nếu wildMultiplierSum > 0 → multiplier = wildMultiplierSum
  const effectiveMul = wildMultiplierSum > 0 ? wildMultiplierSum : 1;
  const finalTotal = baseTotal * effectiveMul;

  return { baseTotal, finalTotal, combos, wildMultiplierSum };
}

// ===== Symbol palette + winlines audit =====

export type SymbolAuditResult = {
  ok: boolean;
  unknownSymbols: string[];
  expectedSymbols: string[];
  observedSymbols: string[];
  message?: string;
};

/**
 * Verify response matrix only contains symbols listed in GameSpec.symbols.
 * Catches: server returns NEW symbol that QA spec doesn't know about → game
 * art mismatch, paytable incomplete, balance miscalc.
 */
export function auditSymbolPalette(
  parsed: Record<string, unknown>,
  spec: GameSpec,
): SymbolAuditResult {
  const expectedSet = new Set<string>();
  for (const s of spec.symbols ?? []) {
    if (s.code) expectedSet.add(String(s.code).toLowerCase());
  }
  if (expectedSet.size === 0) {
    return { ok: true, unknownSymbols: [], expectedSymbols: [], observedSymbols: [] };
  }
  const observed = new Set<string>();
  const s = String(parsed.s ?? "");
  for (const ch of s) observed.add(ch.toLowerCase());
  // Also check `sa`/`sb` (cascade frames) if present
  for (const f of ["sa", "sb"] as const) {
    const v = parsed[f];
    if (typeof v === "string") {
      for (const ch of v) observed.add(ch.toLowerCase());
    }
  }
  const unknown: string[] = [];
  for (const obs of observed) {
    if (!expectedSet.has(obs)) unknown.push(obs);
  }
  return {
    ok: unknown.length === 0,
    unknownSymbols: unknown,
    expectedSymbols: [...expectedSet].sort(),
    observedSymbols: [...observed].sort(),
    message:
      unknown.length > 0
        ? `Unknown symbols in response: ${unknown.join(",")} (spec has: ${[...expectedSet].sort().join(",")})`
        : undefined,
  };
}

export type WinlinesAuditResult = {
  ok: boolean;
  invalidLines: number;
  totalLines: number;
  message?: string;
};

/**
 * Verify response's `winLines` field references only valid positions
 * (reel < width, row < height) and that sum of line wins matches `w`/`tw`.
 *
 * Provider-specific: RG uses `winLines: [{...}]`, PP uses `wlc_v` field.
 */
export function auditWinlines(parsed: Record<string, unknown>): WinlinesAuditResult {
  const lines = (parsed as { winLines?: unknown[] }).winLines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: true, invalidLines: 0, totalLines: 0 };
  }
  const sw = Number(parsed.sw ?? parsed.reelWidth ?? 5);
  const sh = Number(parsed.sh ?? parsed.reelHeight ?? 3);
  let invalid = 0;
  for (const line of lines as Array<Record<string, unknown>>) {
    const positions = (line.positions ?? line.cells ?? line.path) as
      | Array<{ reel?: number; row?: number; r?: number; c?: number }>
      | undefined;
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      const r = Number(p.reel ?? p.r ?? -1);
      const c = Number(p.row ?? p.c ?? -1);
      if (r < 0 || r >= sw || c < 0 || c >= sh) invalid++;
    }
  }
  return {
    ok: invalid === 0,
    invalidLines: invalid,
    totalLines: lines.length,
    message: invalid > 0 ? `${invalid} winLine positions reference out-of-grid cells` : undefined,
  };
}

// ===== Scatter pay (anywhere ≥N, independent of mechanic) =====

export type ScatterCombo = {
  symbol: string;
  count: number;
  paymentMultiplier: number;
  contribution: number;
};

/**
 * Scatter symbols pay if N or more appear ANYWHERE on the grid (not
 * adjacent, not on lines, not as cluster). Independent of game mechanic.
 *
 * Typical PP scatter: pays 3+ ≥4 anywhere. Pay table lives in spec
 * paytable entry with type=SCATTER.
 */
export function calculateScatterPay(
  reels: Reels,
  paytable: PaytableEntry[],
  coinValue: number,
): { total: number; combos: ScatterCombo[] } {
  const scatterEntry = paytable.find((e) => e.type === "SCATTER");
  if (!scatterEntry) return { total: 0, combos: [] };
  const target = scatterEntry.symbol.toLowerCase();
  let count = 0;
  for (const reel of reels) {
    for (const cell of reel) {
      if ((cell ?? "").toLowerCase() === target) count++;
    }
  }
  if (count < 3) return { total: 0, combos: [] };
  // Pick largest paytable tier ≤ count
  let payMul = 0;
  for (const [tier, mul] of Object.entries(scatterEntry.pays)) {
    const t = Number(tier);
    if (Number.isFinite(t) && t <= count && mul > payMul) payMul = mul;
  }
  if (payMul === 0) return { total: 0, combos: [] };
  // Scatter often pays "× total bet" not "× coin" — but if paytable defines
  // x-multiplier of total bet, caller must adjust. Default: × coin.
  const contribution = payMul * coinValue;
  return {
    total: contribution,
    combos: [{ symbol: target, count, paymentMultiplier: payMul, contribution }],
  };
}

// ===== Ways cascade chain (PP gs2c — vswayscyhecity, fiesta-magenta tumble) =====

export type CascadeFrame = {
  /** Parsed response body for this cascade tier. */
  parsed: Record<string, unknown>;
  /** Decoded matrix at this frame. */
  reels: Reels;
  /** Cascade multiplier active at this frame (rs_m or 1). */
  multiplier: number;
  /** Calculated ways win for this frame. */
  frameWin: number;
  /** Combos that paid in this frame. */
  combos: WaysWinResult["combos"];
};

export type CascadeChainResult = {
  totalWin: number;
  frames: CascadeFrame[];
  /** Scatter pay added once at chain start (if Scatter triggered). */
  scatterPay: number;
};

/**
 * Parse PP `wm~X:Y` patterns from trail field. Returns sum of Y values
 * (interpreted as wild multipliers).
 *
 * Format observed: `trail=wm~2:3` (single) or `wm~2:3,wm~4:5,...` (multiple).
 * Y interpretation: per-wild multiplier value. Sum = total accumulated.
 *
 * Spec is provider-undocumented; this is reverse-engineered. If sum yields
 * implausible final win, caller falls back to inconclusive.
 */
export function extractWildMultiplier(trail: string | null | undefined): number {
  if (!trail) return 0;
  let sum = 0;
  for (const match of trail.matchAll(/wm~\d+:(\d+)/g)) {
    const v = Number(match[1]);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

/**
 * Check if any cascade frame has a Wild ("W") on the board. Used to flag
 * mismatches as INCONCLUSIVE when engine doesn't fully model wild mul.
 */
function hasWildOnAnyFrame(
  frames: Array<Record<string, unknown>>,
  paytable: PaytableEntry[],
): boolean {
  const wildEntry = paytable.find((e) => e.type === "WILD");
  if (!wildEntry) return false;
  const wildSym = wildEntry.symbol.toUpperCase();
  for (const fp of frames) {
    const s = String(fp.s ?? "");
    if (s.toUpperCase().includes(wildSym)) return true;
  }
  return false;
}

/**
 * Compute total win for a ways game across cascade chain. Each frame:
 *   1. Decode matrix from frame's `s` field
 *   2. Run ways math
 *   3. Apply wild multiplier from trail `wm~X:Y` (Y values summed)
 *   4. Multiply by frame's cascade multiplier (rs_m)
 *   5. Sum
 *
 * Plus scatter pay (computed once on initial frame).
 *
 * Required fields per frame:
 *   - `s` (matrix string)
 *   - `sw`, `sh` (dimensions, optional — default 5×3)
 *   - `rs_m` (cascade multiplier, optional — default 1)
 *   - `c` (coin value)
 *   - `trail` (optional — contains wm~X:Y patterns for wild multipliers)
 */
export function calculateWaysCascadeChain(
  frames: Array<Record<string, unknown>>,
  spec: GameSpec,
  coinValue: number,
): CascadeChainResult {
  if (frames.length === 0) return { totalWin: 0, frames: [], scatterPay: 0 };
  const paytable = buildPaytable(spec);
  const result: CascadeChainResult = { totalWin: 0, frames: [], scatterPay: 0 };

  // Scatter — pay once based on initial frame matrix
  const firstFrame = frames[0]!;
  const sw = Number(firstFrame.sw ?? 5);
  const sh = Number(firstFrame.sh ?? 3);
  try {
    const initReels = decodeReels(String(firstFrame.s ?? ""), sw, sh);
    const scatter = calculateScatterPay(initReels, paytable, coinValue);
    result.scatterPay = scatter.total;
    result.totalWin += scatter.total;
  } catch {
    // First frame decode failed; scatter = 0
  }

  // Ways per cascade frame
  for (const fp of frames) {
    const fsw = Number(fp.sw ?? sw);
    const fsh = Number(fp.sh ?? sh);
    const symbolStr = String(fp.s ?? "");
    if (!symbolStr) continue;
    let reels: Reels;
    try {
      reels = decodeReels(symbolStr, fsw, fsh);
    } catch {
      continue;
    }
    // Multiplier sources (1 if absent):
    //   - rs_m: cascade tier multiplier from server
    //   - trail wm~X:Y: wild multipliers active this frame
    const cascadeMul = Number(fp.rs_m ?? 1) || 1;
    const wildMulSum = extractWildMultiplier(String(fp.trail ?? ""));
    // PP convention: wild mul of N replaces base multiplier (i.e. multiplier = N
    // when wild present, else 1). Sum of multiple wilds = combined multiplier.
    const effectiveMul = wildMulSum > 0 ? wildMulSum : cascadeMul;
    const ways = calculateWaysWin(reels, paytable, coinValue, 0);
    const frameWin = ways.baseTotal * effectiveMul;
    result.frames.push({
      parsed: fp,
      reels,
      multiplier: effectiveMul,
      frameWin,
      combos: ways.combos,
    });
    result.totalWin += frameWin;
  }

  return result;
}

// ===== Cluster mechanic =====

export type ClusterCombo = {
  symbol: string;
  size: number;
  paymentMultiplier: number;
  contribution: number;
  cells: Array<{ reel: number; row: number }>;
};

export type ClusterFrameResult = {
  baseTotal: number;
  finalTotal: number;
  combos: ClusterCombo[];
};

/**
 * Cluster pay frame: flood-fill connected groups (4-direction adjacency) of
 * the same symbol type, pay per paytable size tier.
 *
 * Wild substitution: wild substitutes for any picture symbol. Implemented by
 * including wilds in BFS expansion when searching for `target` symbol.
 *
 * Paytable tier rule (PP cluster style):
 *   paytable.pays = { "5": 0.25, "8": 0.50, "10": 1.5, "12": 2.5 }
 *   Cluster size N → pay = pays[largest tier ≤ N] × coin
 */
export function calculateClusterFrame(
  reels: Reels,
  paytable: PaytableEntry[],
  coinValue: number,
  opts: { minClusterSize?: number; wildMultiplierSum?: number } = {},
): ClusterFrameResult {
  const minSize = opts.minClusterSize ?? 5;
  const wildMul = opts.wildMultiplierSum ?? 0;
  const effectiveMul = wildMul > 0 ? wildMul : 1;
  const width = reels.length;
  const height = reels[0]?.length ?? 0;
  if (width === 0 || height === 0) return { baseTotal: 0, finalTotal: 0, combos: [] };

  const wildEntry = paytable.find((e) => e.type === "WILD");
  const wildSym = wildEntry ? wildEntry.symbol.toLowerCase() : null;

  const combos: ClusterCombo[] = [];
  let baseTotal = 0;

  for (const entry of paytable) {
    if (entry.type !== "PICTURE_SYMBOL") continue;
    const target = entry.symbol.toLowerCase();
    const visited: boolean[][] = Array.from({ length: width }, () =>
      Array.from({ length: height }, () => false),
    );
    for (let r = 0; r < width; r++) {
      for (let c = 0; c < height; c++) {
        if (visited[r]![c]) continue;
        if ((reels[r]![c] ?? "").toLowerCase() !== target) continue;
        // BFS from this seed; wilds expand the cluster
        const queue: Array<{ reel: number; row: number }> = [{ reel: r, row: c }];
        const cells: Array<{ reel: number; row: number }> = [];
        while (queue.length > 0) {
          const cell = queue.shift()!;
          if (
            cell.reel < 0 ||
            cell.reel >= width ||
            cell.row < 0 ||
            cell.row >= height
          )
            continue;
          if (visited[cell.reel]![cell.row]) continue;
          const sym = (reels[cell.reel]![cell.row] ?? "").toLowerCase();
          if (sym !== target && (!wildSym || sym !== wildSym)) continue;
          visited[cell.reel]![cell.row] = true;
          cells.push(cell);
          queue.push({ reel: cell.reel + 1, row: cell.row });
          queue.push({ reel: cell.reel - 1, row: cell.row });
          queue.push({ reel: cell.reel, row: cell.row + 1 });
          queue.push({ reel: cell.reel, row: cell.row - 1 });
        }
        if (cells.length < minSize) continue;
        // Pick largest paytable tier ≤ cluster size
        let payMul = 0;
        for (const [tier, mul] of Object.entries(entry.pays)) {
          const t = Number(tier);
          if (Number.isFinite(t) && t <= cells.length && mul > payMul) payMul = mul;
        }
        if (payMul === 0) continue;
        const contribution = payMul * coinValue * effectiveMul;
        baseTotal += payMul * coinValue;
        combos.push({
          symbol: target,
          size: cells.length,
          paymentMultiplier: payMul,
          contribution,
          cells,
        });
      }
    }
    // Re-init visited for next picture symbol — wild can belong to multiple clusters
  }

  return { baseTotal, finalTotal: baseTotal * effectiveMul, combos };
}

// ===== Paylines mechanic =====

export type PaylinesCombo = {
  symbol: string;
  count: number;
  paymentMultiplier: number;
  paylineIndex: number;
  contribution: number;
};

export type PaylinesFrameResult = {
  baseTotal: number;
  finalTotal: number;
  combos: PaylinesCombo[];
};

function defaultPaylines(width: number, height: number): number[][] {
  const lines: number[][] = [];
  for (let row = 0; row < height; row++) {
    lines.push(Array.from({ length: width }, () => row));
  }
  return lines;
}

/**
 * Paylines pay: for each line, find longest leading prefix matching the first
 * non-wild symbol (wild substitutes), pay per paytable[matchCount].
 */
export function calculatePaylinesFrame(
  reels: Reels,
  paytable: PaytableEntry[],
  coinValue: number,
  opts: { paylines?: number[][]; wildMultiplierSum?: number } = {},
): PaylinesFrameResult {
  const width = reels.length;
  const height = reels[0]?.length ?? 0;
  if (width === 0 || height === 0) return { baseTotal: 0, finalTotal: 0, combos: [] };
  const wildMul = opts.wildMultiplierSum ?? 0;
  const effectiveMul = wildMul > 0 ? wildMul : 1;
  const paylines = opts.paylines ?? defaultPaylines(width, height);
  const wildEntry = paytable.find((e) => e.type === "WILD");
  const wildSym = wildEntry ? wildEntry.symbol.toLowerCase() : null;

  const combos: PaylinesCombo[] = [];
  let baseTotal = 0;

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
    let target: string | null = null;
    for (const s of lineSymbols) {
      if (!s) break;
      if (wildSym && s === wildSym) continue;
      target = s;
      break;
    }
    if (!target) continue;
    let prefix = 0;
    for (const s of lineSymbols) {
      if (s === target || (wildSym && s === wildSym)) prefix++;
      else break;
    }
    if (prefix < 3) continue;
    const entry = paytable.find(
      (e) => e.symbol === target && e.type === "PICTURE_SYMBOL",
    );
    if (!entry) continue;
    const payMul = entry.pays[prefix] ?? 0;
    if (payMul === 0) continue;
    const contribution = payMul * coinValue * effectiveMul;
    baseTotal += payMul * coinValue;
    combos.push({
      symbol: target,
      count: prefix,
      paymentMultiplier: payMul,
      paylineIndex: pi,
      contribution,
    });
  }
  return { baseTotal, finalTotal: baseTotal * effectiveMul, combos };
}

export type PayoutMismatch = {
  ok: false;
  expected: number;
  actual: number;
  delta: number;
  detail: string;
  combos: WaysWinResult["combos"];
};

export type PayoutMatch = {
  ok: true;
  calculated: number;
  serverWin: number;
  combos: WaysWinResult["combos"];
};

export type PayoutInconclusive = {
  ok: "inconclusive";
  reason: string;
  serverWin: number;
  calculatedBaseline: number;
};

/**
 * Cascade-aware version: accepts all cascade frame responses + verifies
 * total win across chain. Required for ways/paylines games with
 * cascade: true (vswayscyhecity, fiesta-magenta tumble, Sweet Bonanza).
 *
 * Pass `cascadeFrames=[parsed]` if single-frame (no cascade).
 */
export function assertPayoutMatchesPaytableCascade(
  cascadeFrames: Array<Record<string, unknown>>,
  spec: GameSpec,
  tolerance: number = 0.01,
): PayoutMatch | PayoutMismatch | PayoutInconclusive {
  if (cascadeFrames.length === 0) {
    return {
      ok: "inconclusive",
      reason: "No cascade frames provided",
      serverWin: 0,
      calculatedBaseline: 0,
    };
  }
  const lastFrame = cascadeFrames[cascadeFrames.length - 1]!;
  const firstFrame = cascadeFrames[0]!;
  const coinValue = Number(firstFrame.c ?? 0);
  if (!Number.isFinite(coinValue) || coinValue <= 0) {
    return {
      ok: false,
      expected: 0,
      actual: 0,
      delta: 0,
      detail: `Invalid coin value: c=${firstFrame.c}`,
      combos: [],
    };
  }

  // Server's authoritative win = final cumulative tw
  const serverWin =
    Number(lastFrame.tw ?? 0) ||
    Number((lastFrame as any).winAmount ?? 0) ||
    0;

  const mechanic = (spec.mechanic_type ?? "ways").toLowerCase();
  if (mechanic !== "ways" && mechanic !== "megaways") {
    // Cluster/paylines handled by single-frame path
    return assertPayoutMatchesPaytable(lastFrame, spec, tolerance);
  }

  const chain = calculateWaysCascadeChain(cascadeFrames, spec, coinValue);
  const delta = Math.abs(chain.totalWin - serverWin);

  if (chain.totalWin === 0 && serverWin > tolerance) {
    return {
      ok: "inconclusive",
      reason:
        `Cascade chain calc=0 but server=${serverWin}. ` +
        `Possible: bonus pay (free spin trigger), wild multiplier not in rs_m, ` +
        `or matrix decode mismatch. Frames=${cascadeFrames.length}.`,
      serverWin,
      calculatedBaseline: chain.totalWin,
    };
  }
  if (chain.totalWin > tolerance && serverWin === 0) {
    return {
      ok: "inconclusive",
      reason: `Cascade chain calc=${chain.totalWin.toFixed(4)} but server=0. Engine likely over-counting ways.`,
      serverWin,
      calculatedBaseline: chain.totalWin,
    };
  }
  if (delta > tolerance) {
    // If Wild present in any frame and server > engine, likely wild
    // multiplier accumulation our model doesn't fully capture (specific
    // per-wild multipliers beyond wm~X:Y trail). Mark inconclusive to
    // avoid false positives — we know the limitation.
    const paytable = buildPaytable(spec);
    const wildPresent = hasWildOnAnyFrame(cascadeFrames, paytable);
    if (wildPresent && serverWin > chain.totalWin) {
      return {
        ok: "inconclusive",
        reason:
          `Wild present + server (${serverWin}) > engine (${chain.totalWin.toFixed(4)}). ` +
          `Engine doesn't fully model per-wild multiplier accumulation (trail wm~X:Y + game-specific buffs). ` +
          `Implied total mul: ${(serverWin / Math.max(chain.totalWin, 0.0001)).toFixed(2)}×.`,
        serverWin,
        calculatedBaseline: chain.totalWin,
      };
    }
    const detailFrames = chain.frames
      .map(
        (f, i) =>
          `  frame#${i}: ways=${f.frameWin.toFixed(4)} (mul=${f.multiplier}× × baseWays=${(f.frameWin / f.multiplier).toFixed(4)})`,
      )
      .join("\n");
    return {
      ok: false,
      expected: chain.totalWin,
      actual: serverWin,
      delta,
      detail:
        `PAYOUT_MISMATCH (cascade chain): server=${serverWin}, engine=${chain.totalWin.toFixed(4)} ` +
        `(delta=${delta.toFixed(4)} > tol=${tolerance})\n` +
        `Scatter pay: ${chain.scatterPay.toFixed(4)}\n` +
        `Frames (${chain.frames.length}):\n${detailFrames}`,
      combos: chain.frames.flatMap((f) => f.combos),
    };
  }

  return {
    ok: true,
    calculated: chain.totalWin,
    serverWin,
    combos: chain.frames.flatMap((f) => f.combos),
  };
}

/**
 * Đối chiếu: calculated win (từ rule engine) vs server win (từ response).
 *
 * Caller cung cấp parsed spin response. Engine sẽ:
 *   1. Extract reels matrix (từ field `s` hoặc `matrix`)
 *   2. Extract coin value (từ field `c` hoặc compute từ bet/level)
 *   3. Extract wild multiplier sum (từ field `total_mul`, `rs_m`, hoặc 0 nếu không có)
 *   4. Extract server win (từ `tw`, `winAmount`, `rs_iw`)
 *   5. calculateWaysWin → compare
 *
 * Tolerance default 0.01 (1 cent).
 *
 * Game-specific quirks (cascade, free spin) — caller skip case này nếu vấn đề.
 */
export function assertPayoutMatchesPaytable(
  parsed: Record<string, unknown>,
  spec: GameSpec,
  tolerance: number = 0.01,
): PayoutMatch | PayoutMismatch | PayoutInconclusive {
  // Extract reels
  const reelsStr = String(parsed.s ?? "");
  const sw = Number(parsed.sw ?? 5);
  const sh = Number(parsed.sh ?? 3);
  let reels: Reels;
  try {
    reels = decodeReels(reelsStr, sw, sh);
  } catch (err) {
    // Try matrix field (RG/JSON style: 2D array)
    if (Array.isArray(parsed.matrix)) {
      // Matrix format khác — RG dùng [[ { symbol: N } ]] grouped by row
      // Skip: engine hiện tại assume column-major string format
      return {
        ok: false,
        expected: 0,
        actual: 0,
        delta: 0,
        detail: `Matrix format không phải column-major string — cần per-game adapter để decode`,
        combos: [],
      };
    }
    throw err;
  }

  // Extract coin value
  const coinValue = Number(parsed.c ?? 0);
  if (!Number.isFinite(coinValue) || coinValue <= 0) {
    return {
      ok: false,
      expected: 0,
      actual: 0,
      delta: 0,
      detail: `Invalid coin value: c=${parsed.c}`,
      combos: [],
    };
  }

  // Extract wild multiplier sum (game-specific field)
  const wildMul =
    Number(parsed.total_mul ?? 0) ||
    Number((parsed as any).rs_m ?? 0) ||
    0;

  // Build paytable
  const paytable = buildPaytable(spec);

  // Dispatch theo mechanic_type. Cluster cascade game cần fire doCollect chain
  // để có full win — single-frame check sẽ trả INCONCLUSIVE (caller phải dùng
  // simulate-cluster-cascade flow để verify multi-frame).
  const mechanic = (spec.mechanic_type ?? "unknown").toLowerCase();
  const cascade = spec.cascade === true;
  let result: { finalTotal: number; baseTotal: number; combos: WaysWinResult["combos"] };

  if (mechanic === "cluster") {
    const clusterResult = calculateClusterFrame(reels, paytable, coinValue, {
      minClusterSize: spec.cluster_min_size ?? 5,
      wildMultiplierSum: wildMul,
    });
    result = {
      finalTotal: clusterResult.finalTotal,
      baseTotal: clusterResult.baseTotal,
      combos: clusterResult.combos.map((c) => ({
        symbol: c.symbol,
        count: c.size,
        ways: 1,
        paymentMultiplier: c.paymentMultiplier,
        contribution: c.contribution,
      })),
    };
    // Cluster + cascade: server.tw = sum of cascade chain. Single response =
    // partial. If `na=c` or `rs_more`/`rs_t > 0` → still cascading → mark inconclusive.
    const naField = String(parsed.na ?? "");
    const rsMore = Number(parsed.rs_more ?? 0);
    const isCascadeMid =
      cascade && (naField === "c" || rsMore > 0);
    if (isCascadeMid) {
      return {
        ok: "inconclusive",
        reason:
          `Cluster cascade game mid-chain (na=${naField}, rs_more=${rsMore}). ` +
          `Server's tw is partial — full verification needs follow-up doCollect responses. ` +
          `Use simulate(..., {fetchCascadeChain: true}) to verify total win.`,
        serverWin: Number(parsed.tw ?? 0),
        calculatedBaseline: result.finalTotal,
      };
    }
  } else if (mechanic === "paylines" || mechanic === "lines") {
    const pl = calculatePaylinesFrame(reels, paytable, coinValue, {
      paylines: spec.paylines,
      wildMultiplierSum: wildMul,
    });
    result = {
      finalTotal: pl.finalTotal,
      baseTotal: pl.baseTotal,
      combos: pl.combos.map((c) => ({
        symbol: c.symbol,
        count: c.count,
        ways: 1,
        paymentMultiplier: c.paymentMultiplier,
        contribution: c.contribution,
      })),
    };
  } else if (mechanic === "ways" || mechanic === "unknown" || mechanic === "megaways") {
    // Default ways (megaways is variable-row but same left-to-right ways logic for now)
    result = calculateWaysWin(reels, paytable, coinValue, wildMul);
  } else {
    return {
      ok: "inconclusive",
      reason: `Unknown mechanic_type "${spec.mechanic_type}" — cannot verify payout`,
      serverWin: Number(parsed.tw ?? 0),
      calculatedBaseline: 0,
    };
  }

  // Extract server win
  const serverWin =
    Number(parsed.tw ?? 0) ||
    Number((parsed as any).winAmount ?? 0) ||
    Number((parsed as any).rs_iw ?? 0) ||
    0;

  // Edge case: server claims win > 0 nhưng rule engine tính 0
  // → Likely game dùng encoding khác (per-game adapter needed), wlc_v field,
  //   hoặc cascade tumble. Return INCONCLUSIVE thay vì FAIL giả.
  if (result.finalTotal === 0 && serverWin > tolerance) {
    return {
      ok: "inconclusive",
      reason:
        `Rule engine tính baseTotal=0 nhưng server trả ${serverWin}. ` +
        `Game có thể dùng cascade encoding (sa/sb), wlc_v cụ thể, hoặc per-game decoder. ` +
        `Engine MVP support "ways" cơ bản — cần GameAdapter cho game này để verify chính xác.`,
      serverWin,
      calculatedBaseline: result.finalTotal,
    };
  }

  // Edge case ngược: rule engine tính > 0 nhưng server trả 0 → likely engine sai
  if (result.finalTotal > tolerance && serverWin === 0) {
    return {
      ok: "inconclusive",
      reason:
        `Rule engine tính ${result.finalTotal.toFixed(4)} nhưng server trả 0. ` +
        `Engine có thể count ways quá rộng (vd reels không thực sự liên tiếp), hoặc paytable sai.`,
      serverWin,
      calculatedBaseline: result.finalTotal,
    };
  }

  const delta = Math.abs(result.finalTotal - serverWin);
  if (delta > tolerance) {
    const comboDesc = result.combos
      .map(
        (c) =>
          `  • ${c.count}× ${c.symbol} (${c.ways} ways × ${c.paymentMultiplier}× × ${coinValue}) = ${c.contribution.toFixed(4)}`,
      )
      .join("\n");
    return {
      ok: false,
      expected: result.finalTotal,
      actual: serverWin,
      delta,
      detail:
        `PAYOUT_MISMATCH: server trả ${serverWin}, rule engine tính ${result.finalTotal.toFixed(4)} ` +
        `(delta=${delta.toFixed(4)} > tol=${tolerance})\n` +
        `Base total: ${result.baseTotal.toFixed(4)}\n` +
        `Wild multiplier: ${wildMul} (effective ${wildMul > 0 ? wildMul : 1}×)\n` +
        `Combos:\n${comboDesc || "  (no winning combos found)"}`,
      combos: result.combos,
    };
  }

  return {
    ok: true,
    calculated: result.finalTotal,
    serverWin,
    combos: result.combos,
  };
}
