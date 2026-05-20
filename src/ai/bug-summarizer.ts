/**
 * AI Bug Summarizer — read ValidationErrors from DB (or a provided list),
 * group by errorType, ask Claude for a QA-friendly Markdown summary, and
 * persist back to `TestRun.summaryMd`.
 *
 * Cost: 1 LLM call per `summarize()` invocation (Opus, ~1–3K tokens).
 *
 * Skipping: if `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` is absent OR
 * `validationErrors` is empty, returns a deterministic Markdown skeleton
 * without calling the LLM — useful for CI smoke tests.
 */

import { askClaude } from "./claude.js";
import {
  listValidationErrors,
  groupValidationErrorsByType,
  getTestRun,
  updateTestRunStatus,
  isDbEnabled,
} from "../db/index.js";

export type BugSummaryInput = {
  testRunId: string;
  /** Optional override — skip DB read if errors already in hand. */
  validationErrors?: Array<{
    errorType: string;
    severity: string;
    message: string;
    expectedValue?: string | null;
    actualValue?: string | null;
  }>;
  /** Game code for context. */
  gameCode?: string;
};

export type BugSummary = {
  testRunId: string;
  markdown: string;
  groupCounts: Array<{ errorType: string; count: number }>;
  generatedAt: string;
  source: "llm" | "skeleton";
};

const SYSTEM_PROMPT = `You are a QA lead reviewing automated test failures from a slot-game testing harness.
Output a concise Markdown bug report grouping errors by category, with:
  - One H2 per error type
  - A 1-2 sentence root-cause hypothesis
  - Highest-severity examples (max 3 per group)
  - Recommended next action (engineer-facing)
Use neutral, technical tone. Omit boilerplate. Do not invent error counts — only summarize what you are shown.
Output ONLY the markdown body — no preamble, no code fences around the whole thing.`;

function deterministicSkeleton(args: {
  testRunId: string;
  gameCode?: string;
  groups: Array<{ errorType: string; count: number }>;
  samples: Map<string, Array<{ severity: string; message: string }>>;
}): string {
  const lines: string[] = [];
  lines.push(`# Bug Summary — TestRun ${args.testRunId}`);
  if (args.gameCode) lines.push(`\nGame: \`${args.gameCode}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: skeleton (no LLM call)\n`);
  if (args.groups.length === 0) {
    lines.push(`✅ No validation errors recorded.`);
    return lines.join("\n");
  }
  for (const g of args.groups) {
    lines.push(`\n## ${g.errorType} (${g.count})`);
    const samples = args.samples.get(g.errorType) ?? [];
    for (const s of samples.slice(0, 3)) {
      lines.push(`- **[${s.severity}]** ${s.message}`);
    }
  }
  return lines.join("\n");
}

export async function summarizeBugs(input: BugSummaryInput): Promise<BugSummary> {
  let errors = input.validationErrors;
  let gameCode = input.gameCode;

  if (!errors && isDbEnabled()) {
    const run = await getTestRun(input.testRunId);
    if (run) gameCode = gameCode ?? run.gameCode;
    const rows = await listValidationErrors(input.testRunId, { limit: 500 });
    errors = rows.map((r) => ({
      errorType: r.errorType,
      severity: r.severity,
      message: r.message,
      expectedValue: r.expectedValue,
      actualValue: r.actualValue,
    }));
  }
  errors = errors ?? [];

  // Group counts
  const counts = new Map<string, number>();
  const samples = new Map<string, Array<{ severity: string; message: string }>>();
  for (const e of errors) {
    counts.set(e.errorType, (counts.get(e.errorType) ?? 0) + 1);
    const arr = samples.get(e.errorType) ?? [];
    arr.push({ severity: e.severity, message: e.message });
    samples.set(e.errorType, arr);
  }
  const groupCounts = [...counts.entries()]
    .map(([errorType, count]) => ({ errorType, count }))
    .sort((a, b) => b.count - a.count);

  // Cheap path: empty or no LLM creds → deterministic skeleton
  const hasLlmCreds =
    Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (errors.length === 0 || !hasLlmCreds) {
    const markdown = deterministicSkeleton({
      testRunId: input.testRunId,
      gameCode,
      groups: groupCounts,
      samples,
    });
    return {
      testRunId: input.testRunId,
      markdown,
      groupCounts,
      generatedAt: new Date().toISOString(),
      source: "skeleton",
    };
  }

  // LLM path
  const groupedText = groupCounts
    .map((g) => {
      const examples = (samples.get(g.errorType) ?? []).slice(0, 5);
      return `### ${g.errorType} (count=${g.count})\n` +
        examples.map((e) => `  - [${e.severity}] ${e.message}`).join("\n");
    })
    .join("\n\n");

  const prompt =
    `Test run: ${input.testRunId}\n` +
    (gameCode ? `Game: ${gameCode}\n` : "") +
    `Total validation errors: ${errors.length}\n` +
    `Grouped by type:\n\n${groupedText}\n\n` +
    `Write a Markdown bug summary as described in the system prompt.`;

  const text = await askClaude({
    content: prompt,
    system: SYSTEM_PROMPT,
    maxTurns: 1,
    label: "bug-summary",
  });

  const summary: BugSummary = {
    testRunId: input.testRunId,
    markdown: text.trim(),
    groupCounts,
    generatedAt: new Date().toISOString(),
    source: "llm",
  };

  // Persist to DB if available
  if (isDbEnabled()) {
    await updateTestRunStatus(input.testRunId, { summaryMd: summary.markdown });
  }

  return summary;
}

/** Diagnostic helper (debug only). */
export async function bugTypeCounts(testRunId: string) {
  if (!isDbEnabled()) return [];
  return groupValidationErrorsByType(testRunId);
}
