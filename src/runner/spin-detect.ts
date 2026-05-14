/**
 * Cross-provider spin response detection.
 *
 * Different providers use different response formats:
 * - Revenge Games (RG): JSON
 * - Pragmatic Play (PP): URL-encoded form data (text/plain;ISO-8859-1)
 * - PG Soft, NetEnt, Evoplay: JSON
 *
 * Đây là shared layer để: (1) runtime SpinCollector dùng, (2) post-hoc
 * gatherSpinSamples dùng, (3) Phase A authoring dùng.
 */

/**
 * Parse response body as JSON hoặc URL-encoded form. Trả về object-like
 * hoặc null nếu không nhận diện được.
 */
export function tryParseBody(body: string): Record<string, unknown> | null {
  if (!body || typeof body !== "string") return null;
  const trimmed = body.trim();

  // JSON object
  if (trimmed.startsWith("{")) {
    try {
      const p = JSON.parse(trimmed);
      if (p && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {}
  }

  // URL-encoded form (e.g. "key=val&key2=val2&...")
  // Heuristic: có dấu "=" sớm, có "&" hoặc chỉ 1 cặp, không có space
  if (/^[\w._-]+=/.test(trimmed) && !trimmed.includes("\n\n") && trimmed.length < 50_000) {
    try {
      const params = new URLSearchParams(trimmed);
      const obj: Record<string, string> = {};
      for (const [k, v] of params) obj[k] = v;
      if (Object.keys(obj).length >= 2) return obj;
    } catch {}
  }

  return null;
}

/**
 * Các field name cross-provider cho bet/win/balance/matrix. Tên có thể
 * case-sensitive khác nhau — check lowercase.
 */
const BET_KEYS = new Set([
  "betamount", "bet", "stake", "totalbet", "wager",
  "c", "coin", "bl", // PP: c=coin, bl=betlevel
]);
const WIN_KEYS = new Set([
  "winamount", "win", "totalwin", "payout", "earn",
  "tw", "rs_iw", "rs_win", // PP: tw=totalwin
]);
const BALANCE_KEYS = new Set([
  "balance", "endingbalance", "updatedbalance", "balance_cash",
]);
const MATRIX_KEYS = new Set([
  "matrix", "reels", "grid", "symbols", "result",
  "s", "sa", "sb", // PP: s=symbols, sa/sb=stops before/after
]);
const ID_KEYS = new Set([
  "id", "roundid", "spinid", "gameid", "index", "counter",
]);

export type SpinShapeScore = {
  score: number;
  reasons: string[];
  hasBet: boolean;
  hasWin: boolean;
  hasBalance: boolean;
  hasMatrix: boolean;
  hasId: boolean;
};

/**
 * Score object's shape against spin-response heuristics.
 * Score >= 5 thường là spin; >= 8 là very confident.
 */
export function scoreSpinShape(obj: Record<string, unknown>): SpinShapeScore {
  const reasons: string[] = [];
  const keys = new Set(Object.keys(obj).map((k) => k.toLowerCase()));
  let score = 0;

  const hasBet = [...keys].some((k) => BET_KEYS.has(k));
  const hasWin = [...keys].some((k) => WIN_KEYS.has(k));
  const hasBalance = [...keys].some((k) => BALANCE_KEYS.has(k));
  const hasMatrix = [...keys].some((k) => MATRIX_KEYS.has(k));
  const hasId = [...keys].some((k) => ID_KEYS.has(k));

  if (hasBet) {
    score += 2;
    reasons.push("bet");
  }
  if (hasWin) {
    score += 3;
    reasons.push("win");
  }
  if (hasBalance) {
    score += 2;
    reasons.push("balance");
  }
  if (hasMatrix) {
    score += 3;
    reasons.push("matrix");
  }
  if (hasId) {
    score += 1;
    reasons.push("id");
  }

  // PP-specific boost: tw + balance + index + sa/sb là combo đặc trưng
  if (keys.has("tw") && keys.has("balance") && (keys.has("sa") || keys.has("sb"))) {
    score += 3;
    reasons.push("pp-signature");
  }

  return { score, reasons, hasBet, hasWin, hasBalance, hasMatrix, hasId };
}

/**
 * Combined URL + body scoring. Dùng cho post-hoc detection.
 */
export function scoreSpinUrl(url: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const u = url.toLowerCase();
  if (/(?:\/|[?&=])(?:do)?spin\b/.test(u)) {
    score += 5;
    reasons.push("url:spin");
  }
  if (/\/gs2c\/.*gameservice|\/gs2c\/.*playgame|\/gs2c\/.*dospin/.test(u)) {
    score += 5;
    reasons.push("url:pp-gameservice");
  }
  if (/\/gs2c\//.test(u) && !/\/stats\.do|\/savesettings/i.test(u)) {
    score += 2;
    reasons.push("url:gs2c");
  }
  if (/\/round\b|\/play\b|\/dogame\b/.test(u)) {
    score += 2;
    reasons.push("url:round/play");
  }
  return { score, reasons };
}

/**
 * Pattern for runtime URL match (SpinCollector). Broad enough to cover
 * multiple providers. Override via env QA_SPIN_URL_PATTERN.
 */
export function getSpinUrlPattern(): RegExp {
  const override = process.env.QA_SPIN_URL_PATTERN;
  if (override) {
    try {
      return new RegExp(override, "i");
    } catch {
      console.warn(`[spin-detect] Invalid QA_SPIN_URL_PATTERN, using default`);
    }
  }
  // RG: /{game}/spin | PP: /gs2c/ge/.../gameService, /gs2c/doSpin | Generic: /spin, /doSpin, /round, /doGame
  return /(?:\/|[?&=])(?:do)?spin\b|\/gs2c\/ge\/|\/gs2c\/.*gameservice|\/gs2c\/.*playgame|\/gs2c\/.*dogame|\/round\b|\/dogame\b/i;
}

/**
 * Các endpoint trên gs2c cần EXCLUDE (không phải spin).
 */
const GS2C_NON_SPIN = /\/gs2c\/(?:stats\.do|saveSettings\.do|common\/|html5Game\.do|openGame\.do)/i;

export function shouldSkipUrl(url: string): boolean {
  return GS2C_NON_SPIN.test(url);
}
