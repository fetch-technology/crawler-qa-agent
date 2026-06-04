import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { getCurrentClaudeToken, getCurrentQaHash } from "../server/request-context.js";
import { logUsage } from "../server/usage-log.js";

const USAGE_EXHAUSTED_PATTERNS = [
  /you'?re out of extra usage/i,
  /usage limit/i,
  /rate limit/i,
  /quota exceeded/i,
];

/** Thrown by askClaude when neither a per-request token (X-Claude-Token
 *  header) nor the master env-var fallback is configured. HTTP route
 *  handlers catch this and return 401 with a clear "set your token"
 *  message so the dashboard can prompt the QA to paste theirs. */
export class MissingClaudeTokenError extends Error {
  constructor() {
    super("No Claude token available — set your token in the dashboard (sent as X-Claude-Token header) or configure CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in .env");
    this.name = "MissingClaudeTokenError";
  }
}

/** Validate a Claude token's format without calling the API. PP/Anthropic
 *  OAuth tokens start with `sk-ant-oat01-` and API keys start with
 *  `sk-ant-api03-`. We accept both. Cheap pre-check used by the dashboard
 *  to reject obviously-malformed input without burning an API call. */
export function isValidClaudeTokenFormat(token: string): boolean {
  return /^sk-ant-(oat\d+|api\d+)-[A-Za-z0-9_-]{32,}$/.test(token.trim());
}

/** Resolve the Claude token to use for the NEXT API call. Per-request
 *  context (set by HTTP middleware from X-Claude-Token) takes priority;
 *  master env var is the fallback for CLI mode + backward compat.
 *  Returns null when neither is available. */
function resolveClaudeToken(): string | null {
  const ctxToken = getCurrentClaudeToken();
  if (ctxToken) return ctxToken;
  return process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? null;
}

/** Build the env object passed to the agent SDK's spawn so we can inject
 *  the per-QA token WITHOUT mutating the shared process.env (which would
 *  race across concurrent requests). Copies process.env then overrides
 *  CLAUDE_CODE_OAUTH_TOKEN with the resolved token. */
function buildClaudeEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // If master used ANTHROPIC_API_KEY, the agent SDK uses CLAUDE_CODE_OAUTH_TOKEN
  // preferentially — clearing ANTHROPIC_API_KEY avoids ambiguity.
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Replace any sk-ant-* token in a string with a masked form so it can be
 *  safely logged. Preserves the token's prefix + last 4 chars for triage
 *  ("which token failed?") without leaking the secret. Used in stderr
 *  capture + error.message scrubbing before console.log / disk writes.
 *
 * Example:  "auth failed: sk-ant-oat01-WKtc...AAAA" → "auth failed: sk-ant-oat01-***AAAA" */
export function scrubClaudeToken(text: string): string {
  return text.replace(/sk-ant-(oat\d+|api\d+)-[A-Za-z0-9_-]{16,}/g, (m) => {
    const tail = m.slice(-4);
    const head = m.split("-").slice(0, 3).join("-"); // e.g. "sk-ant-oat01"
    return `${head}-***${tail}`;
  });
}

function isUsageExhaustedMessage(text: string): boolean {
  return USAGE_EXHAUSTED_PATTERNS.some((p) => p.test(text));
}

async function* yieldOnce(
  content: Anthropic.Messages.MessageParam["content"],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

function approximateTokens(content: Anthropic.Messages.MessageParam["content"], system: string): {
  promptChars: number;
  systemChars: number;
  totalChars: number;
  estTokens: number;
} {
  let promptChars = 0;
  if (typeof content === "string") {
    promptChars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") promptChars += (block.text ?? "").length;
      else if (block.type === "image") promptChars += 4000;
    }
  }
  const totalChars = promptChars + system.length;
  // ~3.5 chars/token approximation cho English+JSON.
  return {
    promptChars,
    systemChars: system.length,
    totalChars,
    estTokens: Math.round(totalChars / 3.5),
  };
}

