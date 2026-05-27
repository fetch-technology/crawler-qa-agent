/**
 * Statistical layer — verify math properties (RTP, hit frequency, win distribution)
 * bằng cách bắn N spins TRỰC TIẾP tới spin endpoint, không qua UI.
 *
 * Tại sao không qua UI?
 *   - 100k spins qua UI ≈ 83 giờ (3s/spin). Qua API ≈ vài phút.
 *   - UI render không thay đổi math properties → testing math qua UI là waste.
 *
 * Cách hoạt động:
 *   1. Load recording đã có (fixtures/recordings/{slug}__...) → tìm 1 spin request mẫu
 *      (URL + headers + cookies + post body) → đây là "template request".
 *   2. Cũng load authorize-game response để biết starting balance, currency.
 *   3. Fire template request N lần. Mỗi response parse → cộng vào aggregator.
 *   4. Output: { RTP, hit_freq, win_distribution, max_win, ... }.
 *
 * Lưu ý:
 *   - Bài này phụ thuộc server vẫn accept token cũ. Token thường expire 24h-7d,
 *     nên record cần fresh trước khi sim.
 *   - Một số provider rate-limit. Mặc định throttle 100 req/s.
 *   - Một số provider yêu cầu cookie session → load từ recording (chưa implement,
 *     hiện chỉ replay header).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getSpinUrlPattern,
  scoreSpinShape,
  shouldSkipUrl,
  tryParseBody,
} from "../runner/spin-detect.js";
import {
  assertPayoutMatchesPaytable,
  assertPayoutMatchesPaytableCascade,
  auditSymbolPalette,
  auditWinlines,
} from "../runner/rule-engine.js";
import type { GameSpec } from "../ai/authoring.js";
import {
  classifyScenario,
  saveScenario,
  scenarioPath,
  type Scenario,
  type ScenarioLabel,
  type SpinResponseFixture,
} from "../runner/scenario.js";

type HttpEntry = {
  t: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  headers?: Record<string, string>;
  postData?: string | null;
  body?: string | null;
};

export type SimulateOpts = {
  slug: string;
  spins: number;
  /** Concurrent in-flight requests. Default 4 — bảo thủ để tránh rate-limit. */
  concurrency?: number;
  /** Min ms giữa các request (per-worker). Default 10. */
  throttleMs?: number;
  /** Verbose log mỗi N spins. Default 100. */
  progressEvery?: number;
  /**
   * Token preflight: bắn 1 request thử trước khi chạy mass-spin. Nếu HTTP 401/403
   * → token expired → throw helpful error gợi ý re-record. Default true.
   */
  preflightTokenCheck?: boolean;
  /**
   * Optional GameSpec — bật consistency check per-spin. Mỗi response sẽ chạy
   * `assertPayoutMatchesPaytable` → catches server bug (matrix không pay nhưng
   * server báo win, hoặc payout sai paytable).
   *
   * Không pass → consistency check skip, chỉ aggregate RTP/hit rate như cũ.
   */
  spec?: GameSpec | null;
  /** Max mismatch examples giữ lại trong result (tránh OOM khi sim 100k). Default 20. */
  maxMismatchExamples?: number;
  /**
   * Debug mode: dump first N raw response bodies + request bodies to
   * `fixtures/statistical/{slug}-{ts}-debug/`. Lets caller manually inspect
   * whether server returns identical responses (replay/cached) or distinct
   * (real RNG). Default null (off).
   */
  dumpResponses?: number | null;
  /**
   * Discovery mode: classify each successful response and save rare labels
   * (bonus_trigger, free_spin, big_win, max_win) as scenario fixtures to
   * `fixtures/scenarios/{slug}/`. Existing files are NOT overwritten unless
   * `overwriteScenarios=true`.
   *
   * Use case: re-record once with --extract-scenarios → automatically
   * populate scenario library from real RNG responses. Eliminates need to
   * manually trigger bonus rounds to capture them.
   */
  extractScenarios?: boolean;
  /** Force-overwrite existing scenario files. Default false (only saves missing). */
  overwriteScenarios?: boolean;
  /**
   * Performance SLO: per-spin response time threshold in ms. Each spin
   * exceeding this contributes to `performance.slowSpins`. Default 500ms
   * (matches QA checklist standard for slot games).
   */
  maxResponseMs?: number;
  /**
   * History audit: after sim completes, fire game's history endpoint
   * (action=doHistory or /history/) and compare returned rows against
   * collected spin data. Catches: missing rows, wrong bet/win/balance in
   * history, server-side audit log bugs.
   */
  historyAudit?: boolean;
};

export type PayoutMismatchExample = {
  spinIndex: number;
  expected: number;
  actual: number;
  delta: number;
  reels: string;
  detail: string;
};

export class TokenExpiredError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message);
    this.name = "TokenExpiredError";
  }
}

export type SimulateResult = {
  slug: string;
  spinsRequested: number;
  spinsSuccessful: number;
  spinsFailed: number;
  totalBet: number;
  totalWin: number;
  observedRTP: number | null;
  hitFrequency: number | null;
  maxWin: number;
  maxWinMultiplier: number | null;
  /** Mean win across WINNING spins only (excludes zeros). */
  averageWin: number | null;
  /** Standard deviation of win/bet ratio across all spins. */
  volatility: number | null;
  /** Coarse volatility band derived from std dev. */
  volatilityBand: "low" | "medium" | "high" | "very_high" | null;
  /** 95% confidence interval half-width for RTP estimate. */
  rtpConfidence95: number | null;
  /** Feature trigger rates as fraction of all successful spins. */
  featureFrequency: {
    freeSpinTrigger: number | null;
    bonusTrigger: number | null;
    freeSpinRuns: number | null;
    retrigger: number | null;
  };
  /** Symbol counts across all decoded reel matrices. */
  symbolDistribution: Record<string, number>;
  winDistribution: {
    /** Bucket boundaries dùng multiplier of bet (win/bet). */
    buckets: Array<{ min: number; max: number; count: number; pctOfSpins: number }>;
  };
  /**
   * Per-spin payout consistency vs paytable (chỉ điền khi pass `spec`).
   * Null khi consistency check không chạy.
   */
  consistency: {
    spinsChecked: number;
    payoutMismatches: number;
    inconclusive: number;
    /** spinsChecked > 0 ? payoutMismatches / spinsChecked : null */
    mismatchRate: number | null;
    /** Sample mismatches để dashboard hiển thị (cap maxMismatchExamples). */
    examples: PayoutMismatchExample[];
  } | null;
  /**
   * Debug diagnostic. Populated when `dumpResponses > 0`. Helps catch
   * "server returns same body 1000 times" replay/cache bug.
   */
  debugDump: {
    dir: string;
    fileCount: number;
    /** sha1 hash của body từng spin được dump. Nếu tất cả identical → server replay. */
    uniqueHashes: number;
    hashes: string[];
  } | null;
  /**
   * Cascade chain stats. Populated when spec.cascade=true → sim fires doCollect
   * follow-ups to capture full cascade tier chain.
   */
  cascadeStats: {
    enabled: boolean;
    totalFrames: number;
    avgFramesPerSpin: number;
  } | null;
  /**
   * Schema audits — symbol palette + winlines references.
   */
  audits: {
    symbolMismatches: number;
    unknownSymbolsSeen: string[];
    winlinesInvalid: number;
  } | null;
  /**
   * History endpoint audit. Compare game's history response (recorded rounds)
   * with this run's sent spins. Detects: missing rows, wrong bet/win/balance
   * in audit log, server-side history bug.
   */
  historyAudit: {
    enabled: boolean;
    /** True if history endpoint found in recording + fetched successfully. */
    fetched: boolean;
    /** Reason if fetched=false. */
    reason: string | null;
    /** Number of history rows returned by server. */
    rowsReturned: number;
    /** Number of THIS sim's spins matched in history (by round_id or balance trace). */
    matched: number;
    /** Spins not found in history — server-side data loss. */
    missing: number;
    /** Per-field mismatches (bet/win/balance differ between history and spin). */
    fieldMismatches: number;
    /** Sample mismatch examples. */
    examples: Array<{ field: string; expected: number; actual: number; spinIndex: number }>;
  } | null;
  /**
   * Per-spin response time metrics. Covers QA checklist "Spin response time
   * < 500ms" (perf SLO).
   */
  performance: {
    /** Min response time (ms). */
    minMs: number;
    /** Max response time (ms). */
    maxMs: number;
    /** Mean response time (ms). */
    meanMs: number;
    /** Median response time (ms). */
    medianMs: number;
    /** p95 response time (ms). */
    p95Ms: number;
    /** p99 response time (ms). */
    p99Ms: number;
    /** SLO threshold (ms). */
    thresholdMs: number;
    /** Number of spins exceeding threshold. */
    slowSpins: number;
    /** Fraction of spins exceeding threshold. */
    slowRate: number;
  } | null;
  /**
   * Scenarios discovered & saved from real responses. Populated when
   * `extractScenarios=true`.
   */
  extractedScenarios: {
    enabled: boolean;
    saved: Array<{ label: string; path: string; spinIndex: number }>;
    /** Labels seen in run but not saved (already exist, overwrite=false). */
    seenButSkipped: string[];
  } | null;
  durationMs: number;
  errors: Array<{ status: number | null; message: string; count: number }>;
};

