/**
 * Real-network spin verification helpers.
 *
 * Khác mock-based verify: response thật từ server → check structure
 * (shape) + cross-field logic (balance conservation, win-pattern
 * consistency, bet range). Bắt được real server bugs thay vì tautology
 * "mock của tôi work".
 *
 * Coverage:
 *   - Shape: required fields present, correct types
 *   - Cross-field: bet = c×l, balance conservation, win ≤ cap
 *   - State: na/fs/bl consistent với expected game mode
 *   - Pattern: winLines/matrix consistency với win amount
 */

import type { Page, Route, Request } from "playwright";
import { scoreSpinShape, shouldSkipUrl } from "./spin-detect.js";

export type SpinResponseParsed = Record<string, unknown>;

/** Parse PP querystring OR JSON response body → flat object. */
export function parseSpinBody(body: string): SpinResponseParsed | null {
  if (!body) return null;
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === "object") return obj as SpinResponseParsed;
  } catch {}
  try {
    const params = new URLSearchParams(body);
    const out: SpinResponseParsed = {};
    for (const [k, v] of params) out[k] = v;
    return Object.keys(out).length > 0 ? out : null;
  } catch {}
  return null;
}

/**
 * Extract total bet — priority: explicit field > c×l > c alone.
 * Đồng nhất với scenario-extractor.ts, simulate.ts, deterministic-spin.ts.
 */