export async function askClaude(args: {
  content: Anthropic.Messages.MessageParam["content"];
  system: string;
  maxTurns?: number;
  /** Optional label for diagnostic logs (e.g. "catalog/PLAN", "catalog/EXPAND") */
  label?: string;
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number;
}): Promise<string> {
  const token = resolveClaudeToken();
  if (!token) {
    throw new MissingClaudeTokenError();
  }

  const sizing = approximateTokens(args.content, args.system);
  const label = args.label ?? "askClaude";
  console.log(
    `[${label}] sending prompt: ${sizing.promptChars} chars (+${sizing.systemChars} system) ≈ ${sizing.estTokens} tokens`,
  );
  // Capture qaHash + call start once so both success + failure paths log
  // under the same identity / timing. "master" when no QA token in context.
  const qaHash = getCurrentQaHash() ?? "master";
  const callStartedAt = new Date().toISOString();
  const startMs = performance.now();

  // Buffer stderr from the spawned Claude Code child process so we can surface
  // the actual cause if the child dies (rate_limit, max_tokens, auth, etc).
  // SDK's "Claude Code process exited with code 1" alone is unhelpful.
  const stderrBuf: string[] = [];
  const debugMode = process.env.QA_CLAUDE_DEBUG === "1";
  const envTimeoutMs = Number(process.env.QA_CLAUDE_TIMEOUT_MS ?? 90_000);
  const timeoutMs = Math.max(1_000, Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : envTimeoutMs);

  const q = query({
    prompt: yieldOnce(args.content),
    options: {
      model: "claude-opus-4-7",
      maxTurns: args.maxTurns ?? 1,
      tools: [],
      systemPrompt: args.system,
      includePartialMessages: false,
      debug: debugMode,
      // Per-call env so per-QA tokens don't race via shared process.env.
      // SDK spawns a subprocess with this env; parent process.env stays
      // untouched. Master fallback when context didn't carry a token.
      env: buildClaudeEnv(token),
      stderr: (chunk: string) => {
        stderrBuf.push(chunk);
        if (debugMode) process.stderr.write(`[${label}/stderr] ${scrubClaudeToken(chunk)}`);
      },
    },
  });

  let text = "";
  let caught: unknown = null;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    void q.interrupt().catch(() => {});
  }, timeoutMs);
  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (msg.type === "result") {
        break;
      }
    }
  } catch (err) {
    caught = err;
  } finally {
    clearTimeout(timeoutId);
    await q.interrupt().catch(() => {});
  }

  if (timedOut && !caught) {
    // Log the failed call before throwing — QAs should see timeouts in
    // their usage panel so they can spot if a particular phase is OOM /
    // looping. Fire-and-forget; logUsage swallows its own errors.
    void logUsage({
      at: callStartedAt,
      qaHash,
      label,
      estInputTokens: sizing.estTokens,
      estOutputTokens: Math.round(text.length / 3.5),
      outputChars: text.length,
      durationMs: Math.round(performance.now() - startMs),
      ok: false,
    });
    throw new Error(
      `[${label}] Claude request timeout after ${timeoutMs}ms. Set QA_CLAUDE_TIMEOUT_MS or pass askClaude({ timeoutMs }) to adjust.`,
    );
  }

  if (caught) {
    void logUsage({
      at: callStartedAt,
      qaHash,
      label,
      estInputTokens: sizing.estTokens,
      estOutputTokens: Math.round(text.length / 3.5),
      outputChars: text.length,
      durationMs: Math.round(performance.now() - startMs),
      ok: false,
    });
    const stderrText = scrubClaudeToken(stderrBuf.join("").trim());
    const tail = stderrText.length > 2000 ? "…" + stderrText.slice(-2000) : stderrText;
    const baseMsg = scrubClaudeToken((caught as Error).message ?? String(caught));
    if (isUsageExhaustedMessage(baseMsg) || isUsageExhaustedMessage(stderrText)) {
      throw new Error(
        `[${label}] Claude usage exhausted. Refill quota/token or switch model before rerun.`,
      );
    }
    const enriched = stderrText
      ? `${baseMsg}\n--- captured Claude CLI stderr (${stderrText.length} chars) ---\n${tail}`
      : `${baseMsg}\n(no stderr captured — re-run with QA_CLAUDE_DEBUG=1 for SDK debug logs)`;
    const wrapped = new Error(`[${label}] ${enriched}`);
    (wrapped as Error & { cause?: unknown }).cause = caught;
    throw wrapped;
  }

  // No throw but empty response — also dump stderr for diagnosis.
  if (!text.trim() && stderrBuf.length > 0) {
    const stderrText = scrubClaudeToken(stderrBuf.join("").trim());
    console.warn(`[${label}] empty response. stderr tail:\n${stderrText.slice(-1000)}`);
  }

  if (isUsageExhaustedMessage(text)) {
    void logUsage({
      at: callStartedAt,
      qaHash,
      label,
      estInputTokens: sizing.estTokens,
      estOutputTokens: Math.round(text.length / 3.5),
      outputChars: text.length,
      durationMs: Math.round(performance.now() - startMs),
      ok: false,
    });
    throw new Error(
      `[${label}] Claude usage exhausted. Refill quota/token or switch model before rerun.`,
    );
  }

  void logUsage({
    at: callStartedAt,
    qaHash,
    label,
    estInputTokens: sizing.estTokens,
    estOutputTokens: Math.round(text.length / 3.5),
    outputChars: text.length,
    durationMs: Math.round(performance.now() - startMs),
    ok: true,
  });

  return text;
}

export function extractJsonFromText<T = unknown>(raw: string): T | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

export function extractCodeFromText(raw: string, lang = "typescript"): string {
  const fence = new RegExp("```(?:" + lang + "|ts|tsx)?\\s*([\\s\\S]*?)```", "m");
  const m = raw.match(fence);
  return m ? m[1]!.trim() : raw.trim();
}
