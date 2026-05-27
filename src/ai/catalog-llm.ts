// AI: catalog generation only — cold-start. Caching-capable client built on
// the raw `@anthropic-ai/sdk` so the large, stable `sourceBlock` (and the
// static EXPAND rules) can be marked with `cache_control` and reused across
// the PLAN call + every parallel EXPAND batch + repair. The default
// `askClaude` wrapper uses the Claude Agent SDK `query()` subprocess which does
// NOT expose cache_control, hence this separate client.
//
// Auth: prefers ANTHROPIC_API_KEY; falls back to CLAUDE_CODE_OAUTH_TOKEN as a
// bearer authToken. If the raw SDK can't authenticate (e.g. the Messages API
// rejects the OAuth token) the FIRST call disables caching for the process and
// every call transparently falls back to `askClaude` (no cache, still works).

import Anthropic from "@anthropic-ai/sdk";
import { askClaude, extractJsonFromText } from "./claude.js";

export { extractJsonFromText };

const MODEL = process.env.QA_CATALOG_MODEL ?? "claude-opus-4-7";

let client: Anthropic | null = null;
let cachingDisabled = false;

function getClient(): Anthropic | null {
  if (cachingDisabled) return null;
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Auth selection:
  //   - ANTHROPIC_API_KEY present → use it (reliable raw-API access + caching).
  //   - OAuth-only: the raw Messages API HEAVILY rate-limits subscription OAuth
  //     tokens (observed 429 on first call), so caching via OAuth isn't viable
  //     by default. Skip the raw SDK and let everything fall back to askClaude
  //     (the subprocess uses the subscription quota that already works). Opt in
  //     to the OAuth raw-SDK attempt with QA_CATALOG_CACHE_OAUTH=1.
  // maxRetries low so a doomed/rate-limited probe fails FAST instead of backing
  // off for seconds before we fall back.
  try {
    if (apiKey) {
      client = new Anthropic({ apiKey, maxRetries: 2 });
    } else if (authToken && process.env.QA_CATALOG_CACHE_OAUTH === "1") {
      client = new Anthropic({ authToken, maxRetries: 1 });
    } else {
      cachingDisabled = true;
      return null;
    }
    return client;
  } catch {
    cachingDisabled = true;
    return null;
  }
}

/** True when the raw-SDK cached path is still considered usable this process. */
export function isCachingAvailable(): boolean {
  if (cachingDisabled) return false;
  if (process.env.ANTHROPIC_API_KEY) return true;
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) && process.env.QA_CATALOG_CACHE_OAUTH === "1";
}

/** A prompt segment. `cache: true` marks a cache_control breakpoint so this
 *  block (and everything before it) is cached for ~5 min. */
export type CacheBlock = { text: string; cache?: boolean };

export type CatalogCallResult = {
  text: string;
  /** True when served via the cached raw-SDK path (vs the askClaude fallback). */
  cached: boolean;
};

/**
 * One model call for catalog generation. System + user are arrays of blocks;
 * blocks with `cache: true` get a cache_control marker. On the cached path the
 * usage line logs cache read/create tokens so you can confirm caching works.
 * On any raw-SDK failure, disables caching for the process and falls back to
 * askClaude (flattening blocks into a single system string + user text).
 */
export async function catalogCall(args: {
  system: CacheBlock[];
  user: CacheBlock[];
  label: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<CatalogCallResult> {
  const c = getClient();
  if (c) {
    try {
      const resp = await c.messages.create(
        {
          model: MODEL,
          max_tokens: args.maxTokens ?? 8192,
          system: args.system.map((b) =>
            b.cache
              ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } }
              : { type: "text" as const, text: b.text },
          ),
          messages: [
            {
              role: "user",
              content: args.user.map((b) =>
                b.cache
                  ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } }
                  : { type: "text" as const, text: b.text },
              ),
            },
          ],
        },
        { timeout: args.timeoutMs ?? 600_000 },
      );
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const u = resp.usage;
      console.log(
        `[${args.label}] cached-call usage: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} `
        + `cacheRead=${u.cache_read_input_tokens ?? 0} cacheCreate=${u.cache_creation_input_tokens ?? 0}`,
      );
      return { text, cached: true };
    } catch (err) {
      cachingDisabled = true;
      client = null;
      console.warn(
        `[${args.label}] caching unavailable → fallback askClaude. reason: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Fallback (no cache): keep the system prompt SMALL — fold the big cached
  // blocks (sourceBlock, rules) into the USER content. The claude-agent-sdk
  // subprocess breaks ("Unterminated string" / exit 1) when systemPrompt is
  // huge (~56k chars), so we mirror the original working layout: tiny system,
  // large user content. The first system block is the preamble; everything
  // else moves into the user message.
  const preamble = args.system[0]?.text ?? "";
  const restSystem = args.system.slice(1).map((b) => b.text);
  const userStr = [...restSystem, ...args.user.map((b) => b.text)]
    .filter((t) => t.length > 0)
    .join("\n\n");
  const text = await askClaude({
    content: [{ type: "text", text: userStr }],
    system: preamble,
    maxTurns: 1,
    label: args.label,
    timeoutMs: args.timeoutMs,
  });
  return { text, cached: false };
}

/** Split an array into chunks of at most `size` (min 1). Pure. */
export function chunkStubs<T>(items: T[], size: number): T[][] {
  const s = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += s) out.push(items.slice(i, i + s));
  return out;
}

/** Merge EXPAND batch results into one ordered case list, deduped by `id`
 *  (first occurrence wins). Skips entries without a string id. Pure. */
export function mergeExpandedBatches<T extends { id?: unknown }>(batches: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const c of batch) {
      if (!c || typeof c.id !== "string" || c.id.length === 0) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** Run async fn over items with a concurrency cap, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
