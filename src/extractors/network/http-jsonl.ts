import { readFileSync, existsSync } from "node:fs";

export type HttpEntry = {
  t: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  headers?: Record<string, string>;
  postData?: string | null;
  body?: string | null;
  bodyTruncated?: boolean;
  failure?: string;
};

export function readHttpJsonl(path: string): HttpEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: HttpEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as HttpEntry);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Pair request với response theo url+method (best-effort, lấy lần response đầu). */
export function pairRequestResponse(
  entries: HttpEntry[],
): Array<{ request: HttpEntry | null; response: HttpEntry }> {
  const responses = entries.filter((e) => e.phase === "response");
  const requests = entries.filter((e) => e.phase === "request");
  return responses.map((res) => {
    const req =
      requests.find(
        (r) => r.url === res.url && r.method === res.method && r.t <= res.t,
      ) ?? null;
    return { request: req, response: res };
  });
}

const NOISE_HOST_PATTERNS: RegExp[] = [
  /cookieyes\.com/i,
  /googletagmanager/i,
  /google-analytics/i,
  /hotjar\.com/i,
  /sentry\.io/i,
  /\brecaptcha\b/i,
  /\bcloudflare\b/i,
  /cdn-cgi/i,
  /clctr\./i,           // generic collectors
  /fonts\.gstatic/i,
  /gstatic\.com\/recaptcha/i,
];

const NOISE_PATH_PATTERNS: RegExp[] = [
  /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|css|mp3|mp4|wav|ogg|m4a|webm|atlas)(\?|$)/i,
  /\/cdn-cgi\//i,
  /\/collect(\?|$)/i,
  /\/beacon(\?|$)/i,
  /favicon\.ico/i,
];

export function isNoise(url: string): boolean {
  try {
    const u = new URL(url);
    if (NOISE_HOST_PATTERNS.some((re) => re.test(u.host))) return true;
    if (NOISE_PATH_PATTERNS.some((re) => re.test(u.pathname + (u.search || "")))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Heuristic: response trông giống "config game" — body chứa từ khóa
 * bet/rtp/balance/symbol/paytable/reel/spin/coin/wager/wallet hoặc
 * chunk form-encoded với key dạng đó.
 */
export function looksLikeGameConfig(body: string | null | undefined): boolean {
  if (!body) return false;
  const sample = body.slice(0, 4000).toLowerCase();
  let hits = 0;
  for (const kw of [
    "balance",
    "bet",
    "rtp",
    "symbol",
    "paytable",
    "reel",
    "wager",
    "wallet",
    "coin",
    "spin",
    "ante",
    "free_spins",
    "buy_feature",
    "purchase",
    "max_win",
    "currency",
  ]) {
    if (sample.includes(kw)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

/**
 * Filter entries → response 200 trên endpoint không-noise có body trông giống
 * game config. Dùng cho AI extractor input.
 */
export function pickConfigCandidates(
  entries: HttpEntry[],
): Array<{ url: string; method: string; status: number; body: string }> {
  const out: Array<{ url: string; method: string; status: number; body: string }> = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (e.status !== 200) continue;
    if (!e.body) continue;
    if (isNoise(e.url)) continue;
    if (!looksLikeGameConfig(e.body)) continue;
    const key = `${e.method ?? "GET"} ${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: e.url,
      method: e.method ?? "GET",
      status: e.status,
      body: e.body,
    });
  }
  return out;
}
