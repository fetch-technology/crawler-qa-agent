/**
 * Extract deterministic scenarios từ existing recordings.
 *
 * Đọc fixtures/recordings/{slug}__(timestamp)/http.jsonl, tìm spin responses,
 * phân loại (no_win / normal_win / bonus_trigger / ...) và lưu thành scenario
 * JSON files trong fixtures/scenarios/{slug}/.
 *
 * CLI:
 *   tsx src/runner/scenario-extractor.ts <slug>           # extract latest recording
 *   tsx src/runner/scenario-extractor.ts <slug> --all     # extract from every recording
 *   tsx src/runner/scenario-extractor.ts --list           # list recordings
 *
 * Mỗi scenario gồm:
 *   - spin_response       (response chính, để mock)
 *   - prelude.authorize   (response của authorize-game, nếu có)
 *   - prelude.config      (response của /config, nếu có)
 *   - expected            (bet/win/balance để assertion)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  classifyScenario,
  saveScenario,
  type Scenario,
  type ScenarioLabel,
  type SpinResponseFixture,
} from "./scenario.js";
import {
  getSpinUrlPattern,
  scoreSpinShape,
  shouldSkipUrl,
  tryParseBody,
} from "./spin-detect.js";

// Same anti-replay filter as src/statistical/simulate.ts — rejects PP
// doInit/doSettings/doCollect responses that look like spins.
const NON_SPIN_ACTION_RE =
  /(?:^|[?&])(?:a|action)=do(Init|Settings|Bonus|Auth|History|Logout|Heartbeat|Buy|Help|GameLimits|Stats|SaveSettings|Collect)/i;
const SPIN_ACTION_RE = /(?:^|[?&])(?:a|action)=doSpin/i;
const ANY_ACTION_RE = /(?:^|[?&])(?:a|action)=/i;

function isSpinRequest(body: string | null | undefined, url: string): boolean {
  const combined = `${url}&${body ?? ""}`;
  if (NON_SPIN_ACTION_RE.test(combined)) return false;
  if (ANY_ACTION_RE.test(combined)) return SPIN_ACTION_RE.test(combined);
  return true;
}

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

const RECORDINGS_DIR = "fixtures/recordings";
const SPIN_PATTERN = getSpinUrlPattern();

export function listRecordingsForSlug(slug: string): string[] {
  if (!existsSync(RECORDINGS_DIR)) return [];
  return readdirSync(RECORDINGS_DIR)
    .filter((n) => n.startsWith(slug + "__"))
    .map((n) => join(RECORDINGS_DIR, n))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function listAllSlugs(): { slug: string; count: number; latest: string }[] {
  if (!existsSync(RECORDINGS_DIR)) return [];
  const bySlug = new Map<string, string[]>();
  for (const n of readdirSync(RECORDINGS_DIR)) {
    const full = join(RECORDINGS_DIR, n);
    if (!statSync(full).isDirectory()) continue;
    const slug = n.split("__")[0];
    if (!slug) continue;
    const arr = bySlug.get(slug) ?? [];
    arr.push(full);
    bySlug.set(slug, arr);
  }
  return [...bySlug.entries()].map(([slug, runs]) => ({
    slug,
    count: runs.length,
    latest: runs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!,
  }));
}

function readHttpEntries(recordingDir: string): HttpEntry[] {
  const path = join(recordingDir, "http.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: HttpEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

type SpinPair = {
  request: HttpEntry;
  response: HttpEntry;
  parsed: Record<string, unknown>;
};

/**
 * Pair request với response gần nhất (theo URL + method + time). Recorder
 * ghi request và response làm 2 entry riêng → cần join lại để extract.
 */
