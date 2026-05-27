// Spec-Driven Parser (Phase 9). Generic BaseParser implementation that
// reads ProviderSpec JSON to handle ANY provider. Replaces PragmaticParser /
// GenericParser one-off implementations.
//
// Adding new providers = author a JSON spec, register it. No TS code.

import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";
import type { ProviderSpec, ReelsDecoder } from "./spec-types.js";

/** Resolve a field-spec string into a list of candidate field names.
 *  Accepts plain "ba" or pipe-separated "ba|balance|balance_cash" for cases
 *  where the same logical field has different names across game variants. */
function fieldAliases(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec.split("|").map((s) => s.trim()).filter(Boolean);
}

/** Return value of first present alias from parsed map, or undefined. */
function pickField(parsed: Record<string, unknown>, spec: string | undefined): unknown {
  for (const name of fieldAliases(spec)) {
    if (name in parsed) return parsed[name];
  }
  return undefined;
}

/** True if ANY alias of `spec` is present in parsed. */
function fieldPresent(parsed: Record<string, unknown>, spec: string | undefined): boolean {
  return fieldAliases(spec).some((n) => n in parsed);
}

/** Mutates `parsed` in place: for each extraction, read the source field as
 *  a string, run the regex, and set `targetField` to the first capture group.
 *  Won't overwrite existing keys (real wire fields always win). No-op when
 *  `extractions` is undefined or empty. */
export function applyNestedExtractions(
  parsed: Record<string, unknown>,
  extractions: ProviderSpec["response"]["nestedExtractions"],
): void {
  if (!extractions || extractions.length === 0) return;
  for (const ex of extractions) {
    if (ex.targetField in parsed) continue;
    const source = parsed[ex.sourceField];
    if (typeof source !== "string" || source.length === 0) continue;
    let re: RegExp;
    try {
      re = new RegExp(ex.pattern);
    } catch {
      continue;
    }
    const m = source.match(re);
    if (m && m[1] !== undefined) parsed[ex.targetField] = m[1];
  }
}