export function computeBet(p: SpinResponseParsed): number | null {
  const explicit = Number(p.betAmount ?? (p as any).totalBet ?? p.bet ?? (p as any).stake ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const c = Number(p.c ?? NaN);
  const l = Number(p.l ?? NaN);
  if (Number.isFinite(c) && Number.isFinite(l) && c > 0 && l > 0) return c * l;
  return Number.isFinite(c) ? c : null;
}

/**
 * Extract win amount — priority: explicit winAmount > tw (PP total win) > w (frame win).
 */
export function computeWin(p: SpinResponseParsed): number | null {
  for (const k of ["winAmount", "totalWin", "tw", "win", "w"]) {
    const v = Number(p[k] ?? NaN);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Extract ending balance từ response. */
export function computeEndingBalance(p: SpinResponseParsed): number | null {
  for (const k of ["endingBalance", "updatedBalance", "balance", "balance_cash"]) {
    const v = Number(p[k] ?? NaN);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Extract starting balance (some games include explicitly; else derive). */
export function computeStartingBalance(p: SpinResponseParsed): number | null {
  const explicit = Number(p.startingBalance ?? NaN);
  if (Number.isFinite(explicit)) return explicit;
  // Derive: ending = starting - bet + win → starting = ending + bet - win
  const end = computeEndingBalance(p);
  const bet = computeBet(p);
  const win = computeWin(p);
  if (end != null && bet != null && win != null) return end + bet - win;
  return null;
}

export type ShapeCheckResult = {
  ok: boolean;
  missing: string[];
  invalidTypes: Array<{ field: string; expected: string; got: string }>;
};

/**
 * Check response có đủ required fields + đúng type.
 * Optional fields: không fail nếu thiếu.
 */
export function verifyShape(
  p: SpinResponseParsed,
  required: Array<{ field: string; type: "number" | "string" | "array" | "nonempty" }>,
): ShapeCheckResult {
  const missing: string[] = [];
  const invalidTypes: ShapeCheckResult["invalidTypes"] = [];
  for (const r of required) {
    const v = p[r.field];
    if (v == null || v === "") {
      missing.push(r.field);
      continue;
    }
    if (r.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        invalidTypes.push({ field: r.field, expected: "number", got: typeof v });
      }
    } else if (r.type === "string") {
      if (typeof v !== "string") invalidTypes.push({ field: r.field, expected: "string", got: typeof v });
    } else if (r.type === "array") {
      if (!Array.isArray(v) && typeof v !== "string") {
        // PP queries store array as CSV string — accept both
        invalidTypes.push({ field: r.field, expected: "array_or_csv", got: typeof v });
      }
    } else if (r.type === "nonempty") {
      if (String(v).trim() === "") missing.push(`${r.field}_empty`);
    }
  }
  return { ok: missing.length === 0 && invalidTypes.length === 0, missing, invalidTypes };
}

export type BalanceConservationResult = {
  ok: boolean;
  startingBalance: number | null;
  endingBalance: number | null;
  bet: number | null;
  win: number | null;
  expected: number | null;
  delta: number | null;
};

/**
 * Verify balance arithmetic: endingBalance == startingBalance - bet + win.
 * Tolerance 0.01 (1 cent floating point).
 *
 * Nếu starting không có explicit → derive ngược → conservation trivially holds.
 * Để verify thật, cần startingBalance từ pre-spin source (vd /reloadBalance trước).
 */
export function verifyBalanceConservation(
  p: SpinResponseParsed,
  prevEndingBalance: number | null,
  tolerance = 0.01,
): BalanceConservationResult {
  const end = computeEndingBalance(p);
  const bet = computeBet(p);
  const win = computeWin(p);
  const start = prevEndingBalance ?? computeStartingBalance(p);
  if (end == null || bet == null || win == null || start == null) {
    return { ok: false, startingBalance: start, endingBalance: end, bet, win, expected: null, delta: null };
  }
  const expected = start - bet + win;
  const delta = Math.abs(end - expected);
  return { ok: delta <= tolerance, startingBalance: start, endingBalance: end, bet, win, expected, delta };
}

export type BetRangeResult = {
  ok: boolean;
  bet: number | null;
  min: number;
  max: number;
};

export function verifyBetInRange(p: SpinResponseParsed, min: number, max: number): BetRangeResult {
  const bet = computeBet(p);
  if (bet == null) return { ok: false, bet: null, min, max };
  return { ok: bet >= min - 0.001 && bet <= max + 0.001, bet, min, max };
}

export type MaxWinCapResult = {
  ok: boolean;
  win: number | null;
  bet: number | null;
  cap: number;
  ratio: number | null;
};

/** Verify win không vượt bet × cap (vd cap=5000 cho vs20olympgate). */
export function verifyMaxWinCap(p: SpinResponseParsed, capMultiplier: number): MaxWinCapResult {
  const win = computeWin(p);
  const bet = computeBet(p);
  if (win == null || bet == null || bet <= 0) return { ok: false, win, bet, cap: capMultiplier, ratio: null };
  const ratio = win / bet;
  return { ok: ratio <= capMultiplier + 0.001, win, bet, cap: capMultiplier, ratio };
}

export type WinPatternConsistencyResult = {
  ok: boolean;
  reason: string;
  win: number | null;
  hasWinLines: boolean;
};

/**
 * Cross-check: nếu response có win > 0 nhưng KHÔNG có winLines/payout array →
 * inconsistent. Hoặc ngược lại: có winLines nhưng win === 0.
 *
 * PP gs2c convention: `l0`, `l1`, ... là payout per line (l0=line0_payout).
 * Trail field `trail` chứa winning positions.
 */
export function verifyWinPatternConsistency(p: SpinResponseParsed): WinPatternConsistencyResult {
  const win = computeWin(p);
  // Detect winLines: any `l\d+` field with value > 0
  let hasWinLines = false;
  let totalLinePayout = 0;
  for (const k of Object.keys(p)) {
    if (/^l\d+$/.test(k)) {
      const lineVal = String(p[k] ?? "");
      // Format: "<lineId>~<payout>~<winning_positions>" — payout là field 2nd
      const parts = lineVal.split("~");
      if (parts.length >= 2) {
        const payout = Number(parts[1]);
        if (Number.isFinite(payout) && payout > 0) {
          hasWinLines = true;
          totalLinePayout += payout;
        }
      }
    }
  }
  if (win == null) return { ok: false, reason: "win field missing", win, hasWinLines };
  if (win > 0 && !hasWinLines) {
    // Có thể là cascade win (tmb / tumble) — check tmb_win
    const tmbWin = Number(p.tmb_win ?? p.tw ?? 0);
    if (tmbWin > 0) return { ok: true, reason: "win=tumble_win (cascade game)", win, hasWinLines: true };
    return { ok: false, reason: `win=${win} but no winLines and no tmb_win`, win, hasWinLines };
  }
  if (win === 0 && hasWinLines) {
    return { ok: false, reason: `win=0 but found winLines totaling ${totalLinePayout}`, win, hasWinLines };
  }
  return { ok: true, reason: hasWinLines ? "winLines consistent with win" : "no winLines, win=0", win, hasWinLines };
}

export type StateConsistencyResult = {
  ok: boolean;
  reason: string;
  na: string;
  fs: number;
  bl: number;
  expectedMode: "base" | "free_spin" | "bonus" | "any";
};

/**
 * Verify game state fields nhất quán:
 *   - Base mode: na='s', fs=0, bl=0
 *   - Free spin mode: fs > 0 (PP convention)
 *   - Bonus mode: bl > 0
 */
export function verifyStateConsistency(
  p: SpinResponseParsed,
  expectedMode: "base" | "free_spin" | "bonus" | "any" = "any",
): StateConsistencyResult {
  const na = String(p.na ?? "");
  const fs = Number(p.fs ?? 0);
  const bl = Number(p.bl ?? 0);
  if (expectedMode === "base") {
    const ok = fs === 0 && bl === 0 && (na === "s" || na === "");
    return { ok, reason: ok ? "base mode consistent" : `expected base but fs=${fs}, bl=${bl}, na=${na}`, na, fs, bl, expectedMode };
  }
  if (expectedMode === "free_spin") {
    const ok = fs > 0 || /^fs/i.test(na);
    return { ok, reason: ok ? "FS mode consistent" : `expected FS but fs=${fs}, na=${na}`, na, fs, bl, expectedMode };
  }
  if (expectedMode === "bonus") {
    const ok = bl > 0;
    return { ok, reason: ok ? "bonus mode consistent" : `expected bonus but bl=${bl}`, na, fs, bl, expectedMode };
  }
  return { ok: true, reason: "any mode accepted", na, fs, bl, expectedMode };
}

// ============================================================================
// Real-network spin firing (no mock — fire to real server, capture response)
// ============================================================================

export type SpinRealResult = {
  ok: boolean;
  reason: string;
  parsed: SpinResponseParsed | null;
  rawBody: string;
  status: number | null;
  /** Pre-spin balance captured từ network. Null nếu không bắt được. */
  prevEndingBalance: number | null;
  /** spin_response object (URL, body, ...) cho persistence nếu cần. */
  url: string;
  durationMs: number;
};

const PP_SPIN_URL_RE = /\/gs2c\/v3\/gameService|\/gs2c\/ge\//;
const GENERIC_SPIN_RE = /(?:\/|[?&=])(?:do)?spin\b|\/round\b|\/dogame\b/i;

/**
 * Fire 1 real spin → click spin button, capture response từ network.
 * KHÔNG mock — server response thật, có RNG variation mỗi run.
 *
 * @returns parsed response + pre-spin balance (if captured)
 */
export async function spinReal(
  page: Page,
  opts: {
    spinButton: { x: number; y: number };
    /** Total timeout ms chờ response (chia đều cho 3 attempts). Default 30000
     *  → 10s/attempt. Demo server đôi khi slow → 5s/attempt không đủ. */
    responseTimeoutMs?: number;
    /** Track multiple cascade frames (tumble game)? Default false. */
    captureFullChain?: boolean;
    /**
     * Skip 1440×900 → actual viewport scaling. Default false.
     *
     * Set true khi caller cung cấp coord **đã đúng với viewport hiện tại**
     * (vd: vision call vừa trả bbox center, cùng frame với screenshot). Không
     * skip → spinReal sẽ scale theo công thức `coord × actualViewport / 1440`
     * gây sai vị trí khi viewport khác recording.
     */
    skipScale?: boolean;
  },
): Promise<SpinRealResult> {
  const timeoutMs = opts.responseTimeoutMs ?? 15_000;
  const t0 = Date.now();
  let prevEndingBalance: number | null = null;

  // Probe: try grab balance từ recent /reloadBalance hoặc spin response trước.
  // Hook 1 lần — capture mọi response để derive prev balance.
  const balanceProbe = page.waitForResponse(
    (r) => /reloadBalance|\/balance\b/.test(r.url()),
    { timeout: 2_000 },
  ).catch(() => null);
  const probed = await balanceProbe;
  if (probed) {
    try {
      const txt = await probed.text();
      const parsed = parseSpinBody(txt);
      if (parsed) prevEndingBalance = computeEndingBalance(parsed);
    } catch {}
  }

  // Coord auto-scale: recording iterations.json captured tại viewport 1440×900.
  // Nếu test browser dùng QA_FULLSCREEN (viewport=null), `page.viewportSize()`
  // returns null → fallback đọc actual window innerWidth/innerHeight qua JS.
  let actualViewport = page.viewportSize();
  if (!actualViewport) {
    actualViewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }
  // skipScale: coord đã đúng viewport hiện tại (vision bbox center). Else
  // assume coord ở recording space (1440×900) và scale lên.
  const scaleX = opts.skipScale ? 1 : actualViewport.width / 1440;
  const scaleY = opts.skipScale ? 1 : actualViewport.height / 900;
  const scaledX = Math.round(opts.spinButton.x * scaleX);
  const scaledY = Math.round(opts.spinButton.y * scaleY);
  if (opts.skipScale) {
    console.log(
      `[spinReal] using live coord (${scaledX},${scaledY}) — no scaling (viewport ${actualViewport.width}×${actualViewport.height})`,
    );
  } else if (scaleX !== 1 || scaleY !== 1) {
    console.log(
      `[spinReal] viewport ${actualViewport.width}×${actualViewport.height} ≠ recording 1440×900 — scale coord (${opts.spinButton.x},${opts.spinButton.y}) → (${scaledX},${scaledY})`,
    );
  }

  // Fire click + wait response. Retry up to 3 attempts (tolerate transient
  // animation state, double-buffered render, dismissModal aftermath).
  const maxAttempts = 3;
  const perAttemptTimeout = Math.floor(timeoutMs / maxAttempts);
  let response;
  let acceptedParsed: SpinResponseParsed | null = null;
  let acceptedRawBody = "";
  let lastError: string = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.mouse.move(scaledX, scaledY);
    await page.waitForTimeout(80);
    await page.mouse.click(scaledX, scaledY);

    const deadline = Date.now() + perAttemptTimeout;
    try {
      while (Date.now() < deadline) {
        const remaining = Math.max(200, deadline - Date.now());
        const candidate = await page.waitForResponse(
          (r) => {
            const url = r.url();
            if (shouldSkipUrl(url)) return false;
            const req = r.request();
            return req.method() === "POST" && (PP_SPIN_URL_RE.test(url) || GENERIC_SPIN_RE.test(url));
          },
          { timeout: Math.min(1_500, remaining) },
        );

        const text = await candidate.text().catch(() => "");
        const parsed = parseSpinBody(text);
        const score = parsed ? scoreSpinShape(parsed).score : 0;

        // Ignore intermediate/non-spin payloads and keep listening.
        if (parsed && score >= 5) {
          response = candidate;
          acceptedParsed = parsed;
          acceptedRawBody = text;
          break;
        }
      }

      if (response) break;
      lastError = `no valid spin payload (shape-score>=5) within ${perAttemptTimeout}ms`;
    } catch (err) {
      lastError = (err as Error).message;
    }

    if (attempt < maxAttempts) {
      console.log(`[spinReal] attempt ${attempt}/${maxAttempts} no valid spin payload — retry`);
      await page.waitForTimeout(500); // brief settle before retry
    }
  }
  if (!response) {
    return {
      ok: false,
      reason: `no spin response sau ${maxAttempts} attempts × ${perAttemptTimeout / 1000}s — coord ${scaleX !== 1 || scaleY !== 1 ? `scaled (${scaledX},${scaledY}) từ (${opts.spinButton.x},${opts.spinButton.y})` : `(${scaledX},${scaledY})`} viewport ${actualViewport.width}×${actualViewport.height} (lastError: ${lastError})`,
      parsed: null,
      rawBody: "",
      status: null,
      prevEndingBalance,
      url: "",
      durationMs: Date.now() - t0,
    };
  }
  const text = acceptedRawBody || (await response.text().catch(() => ""));
  const parsed = acceptedParsed ?? parseSpinBody(text);
  return {
    ok: parsed !== null,
    reason: parsed ? "ok" : "unparseable_body",
    parsed,
    rawBody: text,
    status: response.status(),
    prevEndingBalance,
    url: response.url(),
    durationMs: Date.now() - t0,
  };
}

// ============================================================================
// Modal dismiss helper — clean state giữa các test trong shared session
// ============================================================================

/**
 * Dismiss modal nhẹ — CHỈ dùng Escape key. KHÔNG dùng Space vì PP canvas
 * games có "Space = Spin" hotkey → press Space sẽ trigger spin (nếu play
 * screen ready) thay vì dismiss → disturb subsequent spin click.
 *
 * KHÔNG click màn hình vì PP "tap-to-spin" trigger spin khi click reels area.
 *
 * Strategy:
 *   1. Escape — dismiss dialog popups (config, info panel). Modal "PRESS ANYWHERE"
 *      cũng accept Escape trong nhiều PP games.
 *
 * Nếu modal không dismiss được bằng Escape (vd FS-award splash chỉ accept
 * click/Space), caller cần dùng explicit click-on-modal hoặc page.reload().
 */
export async function dismissAnyModal(
  page: Page,
  _opts: { viewport?: { width: number; height: number } } = {},
): Promise<void> {
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    // Add small settle để game UI back to idle (clear animation/transition)
    await page.waitForTimeout(500);
  } catch {}
}

