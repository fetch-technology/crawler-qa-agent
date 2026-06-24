// Spec-Driven Parser (Phase 9). Generic BaseParser implementation that
// reads ProviderSpec JSON to handle ANY provider. Replaces PragmaticParser /
// GenericParser one-off implementations.
//
// Adding new providers = author a JSON spec, register it. No TS code.

import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";
import type { ProviderSpec, ReelsDecoder } from "./spec-types.js";
import { parseWlcV, parseClusterWins } from "../win-breakdown.js";

/** Resolve a field-spec string into a list of candidate field names.
 *  Accepts plain "ba" or pipe-separated "ba|balance|balance_cash" for cases
 *  where the same logical field has different names across game variants. */
function fieldAliases(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec.split("|").map((s) => s.trim()).filter(Boolean);
}

/** Resolve a possibly-DEEP field path ("a.b.c") against a parsed object. A path
 *  with no dot is a plain top-level lookup (preserves legacy behavior). Returns
 *  undefined when any segment is missing. */
function getDeep(obj: Record<string, unknown>, pathStr: string): unknown {
  if (!pathStr.includes(".")) return obj[pathStr];
  let cur: unknown = obj;
  for (const seg of pathStr.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Return value of first present alias from parsed map, or undefined. Supports
 *  deep dot-paths within each `|` alternative. */
function pickField(parsed: Record<string, unknown>, spec: string | undefined): unknown {
  for (const name of fieldAliases(spec)) {
    const v = getDeep(parsed, name);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** True if ANY alias of `spec` resolves to a present (non-undefined) value. */
function fieldPresent(parsed: Record<string, unknown>, spec: string | undefined): boolean {
  return fieldAliases(spec).some((n) => getDeep(parsed, n) !== undefined);
}

/** Itemize per-combo wins per the spec's `winItemization` mode. Default
 *  ("auto"/undefined) matches the legacy PragmaticParser: parseWlcV, which
 *  itself falls back to cluster `l0,l1,…` when no `wlc_v` is present — so PP
 *  ways/lines AND cluster games both populate winBreakdown without per-game
 *  config. "none" opts out (provider truly reports only a total). */
function parseWinItemization(
  parsedRes: Record<string, unknown>,
  mode: ProviderSpec["response"]["winItemization"],
): import("../win-breakdown.js").WinCombo[] {
  switch (mode) {
    case "none":
      return [];
    case "cluster":
      return parseClusterWins(parsedRes);
    case "lines":
    case "wlc_v":
    case "auto":
    case undefined:
    default:
      return parseWlcV(parsedRes); // wlc_v with internal cluster fallback
  }
}

/** Merge a per-game overlay onto a provider base spec → a NEW effective spec
 *  (base is never mutated). Each overlay aspect overrides the base ONLY when
 *  `trusted` — an unverified aspect is ignored so the game safely falls back
 *  to the provider default. Pure; exported for tests + parser-factory. */
export function mergeSpec(
  base: ProviderSpec,
  overlay: import("./spec-types.js").ParserOverlay,
): ProviderSpec {
  // Shallow clone is enough: the only fields overlay touches live under
  // `response`, so clone spec + response and override there.
  const merged: ProviderSpec = { ...base, response: { ...base.response } };
  if (overlay.winItemization?.trusted) {
    merged.response.winItemization = overlay.winItemization.value;
  }
  // Free-spin/feature state detector (Layer 3) — applied only when the
  // replay-gate (INV4) certified it discriminates FS vs base on real samples.
  if (overlay.freeSpinSignal?.trusted) {
    merged.response.freeSpinSignal = overlay.freeSpinSignal.value;
  }
  // Nested extractions (e.g. pull `fs~N` out of a delimited `trail` field).
  // Append to the base list so a provider-level extraction isn't lost.
  if (overlay.nestedExtractions?.trusted && overlay.nestedExtractions.value) {
    merged.response.nestedExtractions = [
      ...(base.response.nestedExtractions ?? []),
      ...overlay.nestedExtractions.value,
    ];
  }
  return merged;
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
  if (decoder === "json_array" && Array.isArray(raw)) {
    // Stringify cell values (3 Oaks board is number[][]) so reels are always
    // string[][]. Idempotent for specs whose arrays are already strings.
    return (raw as unknown[]).map((col) =>
      Array.isArray(col) ? (col as unknown[]).map((s) => String(s)) : [String(col)],
    );
  }
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
/** Evaluate a declarative {@link FreeSpinSignal} against a parsed response (and
 *  optionally the raw body, for `rawBodyPattern`). Returns true when ANY of the
 *  configured matchers fires. Pure; no balance reasoning (the caller still
 *  applies the balance guard so a BUY frame stays NORMAL). */
export function matchFreeSpinSignal(
  parsed: Record<string, unknown>,
  signal: import("./spec-types.js").FreeSpinSignal | undefined,
  rawBody?: string,
): boolean {
  if (!signal) return false;
  // (a) numeric counter field > 0
  if (signal.counterField) {
    const n = Number(pickField(parsed, signal.counterField));
    if (Number.isFinite(n) && n > 0) return true;
  }
  // (b) substring / regex against a named string field
  if (signal.field) {
    const raw = pickField(parsed, signal.field);
    const val = typeof raw === "string" ? raw : raw != null ? String(raw) : "";
    if (val) {
      if (signal.contains && val.includes(signal.contains)) return true;
      if (signal.pattern) {
        try {
          if (new RegExp(signal.pattern).test(val)) return true;
        } catch {
          /* invalid regex → ignore matcher */
        }
      }
    }
  }
  // (c) last-resort regex against the raw response body
  if (signal.rawBodyPattern && typeof rawBody === "string" && rawBody.length > 0) {
    try {
      if (new RegExp(signal.rawBodyPattern).test(rawBody)) return true;
    } catch {
      /* invalid regex → ignore matcher */
    }
  }
  return false;
}

function deriveState(
  parsed: Record<string, unknown>,
  fieldMap: ProviderSpec["response"]["fields"],
  signal?: import("./spec-types.js").FreeSpinSignal,
  rawBody?: string,
): SpinState {
  const fsRaw = pickField(parsed, fieldMap.freeSpinsRemaining);
  const fs = Number(fsRaw);
  const numericFree = Number.isFinite(fs) && fs > 0;
  const signalFree = matchFreeSpinSignal(parsed, signal, rawBody);
  // No FS evidence from either the numeric counter OR the declarative signal.
  if (!numericFree && !signalFree) return "NORMAL";
  const bbRaw = pickField(parsed, fieldMap.balanceBefore);
  const baRaw = pickField(parsed, fieldMap.balanceAfter);
  const bb = bbRaw != null ? Number(bbRaw) : NaN;
  const ba = baRaw != null ? Number(baRaw) : NaN;
  const balanceDecreased = Number.isFinite(bb) && Number.isFinite(ba) && bb - ba > 0.01;
  const balanceUnknown = !Number.isFinite(bb) || !Number.isFinite(ba);
  // Conservative: when balance demonstrably DROPPED OR is unknown → NORMAL.
  // Only flag FREE_SPIN when balance is KNOWN to be stable/up. This is what
  // keeps a BUY frame (signal/counter present, but the wallet drops by the buy
  // cost) classified NORMAL.
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

  // Not readonly: applyOverlay() swaps in a per-game MERGED spec. mergeSpec
  // returns a fresh object, so the provider-base spec (shared across games via
  // the parser factory closure) is never mutated — only this instance's
  // pointer moves.
  constructor(public spec: ProviderSpec, kind: ParserKind = "PragmaticParser") {
    this.kind = kind;
    this.providerCode = spec.name.toUpperCase().slice(0, 4);
  }

  setBetMultiplier(m: number | undefined): void {
    this.betMultiplier = m && m > 0 ? m : undefined;
  }

  /** Apply a per-game parser overlay on top of the provider base spec. Only
   *  aspects marked `trusted` override the base (fail-loud: an unverified
   *  guess is ignored, falling back to base). No-op when overlay is null. */
  applySpecOverlay(overlay: import("./spec-types.js").ParserOverlay | null | undefined): void {
    if (overlay) this.spec = mergeSpec(this.spec, overlay);
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
    return this.normalize(null, parsed, raw);
  }

  parseSpinPair(request: string | null, response: string, _url?: string): NormalizedSpinResult {
    const parsedRes = parseBodyBySpec(response, this.spec.wireFormat);
    if (!parsedRes) throw new Error(`SpecDrivenParser(${this.spec.name}): cannot parse response body`);
    applyNestedExtractions(parsedRes, this.spec.response.nestedExtractions);
    const parsedReq = request ? parseBodyBySpec(request, this.spec.wireFormat) : null;
    return this.normalize(parsedReq, parsedRes, response);
  }

  private normalize(
    parsedReq: Record<string, unknown> | null,
    parsedRes: Record<string, unknown>,
    rawBody?: string,
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
    const signal = this.spec.response.freeSpinSignal;
    const fsRaw = pickField(parsedRes, fields.freeSpinsRemaining);
    // Primary: the mapped counter. Fallback: the signal's counterField, so the
    // downstream `freeSpinsRemaining > 0` branches (bet-reconcile, case-executor
    // FS re-eval) light up for a clone whose FS counter lives off the standard
    // field (e.g. extracted from `trail`).
    const signalFsRaw = signal?.counterField ? pickField(parsedRes, signal.counterField) : undefined;
    const effFsRaw = fsRaw !== undefined ? fsRaw : signalFsRaw;
    const freeSpinsRemaining = effFsRaw !== undefined && Number.isFinite(num(effFsRaw, NaN))
      ? num(effFsRaw)
      : null;
    const state = deriveState(parsedRes, fields, signal, rawBody);
    const isFreeSpin = state === "FREE_SPIN";
    // Money scale: providers reporting MINOR units (cents) set amountScale=0.01
    // so balance/win/bet come out in display units. Default 1 (no-op).
    const scale = this.spec.response.amountScale && this.spec.response.amountScale > 0
      ? this.spec.response.amountScale : 1;
    const balanceAfter = num(pickField(parsedRes, fields.balanceAfter)) * scale;
    const win = num(pickField(parsedRes, fields.totalWin)) * scale;
    // 2026-05-26 alignment with PragmaticParser: FS frames carry the same `c`
    // in request but server doesn't deduct → set bet=0 for FS spins so
    // balance arithmetic + dedup deriveWin work correctly. See
    // pragmatic-parser.ts toNormalized for full rationale.
    // Bet source: RESPONSE betAmount (scaled) when the spec maps it (3 Oaks-style
    // providers put round_bet in the response); else the request betFormula.
    const betAmountRaw = pickField(parsedRes, fields.betAmount);
    const responseBet = fields.betAmount && betAmountRaw !== undefined ? num(betAmountRaw) * scale : null;
    const requestBet = computeBetBySpec(parsedReq, this.spec.request, this.betMultiplier);
    const bet = isFreeSpin ? 0 : (responseBet ?? requestBet);
    const bbRaw = pickField(parsedRes, fields.balanceBefore);
    const balanceBefore = fields.balanceBefore && bbRaw !== undefined
      ? num(bbRaw, 0) * scale
      : (this.spec.response.deriveBalanceBefore
          ? Math.round((balanceAfter + bet - win) * 100) / 100
          : null);
    // Payout-integrity inputs. Without these the spec-driven path left
    // winBreakdown empty + serverTotalWin undefined, which silently disabled
    // every payout-integrity assertion (Σcombos==tw, no-phantom-win) — the
    // legacy PragmaticParser set both, so spec-driven games regressed. The
    // values come straight from the already-parsed response; cascade-dedup
    // accumulates winBreakdown across tumble frames downstream.
    const twVal = pickField(parsedRes, fields.totalWin);
    const twNum = twVal != null ? Number(twVal) * scale : NaN;
    return {
      roundId: buildRoundIdBySpec(parsedReq, parsedRes, this.spec.roundId),
      bet,
      win,
      balanceBefore,
      balanceAfter,
      reels,
      cascadeFrames,
      state,
      freeSpinsRemaining,
      isFreeSpin,
      hasBonus: state === "BONUS",
      raw: parsedRes,
      winBreakdown: parseWinItemization(parsedRes, this.spec.response.winItemization),
      serverTotalWin: Number.isFinite(twNum) ? twNum : undefined,
    };
  }
}
