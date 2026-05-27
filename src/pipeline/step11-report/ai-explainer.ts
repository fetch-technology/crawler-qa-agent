// AI: opt-in post-FAIL summarizer. Called ONCE per cold-start when rule engine
// reports failures. Sends rule-failure list + sample failing spins to Claude
// for root-cause analysis + suggested fix.

import { askClaude } from "../../ai/claude.js";
import type { CaseReportInput } from "./types.js";
import type { RuleResult } from "../step9-verify/rule.js";

const SYSTEM_PROMPT =
  "You are a senior QA engineer reviewing automated slot-game test results. You read a list of rule failures and write a concise, actionable root-cause summary in Markdown. You group similar failures, identify the underlying issue (parser bug? cascade-handling? server bug?), and suggest the most-likely fix. You are concise — bullet points, not paragraphs.";

const MAX_FAILURE_SAMPLES_PER_RULE = 3;
const MAX_TOTAL_FAILURES_IN_PROMPT = 25;

export async function explainFailures(input: CaseReportInput): Promise<string | null> {
  if (process.env.QA_AI_EXPLAIN !== "1") return null;

  // Collect failed rules
  const failures: Array<{ roundIndex: number; result: RuleResult }> = [];
  for (const row of input.rules.results) {
    for (const r of row.results) {
      if (!r.pass && r.severity === "error") {
        failures.push({ roundIndex: row.roundIndex, result: r });
      }
    }
  }
  if (failures.length === 0) return null;

  // Group by ruleName, keep N samples each
  const byRule = new Map<string, Array<{ roundIndex: number; result: RuleResult }>>();
  for (const f of failures) {
    const arr = byRule.get(f.result.ruleName) ?? [];
    if (arr.length < MAX_FAILURE_SAMPLES_PER_RULE) arr.push(f);
    byRule.set(f.result.ruleName, arr);
  }
  const slimmed = Array.from(byRule.entries()).slice(0, MAX_TOTAL_FAILURES_IN_PROMPT);

  // Sample failing spins (first 5 with index match)
  const failingIndices = new Set(failures.map((f) => f.roundIndex));
  const sampleSpins = (input.massive?.spins ?? [])
    .filter((_s, idx) => failingIndices.has(idx))
    .slice(0, 5);

  const prompt = buildPrompt({
    gameSlug: input.crawl.gameSlug,
    provider: input.crawl.provider,
    totalSpins: input.rules.totalSpins,
    totalFailures: failures.length,
    failuresByRule: slimmed,
    sampleSpins,
    statsRtp: input.stats?.rtp,
    statsHitRate: input.stats?.hitRate,
  });

  try {
    const text = await askClaude({
      label: "step11/ai-explain",
      system: SYSTEM_PROMPT,
      content: [{ type: "text", text: prompt }],
      maxTurns: 1,
      timeoutMs: 90_000,
    });
    return text.trim();
  } catch (err) {
    return `[ai-explainer failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function buildPrompt(args: {
  gameSlug: string;
  provider: string;
  totalSpins: number;
  totalFailures: number;
  failuresByRule: Array<[string, Array<{ roundIndex: number; result: RuleResult }>]>;
  sampleSpins: Array<{
    roundId: string;
    bet: number;
    win: number;
    balanceAfter: number;
    state: string;
  }>;
  statsRtp?: number;
  statsHitRate?: number;
}): string {
  const lines: string[] = [];
  lines.push(`Game: ${args.gameSlug} (${args.provider})`);
  lines.push(`Total spins: ${args.totalSpins}, total rule failures: ${args.totalFailures}`);
  if (args.statsRtp != null) {
    lines.push(`Observed RTP: ${(args.statsRtp * 100).toFixed(2)}%`);
  }
  if (args.statsHitRate != null) {
    lines.push(`Hit rate: ${(args.statsHitRate * 100).toFixed(2)}%`);
  }
  lines.push("");
  lines.push("=== Failures grouped by rule ===");
  for (const [ruleName, samples] of args.failuresByRule) {
    lines.push(`\n### ${ruleName} — ${samples.length} sample(s)`);
    for (const s of samples) {
      lines.push(`- round ${s.roundIndex}: ${s.result.detail ?? "no detail"}`);
      if (s.result.expected != null && s.result.actual != null) {
        lines.push(`  expected: ${JSON.stringify(s.result.expected)}, actual: ${JSON.stringify(s.result.actual)}`);
      }
    }
  }

  if (args.sampleSpins.length > 0) {
    lines.push("\n=== Sample failing spins ===");
    for (const s of args.sampleSpins) {
      lines.push(
        `- roundId=${s.roundId} bet=${s.bet} win=${s.win} balanceAfter=${s.balanceAfter} state=${s.state}`,
      );
    }
  }

  lines.push("\n=== TASK ===");
  lines.push(
    "Write a concise Markdown summary with: (1) Root cause hypothesis, (2) Failure pattern, (3) Suggested fix (one or two actionable bullets). Keep under 250 words. No prose, only Markdown bullets and headers.",
  );
  return lines.join("\n");
}
