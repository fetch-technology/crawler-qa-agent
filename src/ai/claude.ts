import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";

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
}): Promise<string> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY) trong .env");
  }

  const sizing = approximateTokens(args.content, args.system);
  const label = args.label ?? "askClaude";
  console.log(
    `[${label}] sending prompt: ${sizing.promptChars} chars (+${sizing.systemChars} system) ≈ ${sizing.estTokens} tokens`,
  );

  // Buffer stderr from the spawned Claude Code child process so we can surface
  // the actual cause if the child dies (rate_limit, max_tokens, auth, etc).
  // SDK's "Claude Code process exited with code 1" alone is unhelpful.
  const stderrBuf: string[] = [];
  const debugMode = process.env.QA_CLAUDE_DEBUG === "1";

  const q = query({
    prompt: yieldOnce(args.content),
    options: {
      model: "claude-opus-4-7",
      maxTurns: args.maxTurns ?? 1,
      tools: [],
      systemPrompt: args.system,
      includePartialMessages: false,
      debug: debugMode,
      stderr: (chunk: string) => {
        stderrBuf.push(chunk);
        if (debugMode) process.stderr.write(`[${label}/stderr] ${chunk}`);
      },
    },
  });

  let text = "";
  let caught: unknown = null;
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
    await q.interrupt().catch(() => {});
  }

  if (caught) {
    const stderrText = stderrBuf.join("").trim();
    const tail = stderrText.length > 2000 ? "…" + stderrText.slice(-2000) : stderrText;
    const baseMsg = (caught as Error).message ?? String(caught);
    const enriched = stderrText
      ? `${baseMsg}\n--- captured Claude CLI stderr (${stderrText.length} chars) ---\n${tail}`
      : `${baseMsg}\n(no stderr captured — re-run with QA_CLAUDE_DEBUG=1 for SDK debug logs)`;
    const wrapped = new Error(`[${label}] ${enriched}`);
    (wrapped as Error & { cause?: unknown }).cause = caught;
    throw wrapped;
  }

  // No throw but empty response — also dump stderr for diagnosis.
  if (!text.trim() && stderrBuf.length > 0) {
    const stderrText = stderrBuf.join("").trim();
    console.warn(`[${label}] empty response. stderr tail:\n${stderrText.slice(-1000)}`);
  }

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