const RECORDINGS_DIR = "fixtures/recordings";
const SPIN_PATTERN = getSpinUrlPattern();

type SpinTemplate = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  postData: string | null;
};

function latestRecording(slug: string): string | null {
  if (!existsSync(RECORDINGS_DIR)) return null;
  const dirs = readdirSync(RECORDINGS_DIR)
    .filter((n) => n.startsWith(slug + "__"))
    .map((n) => join(RECORDINGS_DIR, n))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function readEntries(dir: string): HttpEntry[] {
  const path = join(dir, "http.jsonl");
  if (!existsSync(path)) return [];
  const out: HttpEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Find history endpoint template (action=doHistory or URL like /history/) from recording.
 * Returns template ready to fire after sim to verify recorded history.
 */
function isHistoryRequest(body: string | null | undefined, url: string): boolean {
  const combined = `${url}&${body ?? ""}`;
  if (HISTORY_ACTION_RE.test(combined)) return true;
  if (HISTORY_URL_RE.test(url)) return true;
  return false;
}

type HistoryRow = {
  roundId: string | null;
  bet: number;
  win: number;
  balance: number;
};

/**
 * Parse history endpoint response into normalized rows. Provider-agnostic
 * heuristic — tries common shapes:
 *   - JSON array `[{id, bet, win, balance}]`
 *   - JSON object `{history: [...]}` or `{rounds: [...]}`
 *   - PP URL-encoded `hl=...` field with serialized rows
 */
function parseHistoryRows(text: string): HistoryRow[] {
  const trimmed = text.trim();
  let rows: Array<Record<string, unknown>> = [];
  // JSON array
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) rows = arr;
    } catch {}
  }
  // JSON object wrapping list
  if (rows.length === 0 && trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      for (const key of ["history", "rounds", "list", "items", "data"]) {
        const v = obj?.[key];
        if (Array.isArray(v)) {
          rows = v;
          break;
        }
      }
    } catch {}
  }
  // Normalize each row
  return rows.map((r) => {
    const roundId =
      (r.id ?? r.round ?? r.roundId ?? r.round_id ?? r.transactionId ?? null) as string | null;
    const bet = Number(r.bet ?? r.betAmount ?? r.totalBet ?? r.c ?? r.stake ?? 0);
    const win = Number(r.win ?? r.winAmount ?? r.tw ?? r.totalWin ?? r.payout ?? 0);
    const balance = Number(
      r.balance ?? r.endingBalance ?? r.balanceAfter ?? r.updatedBalance ?? 0,
    );
    return {
      roundId: roundId != null ? String(roundId) : null,
      bet: Number.isFinite(bet) ? bet : 0,
      win: Number.isFinite(win) ? win : 0,
      balance: Number.isFinite(balance) ? balance : 0,
    };
  });
}

function findHistoryTemplate(entries: HttpEntry[]): SpinTemplate | null {
  const openReqs = new Map<string, HttpEntry[]>();
  const candidates: Array<{
    template: SpinTemplate;
    score: number;
  }> = [];
  for (const e of entries) {
    const key = `${e.method ?? "GET"} ${e.url}`;
    if (e.phase === "request") {
      const arr = openReqs.get(key) ?? [];
      arr.push(e);
      openReqs.set(key, arr);
    } else if (e.phase === "response") {
      const req = openReqs.get(key)?.shift();
      if (!req || !e.body) continue;
      if (!isHistoryRequest(req.postData ?? "", req.url)) continue;
      // Accept even when rows are empty (`[]`) — endpoint template is still valid.
      // Some providers return empty history for new sessions.
      const text = e.body;
      const trimmed = text.trim();
      const parsedRows = parseHistoryRows(trimmed);
      const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
      if (!looksJson && parsedRows.length === 0 && trimmed.length < 2) continue;
      let score = 0;
      if (/\/history\/api\/history\/v2\/play-session\/last-items\?/i.test(req.url)) score += 100;
      if (/(?:^|[?&])(?:a|action)=do(History|GameHistory|GetHistory|HistoryList)/i.test(`${req.url}&${req.postData ?? ""}`)) score += 80;
      if (parsedRows.length > 0) score += 30;
      if (/^post$/i.test(req.method ?? "")) score += 15;
      if (/\/history\/\?symbol=/i.test(req.url) && /<(?:!doctype|html|body)\b/i.test(trimmed)) score -= 120;
      candidates.push({
        template: {
          url: req.url,
          method: ((req.method as "GET" | "POST") ?? "POST"),
          headers: sanitizeRequestHeaders(req.headers ?? {}),
          postData: req.postData ?? null,
        },
        score,
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.template;
}

/**
 * Reject requests that are NOT actual spin actions.
 *
 * Provider quirks:
 *   - PP (gs2c): same URL serves doInit / doSettings / doBonus / doHistory / doSpin
 *     → must check `a=doSpin` (or `action=doSpin`) in request body
 *   - RG: usually distinct URLs already filtered by SPIN_PATTERN
 *   - Generic: skip if body has well-known non-spin markers
 */
// Match `action=do<X>` or `a=do<X>` whether at start-of-body or after ?/& separator.
// URL-encoded form body STARTS with the first key (no leading & or ?), so the
// boundary must be `(^|[?&])`.
const NON_SPIN_ACTION_RE =
  /(?:^|[?&])(?:a|action)=do(Init|Settings|Bonus|Auth|History|Logout|Heartbeat|Buy|Help|GameLimits|Stats|SaveSettings|Collect)/i;
const SPIN_ACTION_RE = /(?:^|[?&])(?:a|action)=doSpin/i;
const ANY_ACTION_RE = /(?:^|[?&])(?:a|action)=/i;
// History endpoint detector (separate from spin)
const HISTORY_ACTION_RE =
  /(?:^|[?&])(?:a|action)=do(History|GameHistory|GetHistory|HistoryList)/i;
const HISTORY_URL_RE = /\/history(?:[?&/]|$)|\/game[Hh]istory|\/getHistory/i;

function isSpinRequest(body: string | null | undefined, url: string): boolean {
  // Join URL + body with `&` so regex boundary `(?:^|[?&])` matches the
  // body's leading `action=` (URL-encoded forms start with key directly,
  // no leading `?` or `&`).
  const combined = `${url}&${body ?? ""}`;
  if (NON_SPIN_ACTION_RE.test(combined)) return false;
  // If request has any action= marker, require it be doSpin
  if (ANY_ACTION_RE.test(combined)) {
    return SPIN_ACTION_RE.test(combined);
  }
  // No action= marker (RG, PG, others) → accept, response score will filter
  return true;
}

function findSpinTemplate(entries: HttpEntry[]): SpinTemplate | null {
  // Pair request với response, pick request đầu tiên có response score >= 5
  // AND request body is genuinely a spin action (not doInit/doSettings/...)
  const openReqs = new Map<string, HttpEntry[]>();
  let rejected = 0;
  for (const e of entries) {
    if (shouldSkipUrl(e.url)) continue;
    const key = `${e.method ?? "GET"} ${e.url}`;
    if (e.phase === "request") {
      const arr = openReqs.get(key) ?? [];
      arr.push(e);
      openReqs.set(key, arr);
    } else if (e.phase === "response") {
      const req = openReqs.get(key)?.shift();
      if (!req || !e.body) continue;
      if (!SPIN_PATTERN.test(e.url)) continue;
      // CRITICAL: filter out non-spin actions BEFORE scoring response.
      // PP gs2c endpoint serves doInit/doSettings/etc on same URL — those
      // responses also have balance + paytable + sa + sb → high spin-shape
      // score → would be picked as template → all "spins" return init data.
      if (!isSpinRequest(req.postData ?? "", req.url)) {
        rejected++;
        continue;
      }
      const parsed = tryParseBody(e.body);
      if (!parsed) continue;
      if (scoreSpinShape(parsed).score < 5) continue;
      if (rejected > 0) {
        console.log(`[simulate] Skipped ${rejected} non-spin request(s) (doInit/doSettings/etc) before finding template`);
      }
      return {
        url: req.url,
        method: ((req.method as "GET" | "POST") ?? "POST"),
        headers: sanitizeRequestHeaders(req.headers ?? {}),
        postData: req.postData ?? null,
      };
    }
  }
  return null;
}

const REQUEST_HEADER_DROPLIST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  ":authority",
  ":method",
  ":path",
  ":scheme",
]);

function sanitizeRequestHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (REQUEST_HEADER_DROPLIST.has(k.toLowerCase())) continue;
    if (k.startsWith(":")) continue;
    out[k] = v;
  }
  return out;
}

