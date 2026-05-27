import { genericProvider } from "../../../adapters/providers/generic.js";
import type { SpinRequest, SpinResponse } from "../../../adapters/types.js";
import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";

function deriveState(resp: SpinResponse): SpinState {
  if (resp.isFreeSpin) return "FREE_SPIN";
  if (resp.hasBonus) return "BONUS";
  return "NORMAL";
}

function toNormalized(
  resp: SpinResponse,
  req: SpinRequest | null,
): NormalizedSpinResult {
  const bet = req?.bet || resp.bet || 0;
  return {
    roundId:
      resp.roundId ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

export class GenericParser implements BaseParser {
  readonly kind: ParserKind = "GenericParser";
  readonly providerCode = "GENERIC";

  canParseResponse(raw: string, url?: string): boolean {
    if (url && !genericProvider.urlPattern.test(url)) return false;
    if (url && genericProvider.skipUrl(url)) return false;
    const parsed = genericProvider.parseBody(raw);
    if (!parsed) return false;
    const { score } = genericProvider.scoreSpinShape(parsed);
    return score >= 4;
  }

  parseResponse(raw: string): NormalizedSpinResult {
    const parsed = genericProvider.parseBody(raw);
    if (!parsed) throw new Error("GenericParser: cannot parse response body");
    return toNormalized(genericProvider.parseResponse(parsed), null);
  }

  parseSpinPair(
    request: string | null,
    response: string,
  ): NormalizedSpinResult {
    const parsedRes = genericProvider.parseBody(response);
    if (!parsedRes) {
      throw new Error("GenericParser: cannot parse response body");
    }
    const parsedReq = request ? genericProvider.parseBody(request) : null;
    const req = parsedReq ? genericProvider.parseRequest(parsedReq) : null;
    const res = genericProvider.parseResponse(parsedRes);
    return toNormalized(res, req);
  }
}
