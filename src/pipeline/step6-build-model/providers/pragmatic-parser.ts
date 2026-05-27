import { pragmaticProvider } from "../../../adapters/providers/pragmatic.js";
import type { SpinResponse } from "../../../adapters/types.js";
import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";

function deriveState(resp: SpinResponse): SpinState {
  if (resp.isFreeSpin) return "FREE_SPIN";
  if (resp.hasBonus) return "BONUS";
  return "NORMAL";
}

/**
 * Build a stable, unique roundId for a PP spin.
 *
 * PP response.index resets to 1 between cascade frames, so it cannot be used
 * directly. Real per-spin sequence is in REQUEST.index + REQUEST.counter.
 * mgckey + counter is unique per request within a session.
 */
function buildRoundId(
  parsedRequest: Record<string, unknown> | null,
  parsedResponse: Record<string, unknown>,
): string {
  if (parsedRequest) {
    const reqIndex = String(parsedRequest["index"] ?? "");
    const reqCounter = String(parsedRequest["counter"] ?? "");
    if (reqIndex && reqCounter) return `req-${reqIndex}-${reqCounter}`;
  }
  // Fallback when request not available: combine numeric index + reel-state hash.
  const index = String(parsedResponse["index"] ?? "");
  const sa = String(parsedResponse["sa"] ?? parsedResponse["def_s"] ?? "").slice(0, 12);
  if (sa) return `${index}-${sa}`;
  if (index) return `idx-${index}`;
  return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * PP bet computation from REQUEST fields, with optional per-game multiplier
 * override (from registry's game-mechanics.json).
 *
 * PP `c` = coin value, `l` = lines/ways, `bl` = bet level.
 *
 * Lines games (vs20rnriches): bet = c × l (or c × bl if bl > 0).
 * Ways games (vswaysmahwin2): `l` is ways count (1024, 2048, …) — actual
 *   stake uses a fixed multiplier (typically 20). Naive c × l is WRONG.
 *
 * Resolution order:
 *   1. If `betMultiplier` hint provided (from cached game-mechanics) → c × M
 *   2. Else if `bl > 0` → c × bl (bet-level mode)
 *   3. Else → c × l (lines mode; wrong for ways but safe default for first run)
 *
 * Detection of mechanic + multiplier is the job of step 6 (build-model) /
 * manualSession, which derives from observed balance change and persists to
 * registry — not the parser.
 */
function ppBetFromRequest(
  parsedRequest: Record<string, unknown> | null,
  betMultiplier?: number,
): number {
  if (!parsedRequest) return 0;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const c = num(parsedRequest["c"]);
  const bl = num(parsedRequest["bl"]);
  const l = num(parsedRequest["l"]);
  if (c > 0 && typeof betMultiplier === "number" && betMultiplier > 0) {
    return c * betMultiplier;
  }
  if (c > 0 && bl > 0) return c * bl;
  if (c > 0 && l > 0) return c * l;
  return 0;
}

function toNormalized(
  resp: SpinResponse,
  rawReq: Record<string, unknown> | null,
  rawResp: Record<string, unknown>,
  betMultiplier?: number,
): NormalizedSpinResult {
  // 2026-05-26: Free-spin frames carry the same `c` and `bl` in request as
  // normal spins (game UI fires identical doSpin requests during the
  // auto-played chain), so `ppBetFromRequest` returns the base bet. But the
  // server does NOT actually deduct from balance during FS — bet was already
  // paid up-front (via buy-feature or trigger spin). Stamping bet=0.5 on FS
  // frames breaks:
  //   - FinancialRule expected = bb + win formula (off by 0.5 each frame)
  //   - dedup deriveWin (adds phantom 0.5)
  //   - Signal Roll-up Rule check (balance arithmetic mismatch)
  // Fix: set bet=0 when isFreeSpin=true. Reflects what server actually did
  // (no deduction). NORMAL spins unchanged.
  const requestBet = ppBetFromRequest(rawReq, betMultiplier);
  const bet = resp.isFreeSpin ? 0 : requestBet;
  return {
    roundId: buildRoundId(rawReq, rawResp),
    bet,
    win: resp.win,
    balanceBefore: resp.balanceBefore,
    balanceAfter: resp.balanceAfter,
    reels: resp.reels,
    cascadeFrames: resp.cascadeFrames,
    state: deriveState(resp),
    freeSpinsRemaining: resp.freeSpinsRemaining,
    isFreeSpin: resp.isFreeSpin,
    hasBonus: resp.hasBonus,
    raw: resp.raw,
  };
}

export class PragmaticParser implements BaseParser {
  readonly kind: ParserKind = "PragmaticParser";
  readonly providerCode = "PP";
  /** Optional bet multiplier from registry's game-mechanics.json. Set via
   *  setBetMultiplier() after construction (lets the parser stay pure of
   *  registry concerns; case-executor / manualSession injects this). */
  private betMultiplier: number | undefined;

  setBetMultiplier(m: number | undefined): void {
    this.betMultiplier = m && m > 0 ? m : undefined;
  }

  canParseResponse(raw: string, url?: string): boolean {
    if (url && !pragmaticProvider.urlPattern.test(url)) return false;
    if (url && pragmaticProvider.skipUrl(url)) return false;
    const parsed = pragmaticProvider.parseBody(raw);
    if (!parsed) return false;
    const { score } = pragmaticProvider.scoreSpinShape(parsed);
    return score >= 4;
  }

  parseResponse(raw: string): NormalizedSpinResult {
    const parsed = pragmaticProvider.parseBody(raw);
    if (!parsed) throw new Error("PragmaticParser: cannot parse response body");
    return toNormalized(pragmaticProvider.parseResponse(parsed), null, parsed, this.betMultiplier);
  }

  parseSpinPair(
    request: string | null,
    response: string,
    _url?: string,
  ): NormalizedSpinResult {
    const parsedRes = pragmaticProvider.parseBody(response);
    if (!parsedRes) {
      throw new Error("PragmaticParser: cannot parse response body");
    }
    const parsedReq = request ? pragmaticProvider.parseBody(request) : null;
    const res = pragmaticProvider.parseResponse(parsedRes);
    return toNormalized(res, parsedReq, parsedRes, this.betMultiplier);
  }
}