const WIN_BUCKETS = [
  { min: 0, max: 0 }, // exact 0 (no win)
  { min: 0.0001, max: 1 }, // partial recovery
  { min: 1, max: 2 }, // small
  { min: 2, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 50 },
  { min: 50, max: 200 },
  { min: 200, max: 1_000 },
  { min: 1_000, max: Infinity }, // max-win territory
];

function bucketize(multiplier: number): number {
  for (let i = 0; i < WIN_BUCKETS.length; i++) {
    const b = WIN_BUCKETS[i]!;
    if (multiplier >= b.min && multiplier < b.max) return i;
    if (multiplier === 0 && b.min === 0 && b.max === 0) return i;
  }
  return WIN_BUCKETS.length - 1;
}

/**
 * Mutable counter state — increments anti-replay fields per request.
 *
 * Slot game servers check monotonic counters (`index`, `counter`) for replay
 * attack detection. Sending same request 1000 times → server returns cached
 * 0-win response (or 400). Solution: parse template body, find numeric
 * counter fields, increment from template's value per request.
 *
 * Provider conventions:
 *   - PP (gs2c): `index` (round seq), `counter` (request seq), `repeat` (retry)
 *   - RG: `roundId` (UUID — skip, must regenerate per spin)
 *   - Generic: `n`, `seq`, `tick`
 */
const COUNTER_FIELDS = ["counter", "index", "n", "seq", "tick"] as const;

function buildPostDataWithCounters(
  templateBody: string | null,
  spinIndex: number,
  templateContentType: "querystring" | "json" | "unknown",
): string | null {
  if (!templateBody) return null;
  if (templateContentType === "querystring") {
    const params = new URLSearchParams(templateBody);
    let touched = false;
    for (const field of COUNTER_FIELDS) {
      if (!params.has(field)) continue;
      const base = Number(params.get(field));
      if (!Number.isFinite(base)) continue;
      params.set(field, String(base + spinIndex));
      touched = true;
    }
    return touched ? params.toString() : templateBody;
  }
  if (templateContentType === "json") {
    try {
      const obj = JSON.parse(templateBody) as Record<string, unknown>;
      let touched = false;
      for (const field of COUNTER_FIELDS) {
        if (!(field in obj)) continue;
        const base = Number(obj[field]);
        if (!Number.isFinite(base)) continue;
        obj[field] = base + spinIndex;
        touched = true;
      }
      return touched ? JSON.stringify(obj) : templateBody;
    } catch {
      return templateBody;
    }
  }
  return templateBody;
}

function detectContentType(body: string | null): "querystring" | "json" | "unknown" {
  if (!body) return "unknown";
  const t = body.trim();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (/^[\w._-]+=/.test(t)) return "querystring";
  return "unknown";
}

/**
 * Build doCollect request body from doSpin template — keep auth fields, swap
 * action. Used to fetch follow-up cascade frames for cluster cascade games.
 */
function buildCollectRequest(
  templateBody: string | null,
  contentType: "querystring" | "json" | "unknown",
): string | null {
  if (!templateBody) return null;
  if (contentType === "querystring") {
    const params = new URLSearchParams(templateBody);
    if (params.has("action")) params.set("action", "doCollect");
    else if (params.has("a")) params.set("a", "doCollect");
    return params.toString();
  }
  if (contentType === "json") {
    try {
      const obj = JSON.parse(templateBody) as Record<string, unknown>;
      if ("action" in obj) obj.action = "doCollect";
      else if ("a" in obj) obj.a = "doCollect";
      return JSON.stringify(obj);
    } catch {
      return templateBody;
    }
  }
  return templateBody;
}

/**
 * Fire a doCollect follow-up to continue cascade chain. Returns parsed response
 * or null on error.
 */
async function fireCollect(
  template: SpinTemplate,
  contentType: "querystring" | "json" | "unknown",
  spinIndex: number,
  cascadeIndex: number,
): Promise<{ parsed: Record<string, unknown> | null; rawBody: string }> {
  const collectBody = buildCollectRequest(template.postData, contentType);
  if (!collectBody) return { parsed: null, rawBody: "" };
  // Counter increment: spinIndex shifts by N+cascadeIndex+0.5 to avoid collision
  // with later spin requests in concurrent workers (cascade tier counter)
  const withCounters = buildPostDataWithCounters(
    collectBody,
    spinIndex * 100 + cascadeIndex + 1,
    contentType,
  );
  try {
    const res = await fetch(template.url, {
      method: template.method,
      headers: template.headers,
      body: withCounters ?? "",
    });
    const text = await res.text();
    if (!res.ok) return { parsed: null, rawBody: text };
    const parsed = tryParseBody(text);
    return { parsed, rawBody: text };
  } catch {
    return { parsed: null, rawBody: "" };
  }
}

async function fireOnce(
  template: SpinTemplate,
  spinIndex: number = 0,
  contentType: "querystring" | "json" | "unknown" = "unknown",
  fetchCascadeChain: boolean = false,
): Promise<{
  ok: boolean;
  parsed: Record<string, unknown> | null;
  status: number | null;
  errorMessage: string | null;
  /** Raw response text (caller may persist for debug). */
  rawBody: string;
  /** Sent request body (after counter increment). */
  sentBody: string | null;
  /** Number of cascade frames fetched (0 if no chain). */
  cascadeFrames: number;
  /**
   * All cascade frames including initial spin response. Last element has the
   * final cumulative tw. Used by rule engine to verify per-frame ways wins
   * across cascade chain.
   */
  cascadeFrameData: Array<Record<string, unknown>>;
  /** Server response time in ms (round-trip for initial doSpin only). */
  durationMs: number;
}> {
  const sentBody =
    template.method === "POST" && template.postData != null
      ? buildPostDataWithCounters(template.postData, spinIndex, contentType)
      : null;
  try {
    const init: RequestInit = {
      method: template.method,
      headers: template.headers,
    };
    if (sentBody != null) init.body = sentBody;
    const t0Fire = Date.now();
    const res = await fetch(template.url, init);
    const text = await res.text();
    const fireDurationMs = Date.now() - t0Fire;
    if (!res.ok) {
      return { ok: false, parsed: null, status: res.status, errorMessage: `HTTP ${res.status}: ${text.slice(0, 200)}`, rawBody: text, sentBody, cascadeFrames: 0, cascadeFrameData: [], durationMs: fireDurationMs };
    }
    const parsed = tryParseBody(text);
    if (!parsed) {
      return { ok: false, parsed: null, status: res.status, errorMessage: "Unparseable body", rawBody: text, sentBody, cascadeFrames: 0, cascadeFrameData: [], durationMs: fireDurationMs };
    }
    // Cascade chain follow-up — fetch doCollect until `na` ≠ "c" or rs_more=0
    const cascadeFrameData: Array<Record<string, unknown>> = [parsed];
    let cascadeFrames = 0;
    if (fetchCascadeChain) {
      let cur = parsed;
      const MAX_CASCADES = 50; // safety bound
      while (cascadeFrames < MAX_CASCADES) {
        const na = String(cur.na ?? "");
        const rsMore = Number(cur.rs_more ?? 0);
        const continuing = na === "c" || rsMore > 0;
        if (!continuing) break;
        const next = await fireCollect(template, contentType, spinIndex, cascadeFrames);
        if (!next.parsed) break;
        cascadeFrames++;
        cascadeFrameData.push(next.parsed);
        // Aggregate cumulative tw onto the original parsed (server typically
        // returns the FINAL cumulative tw in last response — overwrite).
        const nextTw = Number(next.parsed.tw ?? NaN);
        if (Number.isFinite(nextTw)) (parsed as Record<string, unknown>).tw = nextTw;
        const nextBalance = Number(next.parsed.balance ?? NaN);
        if (Number.isFinite(nextBalance)) (parsed as Record<string, unknown>).balance = nextBalance;
        // Stamp na from latest frame so caller can see final state
        (parsed as Record<string, unknown>).na = next.parsed.na;
        (parsed as Record<string, unknown>).rs_more = next.parsed.rs_more;
        cur = next.parsed;
      }
    }
    // Normalize per-spin win for stats.
    // Prefer final `tw` (total win for the spin chain). Some providers (PP)
    // report `w` as frame-local and can be 0 while `tw` is positive.
    // Fallback to sum(frame.w) only when `tw` is unavailable.
    let hasFiniteFrameWin = false;
    const chainWin = cascadeFrameData.reduce((acc, frame) => {
      const w = Number((frame as Record<string, unknown>).w ?? NaN);
      if (Number.isFinite(w)) {
        hasFiniteFrameWin = true;
        return acc + w;
      }
      return acc;
    }, 0);
    const finalTw = Number((parsed as Record<string, unknown>).tw ?? NaN);
    if (Number.isFinite(finalTw)) {
      (parsed as Record<string, unknown>).winAmount = finalTw;
    } else if (hasFiniteFrameWin) {
      (parsed as Record<string, unknown>).winAmount = chainWin;
    }
    return { ok: true, parsed, status: res.status, errorMessage: null, rawBody: text, sentBody, cascadeFrames, cascadeFrameData, durationMs: fireDurationMs };
  } catch (err) {
    return { ok: false, parsed: null, status: null, errorMessage: (err as Error).message, rawBody: "", sentBody, cascadeFrames: 0, cascadeFrameData: [], durationMs: 0 };
  }
}

