import { pragmaticProvider } from "../../../adapters/providers/pragmatic.js";
import type { SpinResponse } from "../../../adapters/types.js";
import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";
import { parseWlcV } from "../win-breakdown.js";

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
 * PP request fields: `c` = coin value, `l` = lines (or ways count for
 * ways games), `bl` = bet level (PP convention: when > 0, it IS the full
 * stake multiplier; when 0, the game falls back to lines mode).
 *
 * Resolution order — mechanic-aware:
 *   1. mechanic === "lines"  → PP lines convention:
 *        bl > 0 → c × bl   (bet-level mode)
 *        else   → c × l    (lines mode)
 *      The `betMultiplier` from registry is IGNORED for lines games — it can
 *      be stale (derived at a different bet level via balance-derived method),
 *      and the request fields are always authoritative.
 *   2. betMultiplier hint present (ways/cluster/unknown) → c × M.
 *      Ways games can't use `l` directly (it's the ways count e.g. 1024,
 *      not a stake multiplier) so the registry-stored per-level multiplier
 *      is the only reliable source.
 *   3. Naive fallback (no mechanic, no M):
 *        bl > 0 → c × bl
 *        else   → c × l
 *      Same PP convention as #1.
 */
export function ppBetFromRequest(
  parsedRequest: Record<string, unknown> | null,
  opts: { mechanic?: string; betMultiplier?: number } = {},
): number {
  if (!parsedRequest) return 0;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const c = num(parsedRequest["c"]);
  if (c <= 0) return 0;
  const bl = num(parsedRequest["bl"]);
  const l = num(parsedRequest["l"]);
  const mechanic = (opts.mechanic ?? "").toLowerCase();

  if (mechanic === "lines") {
    if (bl > 0) return c * bl;
    if (l > 0) return c * l;
    return 0;
  }
  const M = opts.betMultiplier;
  if (typeof M === "number" && M > 0) {
    // ways/cluster: `l` is the ways-count (e.g. 1024), so the stored multiplier
    // is the ONLY reliable stake source — trust it. For "unknown", which is
    // where polluted calibration samples land, only trust M when it's
    // structurally plausible: a ways-style fixed mult (M <= l) or lines-equivalent
    // (M ≈ bl). A multiplier that's neither (e.g. 41 when l=20) is a poisoned
    // sample → ignore it and fall back to the request structure (c × l). This
    // SELF-HEALS an already-stored bad game-mechanics.json without re-onboarding.
    const trust =
      mechanic === "ways" || mechanic === "cluster"
        ? true
        : (l > 0 && M <= l + 1e-6) || (bl > 0 && Math.abs(M - bl) < 0.5);
    if (trust) return c * M;
  }
  if (bl > 0) return c * bl;
  if (l > 0) return c * l;
  return 0;
}

function toNormalized(
  resp: SpinResponse,
  rawReq: Record<string, unknown> | null,
  rawResp: Record<string, unknown>,
  betOpts: { mechanic?: string; betMultiplier?: number } = {},
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
  const requestBet = ppBetFromRequest(rawReq, betOpts);
  const bet = resp.isFreeSpin ? 0 : requestBet;
  const twRaw = rawResp["tw"];
  const twNum = twRaw != null ? Number(twRaw) : NaN;
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
    winBreakdown: parseWlcV(rawResp),
    serverTotalWin: Number.isFinite(twNum) ? twNum : undefined,
  };
}

export class PragmaticParser implements BaseParser {
  readonly kind: ParserKind = "PragmaticParser";
  readonly providerCode = "PP";
  /** Optional bet multiplier from registry's game-mechanics.json. Set via
   *  setBetMultiplier() after construction (lets the parser stay pure of
   *  registry concerns; case-executor / manualSession injects this). */
  private betMultiplier: number | undefined;
  /** Mechanic from registry's game-mechanics.json ("lines" / "ways" /
   *  "cluster" / "unknown"). Decides whether bet uses request `l` directly
   *  (lines) or the per-level multiplier (ways/cluster). */
  private mechanic: string | undefined;

  setBetMultiplier(m: number | undefined): void {
    this.betMultiplier = m && m > 0 ? m : undefined;
  }
  setMechanic(m: string | undefined): void {
    this.mechanic = m && m.length > 0 ? m : undefined;
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
    return toNormalized(pragmaticProvider.parseResponse(parsed), null, parsed, { mechanic: this.mechanic, betMultiplier: this.betMultiplier });
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
    return toNormalized(res, parsedReq, parsedRes, { mechanic: this.mechanic, betMultiplier: this.betMultiplier });
  }
}
