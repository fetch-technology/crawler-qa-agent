// AI: called only during cold-start as FALLBACK when heuristic spin-API detection
// fails to find a clear winner. Reuses legacy `detectSpinEndpointWithAI`.

import {
  detectSpinEndpointWithAI,
  type NetworkHints,
  type ResponseSummary,
} from "../../ai/network-detect.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import type { CandidateScore } from "./types.js";

const ASSET_URL = /\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|map|json|wasm)(\?|$)/i;
const MAX_RESPONSES = 25;
const BODY_PREVIEW_LEN = 400;

export type AiRankInput = {
  gameSlug: string;
  provider: string;
  rounds: NetworkRound[];
  topHeuristicCandidates?: CandidateScore[];
};

export type AiRankResult =
  | { ok: true; hints: NetworkHints }
  | { ok: false; reason: string };

/**
 * Threshold below which we should invoke AI fallback. If top heuristic score < this,
 * call AI to discover spin endpoint + field mapping.
 */
export const AI_FALLBACK_HEURISTIC_THRESHOLD = 7;

export async function rankWithAi(input: AiRankInput): Promise<AiRankResult> {
  const summaries = collectResponseSummaries(input.rounds);
  if (summaries.length === 0) {
    return { ok: false, reason: "no HTTP responses captured" };
  }

  try {
    const hints = await detectSpinEndpointWithAI({
      gameSlug: input.gameSlug,
      provider: input.provider,
      responses: summaries,
    });
    return { ok: true, hints };
  } catch (err) {
    return {
      ok: false,
      reason: `ai detection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Convert captured rounds to legacy ResponseSummary shape.
 * Filters out asset URLs (JS bundles, images) and limits to top N.
 */
function collectResponseSummaries(rounds: NetworkRound[]): ResponseSummary[] {
  const seenUrls = new Set<string>();
  const out: ResponseSummary[] = [];
  for (const round of rounds) {
    for (const res of round.responses) {
      if (ASSET_URL.test(res.url)) continue;
      if (seenUrls.has(res.url)) continue;
      seenUrls.add(res.url);
      const body = res.body ?? "";
      const parsedKeys = extractKeys(body);
      const method = round.requests.find((r) => r.url === res.url)?.method ?? "GET";
      out.push({
        url: res.url,
        method,
        status: res.status,
        body_length: body.length,
        body_preview: body.slice(0, BODY_PREVIEW_LEN),
        parsed_keys: parsedKeys.slice(0, 30),
      });
      if (out.length >= MAX_RESPONSES) return out;
    }
  }
  return out;
}

function extractKeys(body: string): string[] {
  // URL-encoded body: keys are `key=...&key=...`
  const urlEncoded = Array.from(new Set((body.match(/(?:^|&)([\w_]+)=/g) ?? []).map((m) => m.replace(/[&=]/g, ""))));
  if (urlEncoded.length > 0) return urlEncoded;
  // JSON body: top-level keys
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.keys(obj);
    }
  } catch {
    // ignore
  }
  return [];
}