/**
 * Heuristic: response parsed body có chỉ báo free-spin state không?
 * Hỗ trợ multiple encoding patterns:
 *   - RG normalized: `winFreeSpins > 0`, `isFreeSpin === true`
 *   - PP querystring: `gs` field present, `bl > 0`, `na` chứa "fs"
 *   - Generic: `freeSpins > 0`, `fs > 0`, `free_spins > 0`
 */
function detectFreeSpinState(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  const p = parsed as Record<string, unknown>;
  if (p.isFreeSpin === true) return true;
  for (const k of ["winFreeSpins", "freeSpins", "fs", "free_spins"]) {
    const v = Number(p[k] ?? 0);
    if (Number.isFinite(v) && v > 0) return true;
  }
  // PP-specific: `gs` (game state) field present hoặc `bl > 0` (bonus level)
  if (typeof p.gs === "string" && p.gs.length > 0) return true;
  const bl = Number(p.bl ?? 0);
  if (Number.isFinite(bl) && bl > 0) return true;
  // `na` (next action) là "fs" / "fsstart" / similar
  const na = String(p.na ?? "");
  if (/^fs/i.test(na)) return true;
  return false;
}

/**
 * Discover free-spin chain bằng sequential spin sau khi main concurrent sim
 * detect được FS trigger. Concurrent dispatch không reliable cho FS chain
 * vì server state phụ thuộc session/order.
 *
 * Algorithm:
 *   1. Fire spin sequentially (concurrency=1).
 *   2. Wait until response có FS state (detectFreeSpinState=true) → FS trigger.
 *   3. Capture trigger + subsequent responses cho đến khi FS state ends.
 *   4. Return chain. Nếu maxSpins reached không trigger → null.
 */
async function discoverFreeSpinChain(
  template: SpinTemplate,
  contentType: "querystring" | "json" | "unknown",
  maxSpins: number,
  startSpinIndex: number,
): Promise<SpinResponseFixture[] | null> {
  const chain: SpinResponseFixture[] = [];
  let inChain = false;
  const HEADERS = { "content-type": "text/plain; charset=ISO-8859-1" };
  for (let i = 0; i < maxSpins; i++) {
    const r = await fireOnce(template, startSpinIndex + i, contentType, false);
    if (!r.ok || !r.parsed) {
      if (inChain) {
        console.warn(`[fs-discover] Request failed mid-chain (after ${chain.length} frames) — stopping`);
        break;
      }
      continue;
    }
    const isFs = detectFreeSpinState(r.parsed);
    if (!inChain) {
      if (isFs) {
        chain.push({
          url: template.url,
          url_pattern: SPIN_PATTERN.source,
          method: template.method,
          status: r.status ?? 200,
          headers: HEADERS,
          body: r.rawBody,
          parsed: r.parsed,
        });
        inChain = true;
        console.log(`[fs-discover] ✓ FS trigger captured at sequential spin #${i} — following chain...`);
      }
    } else {
      // Already in chain — keep capturing
      chain.push({
        url: template.url,
        url_pattern: SPIN_PATTERN.source,
        method: template.method,
        status: r.status ?? 200,
        headers: HEADERS,
        body: r.rawBody,
        parsed: r.parsed,
      });
      if (!isFs) {
        // FS state ended → chain complete (this last frame is the "exit" response)
        console.log(`[fs-discover] ✓ FS chain complete — ${chain.length} frames captured`);
        return chain;
      }
      if (chain.length >= 50) {
        console.warn(`[fs-discover] Chain hit 50 frames without ending — saving partial`);
        return chain;
      }
    }
  }
  return inChain ? chain : null;
}