/** Parse body according to spec.wireFormat. Returns flat key→value map. */
export function parseBodyBySpec(raw: string, wireFormat: ProviderSpec["wireFormat"]): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (wireFormat === "json" || (wireFormat === "auto" && (trimmed.startsWith("{") || trimmed.startsWith("[")))) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      if (wireFormat === "json") return null;
      // auto: fall through to querystring
    }
  }
  // querystring / form / auto fallback
  try {
    const params = new URLSearchParams(trimmed);
    const out: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** Compute spin-shape score per spec.shapeScore. */
export function scoreSpinShapeBySpec(
  parsed: Record<string, unknown> | null,
  spec: ProviderSpec["response"]["shapeScore"],
): { score: number; reasons: string[] } {
  if (!parsed) return { score: 0, reasons: ["body unparseable"] };
  const reasons: string[] = [];
  let score = 0;
  for (const field of spec.requiredFields) {
    if (fieldPresent(parsed, field)) {
      score++;
      reasons.push(`+${field}`);
    } else {
      score--;
      reasons.push(`-${field}`);
    }
  }
  for (const field of spec.bonusFields ?? []) {
    if (fieldPresent(parsed, field)) {
      score++;
      reasons.push(`+${field}(bonus)`);
    }
  }
  return { score, reasons };
}

/** Decode reels string into 2D array per spec.reelsDecoder. */
export function decodeReelsBySpec(
  raw: unknown,
  decoder: ReelsDecoder | undefined,
  width: number,
  height: number,
): string[][] {
  if (raw == null) return [];
  if (decoder === "json_array" && Array.isArray(raw)) return raw as string[][];
  if (typeof raw !== "string" || raw.length === 0) return [];
  // Auto-detect comma-separated symbol IDs (e.g. PP newer slots:
  // s:"13,13,13,1,2,3,...") vs single-char symbols (PP classic: "ABCDEFGHIJKLMNO").
  // Both encode the same logical 2D grid; only the per-symbol representation
  // differs. By tokenizing on comma when present, column_major / row_major
  // decoders work for both styles without a separate decoder name.
  const tokens = raw.includes(",")
    ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : Array.from(raw);
  if (decoder === "column_major") {
    if (tokens.length !== width * height) return [];
    const reels: string[][] = [];
    for (let r = 0; r < width; r++) {
      const reel: string[] = [];
      for (let h = 0; h < height; h++) reel.push(tokens[r * height + h]!);
      reels.push(reel);
    }
    return reels;
  }
  if (decoder === "row_major") {
    if (tokens.length !== width * height) return [];
    const reels: string[][] = [];
    for (let r = 0; r < width; r++) {
      const reel: string[] = [];
      for (let h = 0; h < height; h++) reel.push(tokens[h * width + r]!);
      reels.push(reel);
    }
    return reels;
  }
  if (decoder === "csv") {
    const rows = raw.split(/[\n|]/).map((row) => row.split(","));
    return rows;
  }
  return [];
}

/** Compute bet per spec.request.betFormula. Supports formula strings like
 *  "coin * betLevel", "coin * lines", "coin * fixed:20", "explicit", or
 *  pipe-separated alternatives ("coin * betLevel | coin * lines"). */
export function computeBetBySpec(
  parsed: Record<string, unknown> | null,
  request: ProviderSpec["request"],
  betMultiplier?: number,
): number {
  if (!parsed) return 0;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const c = num(parsed[request.fields.coin ?? "c"]);
  const bl = num(parsed[request.fields.betLevel ?? "bl"]);
  const l = num(parsed[request.fields.lines ?? "l"]);
  const explicit = num(parsed[request.fields.explicitBet ?? ""]);
  // betMultiplier from game-mechanics override takes priority
  if (c > 0 && typeof betMultiplier === "number" && betMultiplier > 0) {
    return c * betMultiplier;
  }
  // Try each alternative in the formula string (split by |)
  for (const formula of request.betFormula.split("|").map((s) => s.trim())) {
    if (formula === "explicit" && explicit > 0) return explicit;
    if (formula === "coin * betLevel" && c > 0 && bl > 0) return c * bl;
    if (formula === "coin * lines" && c > 0 && l > 0) return c * l;
    const fixedMatch = formula.match(/^coin \* fixed:(\d+(?:\.\d+)?)$/);
    if (fixedMatch && c > 0) return c * Number(fixedMatch[1]);
  }
  return 0;
}

/** Build round ID per spec.roundId. */
export function buildRoundIdBySpec(
  parsedRequest: Record<string, unknown> | null,
  parsedResponse: Record<string, unknown>,
  cfg: ProviderSpec["roundId"],
): string {
  const source = cfg.source === "request" ? parsedRequest : parsedResponse;
  if (!source) {
    if (cfg.fallback === "throw") throw new Error("Cannot build roundId: source missing");
    return fallback(cfg.fallback, parsedResponse);
  }
  const values = cfg.fields.map((f) => String(source[f] ?? ""));
  if (values.some((v) => !v)) {
    return fallback(cfg.fallback, parsedResponse);
  }
  const format = cfg.format ?? values.map((_, i) => `{${i}}`).join("-");
  return format.replace(/\{(\d+)\}/g, (_, idx) => values[Number(idx)] ?? "");
}

function fallback(strategy: ProviderSpec["roundId"]["fallback"], response: Record<string, unknown>): string {
  if (strategy === "timestamp_random") {
    return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  // response_hash (default) or "throw" (already handled)
  const json = JSON.stringify(response).slice(0, 32);
  let hash = 0;
  for (let i = 0; i < json.length; i++) hash = ((hash << 5) - hash + json.charCodeAt(i)) | 0;
  return `hash-${Math.abs(hash).toString(36)}`;
}

/** Derive SpinState from response fields per spec. Simple default mapping
 *  (per-game override can come from state-signatures later).
 *
 *  2026-05-26: require BOTH fs > 0 AND balance demonstrably stable/up.
 *  BUY transactions have fs > 0 (forward counter "you'll get N free spins")
 *  but balance DROPS by the buy cost — those should stay NORMAL, not
 *  FREE_SPIN. When balance is UNKNOWN (PP BUY response has no `bb` field),
 *  default to NORMAL conservatively — case-executor's priorBalance patch
 *  isn't applied yet at parser time, so balance-decrease can't be observed
 *  via response alone. Aligns with pragmatic.ts ppParseResponse adapter
 *  logic. */
function deriveState(parsed: Record<string, unknown>, fieldMap: ProviderSpec["response"]["fields"]): SpinState {
  const fsRaw = pickField(parsed, fieldMap.freeSpinsRemaining);
  const fs = Number(fsRaw);
  if (!Number.isFinite(fs) || fs <= 0) return "NORMAL";
  const bbRaw = pickField(parsed, fieldMap.balanceBefore);
  const baRaw = pickField(parsed, fieldMap.balanceAfter);
  const bb = bbRaw != null ? Number(bbRaw) : NaN;
  const ba = baRaw != null ? Number(baRaw) : NaN;
  const balanceDecreased = Number.isFinite(bb) && Number.isFinite(ba) && bb - ba > 0.01;
  const balanceUnknown = !Number.isFinite(bb) || !Number.isFinite(ba);
  // Conservative: when balance demonstrably DROPPED OR is unknown → NORMAL.
  // Only flag FREE_SPIN when balance is KNOWN to be stable/up.
  if (balanceDecreased || balanceUnknown) return "NORMAL";
  return "FREE_SPIN";
}

/** The generic spec-driven parser. Implements BaseParser. Same shape as
 *  PragmaticParser so existing callers (case-executor, parser-factory)
 *  work without change. */
export class SpecDrivenParser implements BaseParser {
  readonly kind: ParserKind;
  readonly providerCode: string;
  private betMultiplier: number | undefined;

  constructor(public readonly spec: ProviderSpec, kind: ParserKind = "PragmaticParser") {
    this.kind = kind;
    this.providerCode = spec.name.toUpperCase().slice(0, 4);
  }

  setBetMultiplier(m: number | undefined): void {
    this.betMultiplier = m && m > 0 ? m : undefined;
  }

  canParseResponse(raw: string, url?: string): boolean {
    if (url) {
      const matches = this.spec.urlPatterns.some((p) => new RegExp(p, "i").test(url));
      if (!matches) return false;
      const skipped = (this.spec.skipUrlPatterns ?? []).some((p) => new RegExp(p, "i").test(url));
      if (skipped) return false;
    }
    const parsed = parseBodyBySpec(raw, this.spec.wireFormat);
    if (!parsed) return false;
    // Action filter — skip non-spin actions if the response echoes the action.
    // spinRequiredParams is REQUEST-side context, not response — don't apply
    // here (that's for route-mock filtering at request time).
    const action = String(parsed["a"] ?? parsed["action"] ?? "");
    if (action && this.spec.nonSpinActions?.includes(action)) return false;
    const { score } = scoreSpinShapeBySpec(parsed, this.spec.response.shapeScore);
    return score >= this.spec.response.shapeScore.minScore;
  }

  parseResponse(raw: string): NormalizedSpinResult {
    const parsed = parseBodyBySpec(raw, this.spec.wireFormat);
    if (!parsed) throw new Error(`SpecDrivenParser(${this.spec.name}): cannot parse response body`);
    applyNestedExtractions(parsed, this.spec.response.nestedExtractions);
    return this.normalize(null, parsed);
  }

  parseSpinPair(request: string | null, response: string, _url?: string): NormalizedSpinResult {
    const parsedRes = parseBodyBySpec(response, this.spec.wireFormat);
    if (!parsedRes) throw new Error(`SpecDrivenParser(${this.spec.name}): cannot parse response body`);
    applyNestedExtractions(parsedRes, this.spec.response.nestedExtractions);
    const parsedReq = request ? parseBodyBySpec(request, this.spec.wireFormat) : null;
    return this.normalize(parsedReq, parsedRes);
  }

  private normalize(
    parsedReq: Record<string, unknown> | null,
    parsedRes: Record<string, unknown>,
  ): NormalizedSpinResult {
    const fields = this.spec.response.fields;
    const num = (v: unknown, fallback = 0): number => {
      if (v === undefined || v === null) return fallback;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const width = num(pickField(parsedRes, fields.reelWidth), this.spec.response.defaultReelDimensions?.width ?? 5);
    const height = num(pickField(parsedRes, fields.reelHeight), this.spec.response.defaultReelDimensions?.height ?? 3);
    const reels = decodeReelsBySpec(
      pickField(parsedRes, fields.initialReels),
      this.spec.response.reelsDecoder,
      width,
      height,
    );
    const cascadeFrames: string[][][] = [];
    if (fields.cascadeFrames) {
      const cf = pickField(parsedRes, fields.cascadeFrames);
      const initial = pickField(parsedRes, fields.initialReels);
      if (typeof cf === "string" && cf.length > 0 && cf !== initial) {
        const frame = decodeReelsBySpec(cf, this.spec.response.reelsDecoder, width, height);
        if (frame.length > 0) cascadeFrames.push(frame);
      }
    }
    const fsRaw = pickField(parsedRes, fields.freeSpinsRemaining);
    const freeSpinsRemaining = fields.freeSpinsRemaining && fsRaw !== undefined
      ? (Number.isFinite(num(fsRaw, NaN)) ? num(fsRaw) : null)
      : null;
    const state = deriveState(parsedRes, fields);
    const isFreeSpin = state === "FREE_SPIN";
    const bbRaw = pickField(parsedRes, fields.balanceBefore);
    const balanceBefore = fields.balanceBefore && bbRaw !== undefined ? num(bbRaw, 0) : null;
    // 2026-05-26 alignment with PragmaticParser: FS frames carry the same `c`
    // in request but server doesn't deduct → set bet=0 for FS spins so
    // balance arithmetic + dedup deriveWin work correctly. See
    // pragmatic-parser.ts toNormalized for full rationale.
    const requestBet = computeBetBySpec(parsedReq, this.spec.request, this.betMultiplier);
    const bet = isFreeSpin ? 0 : requestBet;
    return {
      roundId: buildRoundIdBySpec(parsedReq, parsedRes, this.spec.roundId),
      bet,
      win: num(pickField(parsedRes, fields.totalWin)),
      balanceBefore,
      balanceAfter: num(pickField(parsedRes, fields.balanceAfter)),
      reels,
      cascadeFrames,
      state,
      freeSpinsRemaining,
      isFreeSpin,
      hasBonus: state === "BONUS",
      raw: parsedRes,
    };
  }
}
