/**
 * Pragmatic Play provider — URL-encoded form wire format, gs2c endpoint
 * shared between init/settings/bonus/spin.
 *
 * Quirk: `gameService` endpoint serves doInit / doSettings / doBonus /
 * doSpin. Mocking blindly → game crashes at init (null paytable). We
 * expose `shouldMockRoute()` so deterministic.ts only mocks doSpin and
 * lets other actions fall through to real server.
 */

import {
  decodeColumnMajor,
  genericParseRequest,
  genericParseResponse,
} from "./generic.js";
import { scoreSpinShape, tryParseBody } from "../../runner/spin-detect.js";
import type {
  ProviderAdapter,
  RouteRequestSnapshot,
  SpinRequest,
  SpinResponse,
} from "../types.js";

const PP_URL_PATTERN =
  /\/gs2c\/ge\/|\/gs2c\/.*gameservice|\/gs2c\/.*playgame|\/gs2c\/.*dogame|\/gs2c\/.*dospin/i;

const PP_NON_SPIN_URL =
  /\/gs2c\/(?:stats\.do|saveSettings\.do|common\/|html5Game\.do|openGame\.do)/i;

const NON_SPIN_ACTION =
  /[?&]a=do(Init|Settings|Bonus|Auth|History|Logout|Heartbeat)/i;

const SPIN_PARAMS = /[?&]c=[\d.]/i;
const BET_LEVEL_PARAM = /[?&]bl=\d/i;

/**
 * True nếu Playwright route NÊN bị mock (đây là doSpin request).
 * False nếu là doInit/doSettings/... → fallback tới real server.
 * Undefined nếu URL không thuộc PP namespace → caller dùng default.
 */
function ppShouldMockRoute(req: RouteRequestSnapshot): boolean | undefined {
  if (!/\/gs2c\//i.test(req.url)) return undefined;

  const body = req.postData ?? "";
  const url = req.url;

  if (NON_SPIN_ACTION.test(body) || NON_SPIN_ACTION.test(url)) return false;

  const hasSpinParams = SPIN_PARAMS.test(body) && BET_LEVEL_PARAM.test(body);
  if (!hasSpinParams) return false;

  return true;
}

function ppParseRequest(parsed: Record<string, unknown>): SpinRequest {
  // PP: c=coin, bl=betlevel, l=lines. Bet = c × bl.
  const base = genericParseRequest(parsed);
  if (base.bet === 0 && base.coin != null && base.level != null) {
    base.bet = base.coin * base.level;
  }
  return base;
}

function ppParseResponse(parsed: Record<string, unknown>): SpinResponse {
  const base = genericParseResponse(parsed);
  // PP cascade: `sa` = stops AFTER cascade, multiple cascade frames live in
  // arrays. For now we surface the initial drop `s` as `reels` and leave
  // `cascadeFrames` empty — full cascade decoder lands in Phase 3 with cluster
  // mechanic.
  const sa = parsed.sa;
  if (typeof sa === "string" && sa.length > 0 && sa !== parsed.s) {
    try {
      const frame = decodeColumnMajor(sa, base.width, base.height);
      base.cascadeFrames = [frame];
    } catch {
      // sa not column-major same dims → skip; cluster adapter will handle.
    }
  }

  // PP-specific: `bb` field holds balanceBefore. Generic parser only reads
  // `balancebefore` (PP doesn't emit that) → base.balanceBefore stays null.
  // Adapter reads bb directly so downstream balance-decreased checks work.
  // 2026-05-26 third pass — root cause of buy-feature detection failure.
  if (base.balanceBefore == null) {
    const bbRaw = parsed["bb"];
    const bbValue = bbRaw != null ? Number(bbRaw) : NaN;
    if (Number.isFinite(bbValue)) base.balanceBefore = bbValue;
  }

  // PP: `fs` field tracks free-spin counter. Setting isFreeSpin requires
  // BOTH (fs > 0) AND (balance didn't decrease this response). Reason:
  //   - BUY transaction response also has `fs > 0` (server signals
  //     "you'll get N free spins") BUT balance DECREASES (= buy cost).
  //   - FS frames have `fs > 0` AND balance STABLE (no deduction) or
  //     INCREASE (last frame credits chain win).
  const fs = Number(parsed["fs"]);
  if (Number.isFinite(fs)) {
    base.freeSpinsRemaining = fs;
    if (fs > 0) {
      const bb = base.balanceBefore;
      const ba = base.balanceAfter;
      const balanceDecreased =
        typeof bb === "number" && Number.isFinite(ba) && bb - ba > 0.01;
      const balanceUnknown = typeof bb !== "number" || !Number.isFinite(ba);
      // Only flag FS when balance demonstrably DIDN'T decrease. When balance
      // is unknown (no `bb` field), default to NOT FS — conservative choice
      // that avoids mis-flagging BUY as FS. Real FS frames in PP always have
      // bb field anyway.
      if (!balanceDecreased && !balanceUnknown) base.isFreeSpin = true;
    }
  }
  return base;
}

export const pragmaticProvider: ProviderAdapter = {
  providerCode: "PP",
  urlPattern: PP_URL_PATTERN,
  skipUrl: (url) => PP_NON_SPIN_URL.test(url),
  parseBody: tryParseBody,
  scoreSpinShape: (parsed) => {
    const s = scoreSpinShape(parsed);
    return { score: s.score, reasons: s.reasons };
  },
  parseRequest: ppParseRequest,
  parseResponse: ppParseResponse,
  shouldMockRoute: ppShouldMockRoute,
};
