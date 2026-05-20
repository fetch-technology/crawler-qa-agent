/**
 * Generic provider — fallback adapter wrapping existing `spin-detect.ts`
 * heuristics. Used when no specific provider matches.
 *
 * Strategy: import & delegate to `spin-detect.ts` rather than moving code,
 * so existing 14 call sites remain untouched (zero-risk migration).
 */

import {
  getSpinUrlPattern,
  scoreSpinShape,
  shouldSkipUrl,
  tryParseBody,
} from "../../runner/spin-detect.js";
import type {
  ProviderAdapter,
  SpinRequest,
  SpinResponse,
} from "../types.js";

/** Numeric extraction with safe fallback. */
function num(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return false;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function lowerKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Generic spin-request parser. Reads cross-provider field names.
 * Provider-specific subclasses override for accuracy.
 */
export function genericParseRequest(parsed: Record<string, unknown>): SpinRequest {
  const lc = lowerKeys(parsed);
  const coin = num(lc["c"] ?? lc["coin"] ?? lc["coinvalue"], null);
  const level = num(lc["bl"] ?? lc["level"] ?? lc["betlevel"], null);
  const lines = num(lc["l"] ?? lc["lines"] ?? lc["linecount"], null);
  const explicitBet = num(
    lc["betamount"] ?? lc["bet"] ?? lc["stake"] ?? lc["totalbet"] ?? lc["wager"],
    null,
  );
  let bet = explicitBet ?? 0;
  if (!bet && coin != null && level != null) bet = coin * level;
  else if (!bet && coin != null && lines != null) bet = coin * lines;
  return {
    bet,
    coin,
    level,
    lines,
    raw: parsed,
  };
}

/**
 * Generic spin-response parser. Reads cross-provider field names.
 */
export function genericParseResponse(parsed: Record<string, unknown>): SpinResponse {
  const lc = lowerKeys(parsed);
  const bet = num(
    lc["betamount"] ?? lc["bet"] ?? lc["totalbet"] ?? lc["wager"],
    null,
  );
  const coin = num(lc["c"] ?? lc["coin"], null);
  const level = num(lc["bl"] ?? lc["level"], null);
  const inferredBet = bet ?? (coin != null && level != null ? coin * level : 0);

  const win = num(
    lc["winamount"] ?? lc["win"] ?? lc["totalwin"] ?? lc["tw"] ?? lc["payout"],
    0,
  ) ?? 0;
  const balanceAfter = num(
    lc["endingbalance"] ?? lc["balance"] ?? lc["updatedbalance"],
    0,
  ) ?? 0;
  const balanceBefore = num(lc["startingbalance"] ?? lc["balancebefore"], null);

  const width = num(lc["sw"] ?? lc["width"] ?? lc["reelwidth"], 5) ?? 5;
  const height = num(lc["sh"] ?? lc["height"] ?? lc["reelheight"], 3) ?? 3;
  const symbols = str(lc["s"] ?? lc["symbols"]) ?? "";

  let reels: string[][] = [];
  if (symbols && symbols.length === width * height) {
    reels = decodeColumnMajor(symbols, width, height);
  } else if (Array.isArray(lc["reels"])) {
    reels = lc["reels"] as string[][];
  } else if (Array.isArray(lc["matrix"])) {
    reels = lc["matrix"] as string[][];
  }

  const roundId = str(lc["roundid"] ?? lc["spinid"] ?? lc["id"] ?? lc["index"]);
  const isFreeSpin = bool(lc["isfreespin"]);
  const winFreeSpins = num(lc["winfreespins"], 0) ?? 0;
  const hasBonus = winFreeSpins > 0 || bool(lc["hasbonus"]);
  const freeSpinsRemaining = num(lc["freespinsremaining"] ?? lc["fsremaining"], null);

  return {
    bet: inferredBet,
    win,
    balanceBefore,
    balanceAfter,
    reels,
    width,
    height,
    roundId,
    isFreeSpin,
    hasBonus,
    freeSpinsRemaining,
    cascadeFrames: [],
    raw: parsed,
  };
}

/** Generic column-major decoder — same convention as `rule-engine.decodeReels`. */
export function decodeColumnMajor(
  s: string,
  width: number,
  height: number,
): string[][] {
  if (s.length !== width * height) {
    throw new Error(
      `decodeColumnMajor: string length ${s.length} ≠ width×height = ${width}×${height} = ${width * height}`,
    );
  }
  const reels: string[][] = [];
  for (let r = 0; r < width; r++) {
    const reel: string[] = [];
    for (let h = 0; h < height; h++) reel.push(s[r * height + h]!);
    reels.push(reel);
  }
  return reels;
}

export const genericProvider: ProviderAdapter = {
  providerCode: "GENERIC",
  urlPattern: getSpinUrlPattern(),
  skipUrl: shouldSkipUrl,
  parseBody: tryParseBody,
  scoreSpinShape: (parsed) => {
    const s = scoreSpinShape(parsed);
    return { score: s.score, reasons: s.reasons };
  },
  parseRequest: genericParseRequest,
  parseResponse: genericParseResponse,
};