export async function simulate(opts: SimulateOpts): Promise<SimulateResult> {
  // Source resolution order (Phase legacy-cleanup):
  //   1. Legacy `fixtures/recordings/<slug>__<ts>/http.jsonl` — for games
  //      that were recorded via the old `npm run record` flow.
  //   2. Pipeline `fixtures/registry/<slug>/network/network.jsonl` — for
  //      games that were captured via the new pipeline (step3 capture-network).
  // The pipeline capture is flattened into the legacy HttpEntry shape by
  // adaptPipelineCaptureToEntries so the rest of simulate() stays unchanged.
  let entries: HttpEntry[] = [];
  let sourceLabel = "";
  const recording = latestRecording(opts.slug);
  if (recording) {
    entries = readEntries(recording);
    sourceLabel = recording;
  } else {
    const { adaptPipelineCaptureToEntries, pipelineCapturePath } =
      await import("./pipeline-network-source.js");
    entries = adaptPipelineCaptureToEntries(opts.slug);
    sourceLabel = pipelineCapturePath(opts.slug) ?? "";
  }
  if (entries.length === 0) {
    throw new Error(
      `No spin capture found for slug "${opts.slug}". Looked in:\n` +
      `  - ${RECORDINGS_DIR}/${opts.slug}__* (legacy)\n` +
      `  - fixtures/registry/${opts.slug}/network/network.jsonl (pipeline)\n` +
      `Run a pipeline capture-network step or re-run the manual session to populate.`,
    );
  }
  console.log(`[simulate] Using template from: ${sourceLabel} (${entries.length} entries)`);

  const template = findSpinTemplate(entries);
  if (!template) {
    throw new Error(`Could not find spin request template in ${sourceLabel}`);
  }
  const contentType = detectContentType(template.postData);
  // Identify counter fields present in template (for log + diagnostic)
  let counterDiag = "(no counters detected)";
  if (template.postData) {
    const present: string[] = [];
    if (contentType === "querystring") {
      const params = new URLSearchParams(template.postData);
      for (const f of COUNTER_FIELDS) if (params.has(f)) present.push(`${f}=${params.get(f)}`);
    } else if (contentType === "json") {
      try {
        const obj = JSON.parse(template.postData);
        for (const f of COUNTER_FIELDS) if (f in obj) present.push(`${f}=${obj[f]}`);
      } catch {}
    }
    if (present.length > 0) counterDiag = `incrementing: ${present.join(", ")}`;
  }
  console.log(`[simulate] Template: ${template.method} ${template.url}`);
  console.log(`[simulate] Headers: ${Object.keys(template.headers).length}, postData=${template.postData ? template.postData.length + " bytes" : "(none)"}, content-type=${contentType}`);
  console.log(`[simulate] Anti-replay counter fields: ${counterDiag}`);

  // Preflight: bắn 1 request thử để fail fast nếu token expired.
  if (opts.preflightTokenCheck !== false) {
    console.log(`[simulate] Preflight token check...`);
    // Use spinIndex=0 — preflight should match recording's original counter values
    // Don't fetch cascade chain in preflight — keep it cheap (1 request)
    const probe = await fireOnce(template, 0, contentType, false);
    if (probe.status === 401 || probe.status === 403) {
      throw new TokenExpiredError(
        `Preflight failed with HTTP ${probe.status} — token in recorded URL likely expired.\n` +
          `  Recording: ${recording}\n` +
          `  Fix: re-record with fresh session:\n` +
          `    GAME_URL="<fresh URL>" npm run auto    # AI auto-plays, captures fresh /spin\n` +
          `    npm run extract-scenarios -- ${opts.slug}\n` +
          `    npm run stats -- ${opts.slug} --spins ${opts.spins}\n` +
          `  Most providers expire tokens after 24-48h.`,
        probe.status,
      );
    }
    if (!probe.ok) {
      console.warn(
        `[simulate] WARNING: preflight returned ${probe.status} (${probe.errorMessage?.slice(0, 100)}). Continuing — may indicate server issue rather than token.`,
      );
    } else {
      console.log(`[simulate] ✔ Preflight OK (status ${probe.status})`);
    }
  }

  let concurrency = opts.concurrency ?? 4;
  const throttle = opts.throttleMs ?? 10;
  const progressEvery = opts.progressEvery ?? 100;
  const startedAt = Date.now();

  let totalBet = 0;
  let totalWin = 0;
  let successful = 0;
  let failed = 0;
  let maxWin = 0;
  let maxWinMultiplier: number | null = null;
  const bucketCounts = WIN_BUCKETS.map(() => 0);
  const errorAgg = new Map<string, { status: number | null; count: number }>();
  let hits = 0;
  // Consistency check (chỉ tracked khi opts.spec set)
  const consistencyEnabled = Boolean(opts.spec);
  const maxExamples = opts.maxMismatchExamples ?? 20;
  let consistencySpinsChecked = 0;
  let consistencyMismatches = 0;
  let consistencyInconclusive = 0;
  const mismatchExamples: PayoutMismatchExample[] = [];
  // Scenario discovery state — save rare labels (bonus_trigger, free_spin, big_win, max_win)
  const extractScenariosOn = Boolean(opts.extractScenarios);
  const overwriteOk = Boolean(opts.overwriteScenarios);
  const savedScenarios: Array<{ label: string; path: string; spinIndex: number }> = [];
  const seenLabelsSkipped = new Set<string>();
  // Always-interesting labels — rare in random play, valuable for deterministic mock
  const INTERESTING_LABELS = new Set<ScenarioLabel>([
    "bonus_trigger",
    "free_spin",
    "big_win",
    "max_win",
  ]);
  const { existsSync: existsSyncForScenario } = await import("node:fs");

  // Debug dump state
  const dumpLimit = opts.dumpResponses ?? 0;
  const { mkdirSync: mkdirSyncForDump, writeFileSync: writeFileSyncForDump } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpDir = dumpLimit > 0
    ? join("fixtures", "statistical", `${opts.slug}-${stamp}-debug`)
    : "";
  if (dumpLimit > 0) {
    mkdirSyncForDump(dumpDir, { recursive: true });
    console.log(`[simulate] Debug dump ON — first ${dumpLimit} responses → ${dumpDir}/`);
  }
  const dumpHashes: string[] = [];
  // Performance metrics — per-spin response time
  const perfThresholdMs = opts.maxResponseMs ?? 500;
  const responseTimes: number[] = [];
  let slowSpins = 0;
  // History audit — collect spin records to cross-check vs history endpoint later
  type SimSpinRecord = {
    spinIndex: number;
    roundId: string | null;
    bet: number;
    win: number;
    balance: number;
  };
  const simSpinRecords: SimSpinRecord[] = [];
  // Symbol palette + winlines audit counters
  let symbolMismatches = 0;
  const unknownSymbolsSeen = new Set<string>();
  let winlinesInvalid = 0;
  // Welford running variance over win/bet ratio
  let welfordN = 0;
  let welfordMean = 0;
  let welfordM2 = 0;
  // Feature counters
  let freeSpinTriggers = 0;
  let bonusTriggers = 0;
  let freeSpinRuns = 0;
  let retriggers = 0;
  let prevFreeSpinsRemaining = 0;
  // Symbol distribution
  const symbolCounts = new Map<string, number>();

  let dispatched = 0;

  // Cascade chain mode: enabled when spec marks game as cascade. Each spin
  // fires N+1 requests (1 doSpin + N doCollect until chain stops).
  const fetchCascade = Boolean(opts.spec?.cascade);
  if (fetchCascade) {
    console.log(`[simulate] Cascade chain mode ON (spec.cascade=true) — each spin fetches full cascade tier chain via doCollect`);
    if (concurrency !== 1) {
      console.log(`[simulate] forcing concurrency=1 for cascade game to preserve session order`);
      concurrency = 1;
    }
  }
  let totalCascadeFrames = 0;
  const canInferWinFromBalance = concurrency === 1;
  let lastEndingBalanceForRtp: number | null = null;

  const worker = async () => {
    while (true) {
      const idx = dispatched++;
      if (idx >= opts.spins) return;
      // idx+1 → first request uses template's counter + 1 (preflight already used +0)
      const r = await fireOnce(template, idx + 1, contentType, fetchCascade);
      if (r.cascadeFrames > 0) totalCascadeFrames += r.cascadeFrames;
      if (r.durationMs > 0) {
        responseTimes.push(r.durationMs);
        if (r.durationMs > perfThresholdMs) slowSpins++;
      }
      // Debug dump (first N responses regardless of success)
      if (dumpLimit > 0 && idx < dumpLimit) {
        const idxStr = String(idx).padStart(3, "0");
        const hash = createHash("sha1").update(r.rawBody).digest("hex").slice(0, 12);
        dumpHashes.push(hash);
        try {
          writeFileSyncForDump(
            join(dumpDir, `spin-${idxStr}-request.txt`),
            r.sentBody ?? "(no body)",
          );
          writeFileSyncForDump(
            join(dumpDir, `spin-${idxStr}-response-${r.status ?? "err"}-${hash}.txt`),
            r.rawBody || `(error: ${r.errorMessage ?? "unknown"})`,
          );
          // Sidecar: final parsed state after cascade-tail collection. For
          // cascade games the initial response body shows pre-tail values
          // (balance/tw); `r.parsed` is mutated to cumulative final state at
          // end of fireOnce(). Pipeline reads this for accurate per-spin
          // balance equation.
          if (r.parsed) {
            writeFileSyncForDump(
              join(dumpDir, `spin-${idxStr}-final.json`),
              JSON.stringify(r.parsed),
            );
          }
        } catch (err) {
          console.warn(`[simulate] dump failed for spin ${idx}:`, (err as Error).message);
        }
      }
      if (!r.ok) {
        failed++;
        const key = `${r.status}:${r.errorMessage ?? "(unknown)"}`;
        const e = errorAgg.get(key) ?? { status: r.status, count: 0 };
        e.count++;
        errorAgg.set(key, e);
      } else if (r.parsed) {
        successful++;
        // Bet field discovery, in priority order:
        //   1. Explicit total-bet field (RG: betAmount; misc: bet/stake/totalBet)
        //   2. PP-style: c × l  (coin per line × number of lines)  — common cluster/ways
        //   3. Fallback: c alone (rare)
        const explicitBet =
          numOrZero(r.parsed.betAmount) ||
          numOrZero((r.parsed as any).totalBet) ||
          numOrZero((r.parsed as any).stake) ||
          numOrZero(r.parsed.bet);
        const coin = numOrZero((r.parsed as any).c);
        const lines = numOrZero((r.parsed as any).l);
        const bet =
          explicitBet > 0
            ? explicitBet
            : coin > 0 && lines > 0
              ? coin * lines
              : coin;
        let win =
          firstFinite([
            r.parsed.winAmount,
            (r.parsed as any).tw,
            r.parsed.win,
          ]) ?? 0;
        const endingBalance =
          firstFinite([
            (r.parsed as any).balance,
            (r.parsed as any).balance_cash,
            (r.parsed as any).endingBalance,
            (r.parsed as any).updatedBalance,
          ]) ?? null;
        // In sequential mode, balance delta is the most robust source of truth
        // across provider-specific win fields (`tw`, `w`, `winAmount`).
        if (canInferWinFromBalance && endingBalance != null) {
          if (lastEndingBalanceForRtp != null) {
            const inferredWin = endingBalance - lastEndingBalanceForRtp + bet;
            if (Number.isFinite(inferredWin) && inferredWin >= -0.02) {
              win = Math.max(0, inferredWin);
            }
          }
          lastEndingBalanceForRtp = endingBalance;
        }
        totalBet += bet;
        totalWin += win;
        if (win > 0) hits++;
        if (win > maxWin) {
          maxWin = win;
          maxWinMultiplier = bet > 0 ? win / bet : null;
        }
        // Track for history audit (if enabled)
        if (opts.historyAudit) {
          const balance =
            numOrZero((r.parsed as any).balance) ||
            numOrZero((r.parsed as any).balance_cash) ||
            numOrZero((r.parsed as any).endingBalance) ||
            numOrZero((r.parsed as any).updatedBalance);
          const roundId = (() => {
            const v = (r.parsed as any).id ?? (r.parsed as any).round ?? (r.parsed as any).roundId;
            return v != null ? String(v) : null;
          })();
          simSpinRecords.push({ spinIndex: idx, roundId, bet, win, balance });
        }
        if (bet > 0) {
          const ratio = win / bet;
          bucketCounts[bucketize(ratio)]!++;
          // Welford incremental variance
          welfordN++;
          const delta = ratio - welfordMean;
          welfordMean += delta / welfordN;
          welfordM2 += delta * (ratio - welfordMean);
        }
        // Feature counters
        const winFreeSpins = numOrZero((r.parsed as any).winFreeSpins);
        const isFreeSpin =
          (r.parsed as any).isFreeSpin === true ||
          (r.parsed as any).isFreeSpin === "true";
        const fsRemaining =
          numOrZero((r.parsed as any).fs) ||
          numOrZero((r.parsed as any).freeSpinsRemaining);
        if (winFreeSpins > 0) freeSpinTriggers++;
        if (
          (r.parsed as any).bonus === true ||
          (r.parsed as any).hasBonus === true ||
          numOrZero((r.parsed as any).bonusWin) > 0
        ) {
          bonusTriggers++;
        }
        if (isFreeSpin) freeSpinRuns++;
        if (isFreeSpin && fsRemaining > prevFreeSpinsRemaining && prevFreeSpinsRemaining > 0) {
          retriggers++;
        }
        prevFreeSpinsRemaining = fsRemaining;
        // Symbol distribution from `s` field (column-major PP/RG format)
        const symbolsStr = (r.parsed as any).s;
        if (typeof symbolsStr === "string" && symbolsStr.length > 0 && symbolsStr.length < 200) {
          for (const ch of symbolsStr) {
            symbolCounts.set(ch, (symbolCounts.get(ch) ?? 0) + 1);
          }
        }
        // Symbol palette + winlines audit (cheap, always run when spec available)
        if (opts.spec) {
          try {
            const palette = auditSymbolPalette(r.parsed, opts.spec);
            if (!palette.ok) {
              symbolMismatches++;
              for (const sym of palette.unknownSymbols) unknownSymbolsSeen.add(sym);
            }
            const wl = auditWinlines(r.parsed);
            if (!wl.ok) winlinesInvalid++;
          } catch {}
        }
        // Consistency check (server bug detection)
        if (consistencyEnabled && opts.spec) {
          consistencySpinsChecked++;
          try {
            // Cascade-aware path: pass full chain when cascade=true and we
            // have ≥2 frames. Otherwise single-frame path.
            const check =
              opts.spec.cascade === true && r.cascadeFrameData.length > 0
                ? assertPayoutMatchesPaytableCascade(r.cascadeFrameData, opts.spec)
                : assertPayoutMatchesPaytable(r.parsed, opts.spec);
            if (check.ok === false) {
              consistencyMismatches++;
              if (mismatchExamples.length < maxExamples) {
                mismatchExamples.push({
                  spinIndex: idx,
                  expected: check.expected,
                  actual: check.actual,
                  delta: check.delta,
                  reels: typeof symbolsStr === "string" ? symbolsStr : "",
                  detail: check.detail.slice(0, 300),
                });
              }
            } else if (check.ok === "inconclusive") {
              consistencyInconclusive++;
            }
          } catch {
            // Rule engine threw (vd decode fail) → count as inconclusive
            consistencyInconclusive++;
          }
        }
        // Discovery — auto-save rare scenarios for deterministic mocking later
        if (extractScenariosOn) {
          const label = classifyScenario(r.parsed);
          if (INTERESTING_LABELS.has(label)) {
            const scPath = scenarioPath(opts.slug, label);
            const fileExists = existsSyncForScenario(scPath);
            if (!fileExists || overwriteOk) {
              // Avoid saving multiple of same label this run (keep first instance)
              if (!savedScenarios.find((s) => s.label === label)) {
                try {
                  const fixture: SpinResponseFixture = {
                    url: template.url,
                    url_pattern: SPIN_PATTERN.source,
                    method: template.method,
                    status: 200,
                    headers: { "content-type": "text/plain; charset=ISO-8859-1" },
                    body: r.rawBody,
                    parsed: r.parsed,
                  };
                  const sc: Scenario = {
                    slug: opts.slug,
                    label,
                    description: `Auto-extracted from stats sim spin #${idx} on ${new Date().toISOString()}`,
                    source_recording: `simulate(${opts.spins} spins, idx=${idx})`,
                    spin_response: fixture,
                    expected: {
                      bet: (() => {
                        const explicit =
                          Number((r.parsed as any).betAmount ?? (r.parsed as any).bet ?? NaN);
                        if (Number.isFinite(explicit) && explicit > 0) return explicit;
                        const cv = Number((r.parsed as any).c ?? NaN);
                        const lv = Number((r.parsed as any).l ?? NaN);
                        return Number.isFinite(cv) && Number.isFinite(lv) && cv > 0 && lv > 0
                          ? cv * lv
                          : cv;
                      })(),
                      win:
                        Number((r.parsed as any).winAmount ?? (r.parsed as any).tw ?? 0) || 0,
                      ending_balance:
                        Number((r.parsed as any).balance ?? (r.parsed as any).endingBalance ?? 0) || 0,
                      has_bonus:
                        Number((r.parsed as any).winFreeSpins ?? 0) > 0 ||
                        (r.parsed as any).isFreeSpin === true,
                      is_free_spin: (r.parsed as any).isFreeSpin === true,
                    },
                    frozen_time_ms: 1_735_689_600_000,
                    random_seed: 42,
                  };
                  saveScenario(sc);
                  savedScenarios.push({ label, path: scPath, spinIndex: idx });
                  console.log(
                    `[simulate] ★ Discovered scenario "${label}" at spin #${idx} → ${scPath}`,
                  );
                } catch (err) {
                  console.warn(`[simulate] failed to save scenario ${label}:`, (err as Error).message);
                }
              }
            } else {
              seenLabelsSkipped.add(label);
            }
          }
        }
      }
      if ((successful + failed) % progressEvery === 0) {
        const rtp = totalBet > 0 ? totalWin / totalBet : 0;
        console.log(
          `[simulate] ${successful + failed}/${opts.spins}  RTP=${(rtp * 100).toFixed(2)}%  hits=${hits}  fail=${failed}`,
        );
      }
      if (throttle > 0) {
        await new Promise((r) => setTimeout(r, throttle));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // ===== Free-spin chain discovery (sequential post-pass) =====
  // Khi extractScenarios=true và main sim phát hiện FS trigger (đã save scenario
  // "bonus_trigger" hoặc "free_spin"), chạy thêm 1 pass sequential để capture
  // full FS chain (trigger + N FS frame). Concurrent dispatch không reliable
  // cho FS state (server session-dependent).
  if (extractScenariosOn) {
    const chainPath = scenarioPath(opts.slug, "free_spin_chain");
    const chainExists = existsSyncForScenario(chainPath);
    const hadAnyFsHint = savedScenarios.some(
      (s) => s.label === "bonus_trigger" || s.label === "free_spin",
    );
    if (!chainExists || overwriteOk) {
      // Discover chain ngay cả khi main sim chưa thấy FS (demo server có thể
      // có FS rate thấp + concurrent dispatch race condition).
      const budget = hadAnyFsHint ? 50 : Math.min(opts.spins, 300);
      console.log(
        `[simulate] Discovering FS chain (sequential, max ${budget} spins, ${hadAnyFsHint ? "FS hint from main pass" : "blind search"})...`,
      );
      try {
        const chain = await discoverFreeSpinChain(template, contentType, budget, opts.spins);
        if (chain && chain.length >= 1) {
          // Compute aggregate expected từ chain
          const firstParsed = chain[0]!.parsed ?? {};
          const lastParsed = chain[chain.length - 1]!.parsed ?? {};
          const triggerBet = (() => {
            const explicit = Number((firstParsed as any).betAmount ?? (firstParsed as any).bet ?? NaN);
            if (Number.isFinite(explicit) && explicit > 0) return explicit;
            const c = Number((firstParsed as any).c ?? NaN);
            const l = Number((firstParsed as any).l ?? NaN);
            return Number.isFinite(c) && Number.isFinite(l) && c > 0 && l > 0 ? c * l : c || 0;
          })();
          const totalWin = chain.reduce((sum, frame) => {
            const w = Number(
              (frame.parsed as any)?.winAmount ??
                (frame.parsed as any)?.tw ??
                (frame.parsed as any)?.w ??
                0,
            );
            return sum + (Number.isFinite(w) ? w : 0);
          }, 0);
          const sc: Scenario = {
            slug: opts.slug,
            label: "free_spin",
            description: `FS chain (${chain.length} frame${chain.length === 1 ? "" : "s"}) captured via sequential post-pass on ${new Date().toISOString()}`,
            source_recording: `simulate(post-pass, ${chain.length} frames)`,
            spin_response: chain[0]!,
            spin_sequence: chain,
            expected: {
              bet: triggerBet,
              win: totalWin,
              ending_balance:
                Number(
                  (lastParsed as any).balance ??
                    (lastParsed as any).endingBalance ??
                    0,
                ) || 0,
              has_bonus: true,
              is_free_spin: true,
            },
            frozen_time_ms: 1_735_689_600_000,
            random_seed: 42,
          };
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(chainPath), { recursive: true });
          writeFileSync(chainPath, JSON.stringify(sc, null, 2));
          console.log(
            `[simulate] ★ FS chain saved (${chain.length} frame${chain.length === 1 ? "" : "s"}, totalWin=${totalWin.toFixed(2)}) → ${chainPath}`,
          );
          savedScenarios.push({ label: "free_spin_chain", path: chainPath, spinIndex: opts.spins });
        } else {
          console.log(
            `[simulate] FS chain discovery: no trigger after ${budget} sequential spins — demo server có thể không có FS trong RNG hiện tại`,
          );
        }
      } catch (err) {
        console.warn(`[simulate] FS chain discovery failed (non-fatal): ${(err as Error).message}`);
      }
    } else {
      console.log(`[simulate] FS chain already exists at ${chainPath} (skipping — use --overwrite-scenarios to refresh)`);
    }
  }

  // ===== History audit (after sim completes) =====
  type HistoryAuditOut = SimulateResult["historyAudit"];
  let historyAuditResult: HistoryAuditOut = null;
  if (opts.historyAudit) {
    const allEntries = readEntries(recording);
    const histTemplate = findHistoryTemplate(allEntries);
    if (!histTemplate) {
      historyAuditResult = {
        enabled: true,
        fetched: false,
        reason:
          "History audit skipped: no history REQUEST captured in recording (action=doHistory or /history API call). Note: /history string in bootstrap HTML/config is not an API call.",
        rowsReturned: 0,
        matched: 0,
        missing: simSpinRecords.length,
        fieldMismatches: 0,
        examples: [],
      };
    } else {
      console.log(`[simulate] History audit — fetching ${histTemplate.method} ${histTemplate.url}`);
      try {
        const init: RequestInit = {
          method: histTemplate.method,
          headers: histTemplate.headers,
        };
        if (histTemplate.method === "POST" && histTemplate.postData != null) {
          init.body = histTemplate.postData;
        }
        const res = await fetch(histTemplate.url, init);
        const text = await res.text();
        if (!res.ok) {
          historyAuditResult = {
            enabled: true,
            fetched: false,
            reason: `HTTP ${res.status}: ${text.slice(0, 200)}`,
            rowsReturned: 0,
            matched: 0,
            missing: simSpinRecords.length,
            fieldMismatches: 0,
            examples: [],
          };
        } else {
          // Parse history rows — try multiple shapes
          const rows = parseHistoryRows(text);
          let matched = 0;
          let fieldMismatches = 0;
          const examples: Array<{ field: string; expected: number; actual: number; spinIndex: number }> = [];
          const TOL = 0.01;

          // `last-items` endpoints usually return only a capped tail window
          // (e.g. 100/200 rows), so audit only the comparable tail from this run.
          const comparable = Math.min(simSpinRecords.length, rows.length);
          const simWindow = simSpinRecords.slice(simSpinRecords.length - comparable);

          const byRoundId = new Map<string, typeof rows[0]>();
          for (const r of rows) if (r.roundId) byRoundId.set(r.roundId, r);

          // Fallback matcher for providers where spin response lacks roundId
          // (PP gs2c). Use ending balance as primary key within auditable tail.
          const byBalance = new Map<string, Array<typeof simWindow[number]>>();
          for (const s of simWindow) {
            if (!(s.balance > 0)) continue;
            const key = s.balance.toFixed(2);
            const arr = byBalance.get(key) ?? [];
            arr.push(s);
            byBalance.set(key, arr);
          }

          for (const histRow of rows) {
            let sim: (typeof simWindow)[number] | undefined;
            if (histRow.roundId) {
              const candidate = byRoundId.get(histRow.roundId);
              if (candidate) {
                // Resolve back to sim row for field compare via roundId.
                sim = simWindow.find((s) => s.roundId === histRow.roundId);
              }
            }
            if (!sim && histRow.balance > 0) {
              const key = histRow.balance.toFixed(2);
              const pool = byBalance.get(key);
              if (pool && pool.length > 0) {
                sim = pool.shift();
              }
            }
            if (!sim) continue;
            matched++;
            if (Math.abs(histRow.bet - sim.bet) > TOL) {
              fieldMismatches++;
              if (examples.length < 10) examples.push({ field: "bet", expected: sim.bet, actual: histRow.bet, spinIndex: sim.spinIndex });
            }
            if (Math.abs(histRow.win - sim.win) > TOL) {
              fieldMismatches++;
              if (examples.length < 10) examples.push({ field: "win", expected: sim.win, actual: histRow.win, spinIndex: sim.spinIndex });
            }
            if (sim.balance > 0 && histRow.balance > 0 && Math.abs(histRow.balance - sim.balance) > TOL) {
              fieldMismatches++;
              if (examples.length < 10) examples.push({ field: "balance", expected: sim.balance, actual: histRow.balance, spinIndex: sim.spinIndex });
            }
          }
          historyAuditResult = {
            enabled: true,
            fetched: true,
            reason: null,
            rowsReturned: rows.length,
            matched,
            missing: comparable - matched,
            fieldMismatches,
            examples,
          };
        }
      } catch (err) {
        historyAuditResult = {
          enabled: true,
          fetched: false,
          reason: (err as Error).message,
          rowsReturned: 0,
          matched: 0,
          missing: simSpinRecords.length,
          fieldMismatches: 0,
          examples: [],
        };
      }
    }
  }

  const totalSpins = successful + failed;
  const variance = welfordN > 1 ? welfordM2 / (welfordN - 1) : null;
  const volatility = variance != null ? Math.sqrt(variance) : null;
  // Industry rough bands on std-dev of win/bet ratio
  const volatilityBand: SimulateResult["volatilityBand"] =
    volatility == null
      ? null
      : volatility < 2
        ? "low"
        : volatility < 5
          ? "medium"
          : volatility < 10
            ? "high"
            : "very_high";
  // 95% CI for RTP estimate: 1.96 × σ / √N  (where σ is volatility of win/bet)
  const rtpConfidence95 =
    volatility != null && welfordN > 0
      ? (1.96 * volatility) / Math.sqrt(welfordN)
      : null;
  const winningSpins = hits;
  const averageWin = winningSpins > 0 ? totalWin / winningSpins : null;
  const symbolDistribution: Record<string, number> = {};
  for (const [k, v] of [...symbolCounts.entries()].sort((a, b) => b[1] - a[1])) {
    symbolDistribution[k] = v;
  }

  const result: SimulateResult = {
    slug: opts.slug,
    spinsRequested: opts.spins,
    spinsSuccessful: successful,
    spinsFailed: failed,
    totalBet,
    totalWin,
    observedRTP: totalBet > 0 ? totalWin / totalBet : null,
    hitFrequency: totalSpins > 0 ? hits / totalSpins : null,
    maxWin,
    maxWinMultiplier,
    averageWin,
    volatility,
    volatilityBand,
    rtpConfidence95,
    featureFrequency: {
      freeSpinTrigger: successful > 0 ? freeSpinTriggers / successful : null,
      bonusTrigger: successful > 0 ? bonusTriggers / successful : null,
      freeSpinRuns: successful > 0 ? freeSpinRuns / successful : null,
      retrigger: successful > 0 ? retriggers / successful : null,
    },
    symbolDistribution,
    winDistribution: {
      buckets: WIN_BUCKETS.map((b, i) => ({
        min: b.min,
        max: b.max === Infinity ? Number.POSITIVE_INFINITY : b.max,
        count: bucketCounts[i]!,
        pctOfSpins: totalSpins > 0 ? bucketCounts[i]! / totalSpins : 0,
      })),
    },
    consistency: consistencyEnabled
      ? {
          spinsChecked: consistencySpinsChecked,
          payoutMismatches: consistencyMismatches,
          inconclusive: consistencyInconclusive,
          mismatchRate:
            consistencySpinsChecked > 0
              ? consistencyMismatches / consistencySpinsChecked
              : null,
          examples: mismatchExamples,
        }
      : null,
    debugDump: dumpLimit > 0
      ? {
          dir: dumpDir,
          fileCount: dumpHashes.length * 2, // request + response per spin
          uniqueHashes: new Set(dumpHashes).size,
          hashes: dumpHashes,
        }
      : null,
    cascadeStats: fetchCascade
      ? {
          enabled: true,
          totalFrames: totalCascadeFrames,
          avgFramesPerSpin: successful > 0 ? totalCascadeFrames / successful : 0,
        }
      : null,
    audits: opts.spec
      ? {
          symbolMismatches,
          unknownSymbolsSeen: [...unknownSymbolsSeen],
          winlinesInvalid,
        }
      : null,
    historyAudit: historyAuditResult,
    performance: (() => {
      if (responseTimes.length === 0) return null;
      const sorted = [...responseTimes].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        minMs: sorted[0] ?? 0,
        maxMs: sorted[sorted.length - 1] ?? 0,
        meanMs: Math.round(sum / sorted.length),
        medianMs: pct(0.5),
        p95Ms: pct(0.95),
        p99Ms: pct(0.99),
        thresholdMs: perfThresholdMs,
        slowSpins,
        slowRate: sorted.length > 0 ? slowSpins / sorted.length : 0,
      };
    })(),
    extractedScenarios: extractScenariosOn
      ? {
          enabled: true,
          saved: savedScenarios,
          seenButSkipped: [...seenLabelsSkipped],
        }
      : null,
    durationMs: Date.now() - startedAt,
    errors: [...errorAgg.entries()].map(([msg, v]) => ({
      status: v.status,
      message: msg,
      count: v.count,
    })),
  };

  return result;
}

function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function firstFinite(values: unknown[]): number | null {
  for (const v of values) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function formatReport(r: SimulateResult): string {
  const lines: string[] = [];
  lines.push(`=== Statistical simulation report — ${r.slug} ===`);
  lines.push(`Spins: ${r.spinsSuccessful}/${r.spinsRequested} successful  (${r.spinsFailed} failed)`);
  lines.push(`Duration: ${(r.durationMs / 1000).toFixed(1)}s  (${(r.spinsSuccessful / (r.durationMs / 1000)).toFixed(1)} spins/s)`);
  lines.push(``);
  lines.push(`Total bet: ${r.totalBet.toFixed(2)}`);
  lines.push(`Total win: ${r.totalWin.toFixed(2)}`);
  lines.push(
    `Observed RTP: ${
      r.observedRTP != null ? (r.observedRTP * 100).toFixed(2) + "%" : "(no data)"
    }${r.rtpConfidence95 != null ? `  (±${(r.rtpConfidence95 * 100).toFixed(2)}% @ 95% CI)` : ""}`,
  );
  lines.push(`Hit frequency: ${r.hitFrequency != null ? (r.hitFrequency * 100).toFixed(2) + "%" : "(no data)"}`);
  lines.push(`Average win (winning spins): ${r.averageWin != null ? r.averageWin.toFixed(2) : "(no data)"}`);
  lines.push(`Max win: ${r.maxWin}  (${r.maxWinMultiplier != null ? r.maxWinMultiplier.toFixed(1) + "x bet" : "n/a"})`);
  lines.push(
    `Volatility (std-dev of win/bet): ${
      r.volatility != null ? r.volatility.toFixed(2) : "(no data)"
    }${r.volatilityBand ? `  [${r.volatilityBand}]` : ""}`,
  );
  lines.push(``);
  lines.push(`Feature frequency:`);
  const ff = r.featureFrequency;
  const pct = (v: number | null) => (v != null ? (v * 100).toFixed(3) + "%" : "(n/a)");
  lines.push(`  Free spin trigger : ${pct(ff.freeSpinTrigger)}`);
  lines.push(`  Bonus trigger     : ${pct(ff.bonusTrigger)}`);
  lines.push(`  Free spin runs    : ${pct(ff.freeSpinRuns)}`);
  lines.push(`  Retrigger         : ${pct(ff.retrigger)}`);
  if (Object.keys(r.symbolDistribution).length > 0) {
    lines.push(``);
    lines.push(`Symbol distribution (top 12):`);
    const top = Object.entries(r.symbolDistribution).slice(0, 12);
    const total = top.reduce((s, [, c]) => s + c, 0);
    for (const [sym, count] of top) {
      lines.push(`  ${sym.padEnd(4)}  ${String(count).padStart(8)}  (${total > 0 ? ((count / total) * 100).toFixed(2) : "0.00"}%)`);
    }
  }
  if (r.extractedScenarios?.enabled) {
    lines.push(``);
    lines.push(`Scenario discovery (--extract-scenarios):`);
    if (r.extractedScenarios.saved.length > 0) {
      lines.push(`  ★ Saved ${r.extractedScenarios.saved.length} new scenario(s):`);
      for (const s of r.extractedScenarios.saved) {
        lines.push(`    - ${s.label.padEnd(15)} (from spin #${s.spinIndex}) → ${s.path}`);
      }
    } else {
      lines.push(`  No new scenarios discovered.`);
    }
    if (r.extractedScenarios.seenButSkipped.length > 0) {
      lines.push(`  Already exist (skipped, use --overwrite-scenarios to refresh):`);
      for (const l of r.extractedScenarios.seenButSkipped) {
        lines.push(`    - ${l}`);
      }
    }
  }
  if (r.historyAudit?.enabled) {
    lines.push(``);
    const h = r.historyAudit;
    const tag = !h.fetched
      ? `⚠️ skipped: ${h.reason}`
      : h.fieldMismatches === 0 && h.missing === 0
        ? "✓ all match"
        : "❌ FAIL";
    lines.push(`History audit ${tag}:`);
    if (h.fetched) {
      lines.push(`  Rows returned        : ${h.rowsReturned}`);
      lines.push(`  Matched (by round_id) : ${h.matched}`);
      lines.push(`  Missing from history  : ${h.missing}`);
      lines.push(`  Field mismatches      : ${h.fieldMismatches}`);
      if (h.examples.length > 0) {
        lines.push(`  Examples (first ${Math.min(3, h.examples.length)}):`);
        for (const ex of h.examples.slice(0, 3)) {
          lines.push(`    spin#${ex.spinIndex} ${ex.field}: expected=${ex.expected.toFixed(4)} actual=${ex.actual.toFixed(4)}`);
        }
      }
    }
  }
  if (r.audits) {
    lines.push(``);
    const audit = r.audits;
    const symOk = audit.symbolMismatches === 0 ? "✓" : "❌";
    const wlOk = audit.winlinesInvalid === 0 ? "✓" : "❌";
    lines.push(`Schema audits:`);
    lines.push(`  Symbol palette ${symOk}: ${audit.symbolMismatches} spin(s) had unknown symbol${audit.unknownSymbolsSeen.length > 0 ? ` (${audit.unknownSymbolsSeen.join(",")})` : ""}`);
    lines.push(`  Winlines       ${wlOk}: ${audit.winlinesInvalid} spin(s) had out-of-grid line positions`);
  }
  if (r.performance) {
    lines.push(``);
    const slo = r.performance.slowRate < 0.01 ? "✓" : "❌";
    lines.push(`Performance ${slo} (SLO: <${r.performance.thresholdMs}ms per spin):`);
    lines.push(`  min/mean/median/p95/p99/max  : ${r.performance.minMs}/${r.performance.meanMs}/${r.performance.medianMs}/${r.performance.p95Ms}/${r.performance.p99Ms}/${r.performance.maxMs} ms`);
    lines.push(`  Slow spins (>${r.performance.thresholdMs}ms): ${r.performance.slowSpins} (${(r.performance.slowRate * 100).toFixed(2)}%)`);
  }
  if (r.cascadeStats?.enabled) {
    lines.push(``);
    lines.push(`Cascade chain:`);
    lines.push(`  Total cascade frames : ${r.cascadeStats.totalFrames} (across ${r.spinsSuccessful} spins)`);
    lines.push(`  Avg frames/spin      : ${r.cascadeStats.avgFramesPerSpin.toFixed(2)}`);
  }
  if (r.debugDump) {
    lines.push(``);
    lines.push(`Debug dump (--debug):`);
    lines.push(`  Dir              : ${r.debugDump.dir}`);
    lines.push(`  Files            : ${r.debugDump.fileCount} (${r.debugDump.hashes.length} request+response pairs)`);
    const unique = r.debugDump.uniqueHashes;
    const total = r.debugDump.hashes.length;
    const diag =
      unique === 1 && total > 1
        ? `❌ ALL ${total} responses IDENTICAL → server replay/cache, NOT real spinning`
        : unique < total / 2 && total > 2
          ? `⚠️ Only ${unique}/${total} unique → server may be partially caching`
          : `✓ ${unique}/${total} unique → responses differ per request (looks healthy)`;
    lines.push(`  Unique bodies    : ${unique} / ${total}  ${diag}`);
    lines.push(`  Inspect          : ls ${r.debugDump.dir}/ && diff -u ${r.debugDump.dir}/spin-000-response*.txt ${r.debugDump.dir}/spin-001-response*.txt`);
  }
  if (r.consistency) {
    lines.push(``);
    lines.push(`Payout consistency vs paytable:`);
    const c = r.consistency;
    lines.push(`  Spins checked      : ${c.spinsChecked}`);
    const mismatchLabel = c.payoutMismatches > 0
      ? `${c.payoutMismatches} ❌ SERVER BUG`
      : `${c.payoutMismatches} ✓`;
    lines.push(`  Payout mismatches  : ${mismatchLabel}${c.mismatchRate != null ? `  (${(c.mismatchRate * 100).toFixed(3)}%)` : ""}`);
    lines.push(`  Inconclusive       : ${c.inconclusive}  (cascade/encoding rule engine không decode được)`);
    if (c.examples.length > 0) {
      lines.push(`  Mismatch samples (first ${Math.min(5, c.examples.length)}):`);
      for (const ex of c.examples.slice(0, 5)) {
        lines.push(`    spin#${ex.spinIndex}  expected=${ex.expected.toFixed(4)}  actual=${ex.actual.toFixed(4)}  Δ=${ex.delta.toFixed(4)}  reels=${ex.reels.slice(0, 20)}`);
      }
    }
  }
  lines.push(``);
  lines.push(`Win distribution (multiplier of bet):`);
  for (const b of r.winDistribution.buckets) {
    const label =
      b.min === 0 && b.max === 0
        ? "  =0   (no win)"
        : `  ${b.min.toFixed(2)} – ${b.max === Number.POSITIVE_INFINITY ? "∞" : b.max.toFixed(2)}`;
    lines.push(`${label.padEnd(20)}  ${String(b.count).padStart(8)}  (${(b.pctOfSpins * 100).toFixed(2)}%)`);
  }
  if (r.errors.length > 0) {
    lines.push(``);
    lines.push(`Errors:`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`  [${e.status ?? "n/a"}] ×${e.count}  ${e.message.slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}