function pairSpinResponses(entries: HttpEntry[]): SpinPair[] {
  const pairs: SpinPair[] = [];
  const openRequests = new Map<string, HttpEntry[]>(); // key = method+url

  for (const e of entries) {
    if (shouldSkipUrl(e.url)) continue;
    const key = `${e.method ?? "GET"} ${e.url}`;
    if (e.phase === "request") {
      const arr = openRequests.get(key) ?? [];
      arr.push(e);
      openRequests.set(key, arr);
    } else if (e.phase === "response") {
      const arr = openRequests.get(key);
      const req = arr?.shift();
      if (!req || !e.body) continue;
      if (!SPIN_PATTERN.test(e.url)) continue;
      // Reject doInit/doSettings/doCollect — they have spin-like response shape
      // (balance, c, l, sa, sb, gameInfo) and pass scoreSpinShape, but they are
      // CONFIG/INIT data, not actual spin RNG. Saving them as scenarios poisons
      // every downstream test (mock returns init data, c is init-value not spin).
      if (!isSpinRequest(req.postData ?? "", req.url)) continue;

      const parsed = tryParseBody(e.body);
      if (!parsed) continue;
      const shape = scoreSpinShape(parsed);
      if (shape.score < 5) continue;

      pairs.push({ request: req, response: e, parsed });
    }
  }
  return pairs;
}

function findPreludeResponse(
  entries: HttpEntry[],
  pattern: RegExp,
): SpinResponseFixture | null {
  for (const e of entries) {
    if (e.phase !== "response" || !e.body) continue;
    if (!pattern.test(e.url)) continue;
    return {
      url: e.url,
      url_pattern: pattern.source,
      method: (e.method as "GET" | "POST") ?? "GET",
      status: e.status ?? 200,
      headers: filterHeaders(e.headers ?? {}),
      body: e.body,
    };
  }
  return null;
}

const HEADER_DROPLIST = new Set([
  "set-cookie",
  "alt-svc",
  "x-cache",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "cf-ray",
  "cf-cache-status",
  "via",
  "server-timing",
]);

function filterHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (HEADER_DROPLIST.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function buildScenario(
  slug: string,
  recordingDir: string,
  pair: SpinPair,
  preludeAuthorize: SpinResponseFixture | null,
  preludeConfig: SpinResponseFixture | null,
  preludeBalance: SpinResponseFixture | null,
  labelHint?: ScenarioLabel,
): Scenario {
  const { request, response, parsed } = pair;
  const label = labelHint ?? classifyScenario(parsed);

  const fixture: SpinResponseFixture = {
    url: response.url,
    url_pattern: SPIN_PATTERN.source,
    method: (request.method as "GET" | "POST") ?? "POST",
    status: response.status ?? 200,
    headers: filterHeaders(response.headers ?? {}),
    body: response.body ?? "",
    parsed,
  };

  return {
    slug,
    label,
    description: `Extracted from ${recordingDir} (response t=${response.t}ms)`,
    source_recording: recordingDir,
    spin_response: fixture,
    prelude: {
      authorize: preludeAuthorize ?? undefined,
      config: preludeConfig ?? undefined,
      balance: preludeBalance ?? undefined,
    },
    expected: {
      // Bet priority: explicit `betAmount`/`bet` (RG) → `c × l` (PP/ways/cluster) → `c` (fallback).
      // Reading `c` alone gives coin-per-line, NOT total bet — same bug fixed in stats sim.
      bet: (() => {
        const explicit = num(parsed.betAmount ?? parsed.bet ?? (parsed as any).totalBet);
        if (explicit != null) return explicit;
        const c = num((parsed as any).c);
        const l = num((parsed as any).l);
        if (c != null && l != null && c > 0 && l > 0) return c * l;
        return c;
      })(),
      win: num(parsed.winAmount ?? parsed.win ?? (parsed as any).tw),
      starting_balance: num(parsed.startingBalance),
      ending_balance: num(
        parsed.endingBalance ?? (parsed as any).updatedBalance ?? (parsed as any).balance,
      ),
      has_bonus: parsed.isFreeSpin === true || (num((parsed as any).winFreeSpins) ?? 0) > 0,
      is_free_spin: parsed.isFreeSpin === true,
      round_id:
        typeof parsed.id === "string"
          ? parsed.id
          : typeof parsed.round === "string"
            ? parsed.round
            : undefined,
    },
    frozen_time_ms: 1_735_689_600_000, // 2025-01-01 00:00:00 UTC — fixed baseline
    random_seed: 42,
  };
}

export function extractFromRecording(slug: string, recordingDir: string): {
  scenarios: Scenario[];
  written: string[];
} {
  const entries = readHttpEntries(recordingDir);
  if (entries.length === 0) {
    return { scenarios: [], written: [] };
  }

  const preludeAuthorize = findPreludeResponse(entries, /authorize-game|\/authorize\b/i);
  const preludeConfig = findPreludeResponse(entries, /\/config\b|\/gs2c\/.*Settings|\/init\b/i);
  const preludeBalance = findPreludeResponse(entries, /\/balance\b|\/wallet\b/i);

  const pairs = pairSpinResponses(entries);
  if (pairs.length === 0) {
    console.warn(`  No spin pairs found in ${recordingDir}`);
    return { scenarios: [], written: [] };
  }

  // Group by label; nếu nhiều spin cùng label → pick spin đầu tiên đại diện.
  const byLabel = new Map<ScenarioLabel, SpinPair>();
  for (const pair of pairs) {
    const label = classifyScenario(pair.parsed);
    if (!byLabel.has(label)) byLabel.set(label, pair);
  }

  const scenarios: Scenario[] = [];
  const written: string[] = [];
  for (const [label, pair] of byLabel) {
    const scenario = buildScenario(
      slug,
      recordingDir,
      pair,
      preludeAuthorize,
      preludeConfig,
      preludeBalance,
      label,
    );
    const path = saveScenario(scenario);
    scenarios.push(scenario);
    written.push(path);
  }
  return { scenarios, written };
}

/**
 * Convenience cho integration code (vd server runner): tự pick latest recording
 * và extract. Trả về số scenario đã ghi + file paths. Không throw nếu không có
 * recording (silent no-op) — caller decide có log warning hay không.
 */
export function extractLatestForSlug(slug: string): {
  recording: string | null;
  scenarios: Scenario[];
  written: string[];
} {
  const recordings = listRecordingsForSlug(slug);
  if (recordings.length === 0) {
    return { recording: null, scenarios: [], written: [] };
  }
  const recording = recordings[0]!;
  const out = extractFromRecording(slug, recording);
  return { recording, ...out };
}

function printHelp(): void {
  console.log(`
Scenario extractor — build deterministic scenarios from recorded sessions.

Usage:
  tsx src/runner/scenario-extractor.ts <slug>           Extract latest recording for slug
  tsx src/runner/scenario-extractor.ts <slug> --all     Extract from every recording
  tsx src/runner/scenario-extractor.ts --list           List all recordings
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args[0] === "--list") {
    const slugs = listAllSlugs();
    if (slugs.length === 0) {
      console.log("(no recordings found in fixtures/recordings/)");
      return;
    }
    console.log("Recordings available:");
    for (const s of slugs) {
      console.log(`  ${s.slug}  (${s.count} recording${s.count > 1 ? "s" : ""})  latest: ${s.latest}`);
    }
    return;
  }

  const slug = args[0]!;
  const all = args.includes("--all");
  const recordings = listRecordingsForSlug(slug);
  if (recordings.length === 0) {
    console.error(`No recordings found for slug "${slug}" in ${RECORDINGS_DIR}.`);
    process.exit(1);
  }

  const targets = all ? recordings : [recordings[0]!];
  console.log(`Extracting from ${targets.length} recording(s) for slug "${slug}"...`);

  let totalWritten = 0;
  for (const dir of targets) {
    console.log(`\n→ ${dir}`);
    const { scenarios, written } = extractFromRecording(slug, dir);
    for (const path of written) {
      console.log(`  ✔ ${path}`);
    }
    totalWritten += written.length;
    if (scenarios.length === 0) {
      console.log(`  (no scenarios extracted)`);
    }
  }
  console.log(`\nDone — wrote ${totalWritten} scenario file(s) to fixtures/scenarios/${slug}/`);
}

// Chỉ chạy CLI khi file được invoke trực tiếp (không qua import từ runner.ts).
const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const arg = process.argv[1];
    if (!arg) return false;
    return url.pathname === arg || url.pathname.endsWith(arg.replace(/^.*\//, ""));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("scenario-extractor failed:", err);
    process.exit(1);
  });
}
