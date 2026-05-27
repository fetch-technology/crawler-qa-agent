// Bridge: read pipeline-format network captures
// (fixtures/registry/<slug>/network/network.jsonl) and yield them as the
// legacy `HttpEntry` shape that simulate.ts consumes.
//
// Why this exists:
//   - Legacy `npm run record` wrote `fixtures/recordings/<slug>__<ts>/http.jsonl`
//     in a flat per-event shape (one entry per phase=request|response|failed).
//   - Pipeline step3 capture-network writes
//     `fixtures/registry/<slug>/network/network.jsonl` in a grouped shape
//     (one `NetworkRound` per spin, with arrays of requests + responses).
//   - simulate.ts already understands the flat shape — so we expand pipeline
//     NetworkRounds into matching flat entries instead of teaching simulate
//     to read a second shape.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NetworkRound } from "../pipeline/step3-capture-network/types.js";

/** Mirror of the private `HttpEntry` shape from simulate.ts — kept in sync. */
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
};

const PIPELINE_NETWORK_FILE = "network.jsonl";

/** Return the absolute path to the pipeline-captured network jsonl for a slug,
 *  or null when no capture exists. */
export function pipelineCapturePath(slug: string): string | null {
  const p = join("fixtures", "registry", slug, "network", PIPELINE_NETWORK_FILE);
  return existsSync(p) ? p : null;
}

/** Read + parse pipeline NetworkRound[] from disk. Returns [] when the file
 *  is missing or empty. Tolerates per-line parse errors. */
export function readNetworkRounds(slug: string): NetworkRound[] {
  const file = pipelineCapturePath(slug);
  if (!file) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const out: NetworkRound[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NetworkRound);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Flatten pipeline NetworkRound[] into the legacy HttpEntry stream that
 *  simulate.ts expects. Order preserves: all requests of round N (in array
 *  order) → all responses of round N → next round.
 *
 *  Returns [] when no rounds available — caller can use this signal to skip
 *  stats with a friendly warning instead of throwing.
 *
 *  CRITICAL: response entries MUST carry `method` (copied from the matching
 *  request by URL). simulate.ts's findSpinTemplate pairs request↔response
 *  via the key `${method} ${url}` — without method on responses, every key
 *  becomes "undefined https://...", different from the request key, and
 *  no pair is ever found → no spin template → graceful skip with
 *  misleading "no capture" message. */
export function adaptPipelineCaptureToEntries(slug: string): HttpEntry[] {
  const rounds = readNetworkRounds(slug);
  const entries: HttpEntry[] = [];
  for (const round of rounds) {
    // Build a URL → method map from this round's requests so we can stamp
    // method on each response below. For PP a round typically has 1 request
    // and 1 response (or 1 request + N cascade responses on the same URL),
    // so the map collapses cleanly.
    const methodByUrl = new Map<string, string>();
    for (const req of round.requests ?? []) {
      entries.push({
        t: req.timestamp,
        phase: "request",
        method: req.method,
        url: req.url,
        headers: req.headers,
        postData: req.body,
      });
      methodByUrl.set(req.url, req.method);
    }
    for (const res of round.responses ?? []) {
      entries.push({
        t: res.timing?.finishedAt ?? 0,
        phase: "response",
        method: methodByUrl.get(res.url) ?? "POST", // default POST — PP spins are POST
        url: res.url,
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    }
  }
  return entries;
}
