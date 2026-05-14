import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

type HttpEntry = {
  t: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  postData?: string | null;
  body?: string | null;
};

type WsEntry = {
  t: number;
  wsId: number;
  direction: "open" | "close" | "sent" | "received" | "error";
  url?: string;
  payload?: string;
  payloadType?: "text" | "binary";
};

const GAMEPLAY_HINTS = /\b(spin|bet|wager|round|game|balance|wallet|play|history|transaction|win|payout|reel|config|init|authorize|session)\b/i;
const STATIC_EXT = /\.(png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|mp3|ogg|wav|wasm|js|css|map|atlas|plist|bin|dat)(\?|$)/i;

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function pickLatestRun(baseDir: string): string {
  if (!existsSync(baseDir)) {
    console.error(`Không tìm thấy thư mục ${baseDir}`);
    process.exit(1);
  }
  const dirs = readdirSync(baseDir)
    .map((name) => ({ name, full: join(baseDir, name) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  if (dirs.length === 0) {
    console.error(`Chưa có recording nào trong ${baseDir}`);
    process.exit(1);
  }
  return dirs[0]!.full;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `... (${s.length - n} more)`;
}

function main() {
  const target = process.argv[2] ?? pickLatestRun("fixtures/recordings");
  console.log(`\n=== Analyzing: ${target} ===\n`);

  // Hỗ trợ cả format cũ (http.json mảng) và mới (http.jsonl streaming)
  const http = readJsonl<HttpEntry>(join(target, "http.jsonl"));
  if (http.length === 0 && existsSync(join(target, "http.json"))) {
    const arr = JSON.parse(readFileSync(join(target, "http.json"), "utf8")) as HttpEntry[];
    http.push(...arr);
  }
  const ws = readJsonl<WsEntry>(join(target, "ws.jsonl"));
  if (ws.length === 0 && existsSync(join(target, "ws.json"))) {
    const arr = JSON.parse(readFileSync(join(target, "ws.json"), "utf8")) as WsEntry[];
    ws.push(...arr);
  }

  console.log(`HTTP entries : ${http.length}`);
  console.log(`WS entries   : ${ws.length}\n`);

  // 1. Hosts
  const hostCounts: Record<string, number> = {};
  for (const e of http) {
    if (e.phase !== "response") continue;
    try {
      const host = new URL(e.url).host;
      hostCounts[host] = (hostCounts[host] ?? 0) + 1;
    } catch {}
  }
  console.log(`--- Hosts (response count) ---`);
  for (const [host, n] of Object.entries(hostCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(5)}  ${host}`);
  }

  // 2. Gameplay candidates: không phải static asset, có keyword hoặc là POST
  const candidates = http.filter((e) => {
    if (e.phase !== "response") return false;
    if (STATIC_EXT.test(e.url)) return false;
    const isPost = e.method === "POST" || e.method === "PUT" || e.method === "DELETE";
    const matchesKeyword = GAMEPLAY_HINTS.test(e.url);
    return isPost || matchesKeyword;
  });

  // Group by endpoint (path only, strip query for grouping)
  const byEndpoint = new Map<string, HttpEntry[]>();
  for (const e of candidates) {
    try {
      const u = new URL(e.url);
      const key = `${e.method} ${u.host}${u.pathname}`;
      const arr = byEndpoint.get(key) ?? [];
      arr.push(e);
      byEndpoint.set(key, arr);
    } catch {}
  }

  console.log(`\n--- Gameplay endpoint candidates (${byEndpoint.size} unique, ${candidates.length} calls) ---`);
  const sorted = [...byEndpoint.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, entries] of sorted) {
    const statuses = [...new Set(entries.map((e) => e.status))].join(",");
    console.log(`\n  [${entries.length}x, status ${statuses}] ${key}`);
    const sample = entries[0]!;
    if (sample.postData) {
      console.log(`    POST body: ${truncate(sample.postData, 300)}`);
    }
    if (sample.body) {
      const bodyPreview = sample.body.trim().startsWith("{") || sample.body.trim().startsWith("[")
        ? sample.body.trim()
        : sample.body;
      console.log(`    Response : ${truncate(bodyPreview, 400)}`);
    }
  }

  // 3. WS summary
  if (ws.length > 0) {
    console.log(`\n--- WebSocket ---`);
    const opens = ws.filter((e) => e.direction === "open");
    for (const o of opens) console.log(`  open: ${o.url}`);
    const sent = ws.filter((e) => e.direction === "sent");
    const received = ws.filter((e) => e.direction === "received");
    console.log(`  sent: ${sent.length} frames, received: ${received.length} frames`);
    if (sent.length > 0) console.log(`  sent sample    : ${truncate(sent[0]!.payload ?? "", 300)}`);
    if (received.length > 0) console.log(`  received sample: ${truncate(received[0]!.payload ?? "", 300)}`);
  } else {
    console.log(`\n--- WebSocket: none ---`);
  }

  // 4. Looking specifically for spin-shaped payloads
  console.log(`\n--- Payloads containing "win", "bet", "balance" keywords ---`);
  const interesting = http.filter((e) => e.phase === "response" && e.body && /"(?:bet|win|balance|payout|reel|spin|round|symbol)"/i.test(e.body));
  const uniqueInteresting = new Map<string, HttpEntry>();
  for (const e of interesting) {
    try {
      const u = new URL(e.url);
      uniqueInteresting.set(`${e.method} ${u.host}${u.pathname}`, e);
    } catch {}
  }
  for (const [key, e] of uniqueInteresting) {
    console.log(`\n  ${key}`);
    console.log(`    body: ${truncate(e.body ?? "", 400)}`);
  }

  console.log(`\n=== Done ===\n`);
}

main();
