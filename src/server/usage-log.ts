// Per-QA AI usage logging. Each askClaude call appends a JSONL row to
// `fixtures/usage/<YYYY-MM-DD>.jsonl` with the QA's token hash, label,
// approximate token counts, and timestamp. Dashboard reads aggregates
// to show "Your Usage today" per QA.
//
// Privacy: only the SHA-256 hash prefix of the token is stored — never
// the raw token. Aggregation is per-hash so different QAs see only their
// own numbers (Phase 5 dashboard endpoint filters by current request's
// qaHash). Master-fallback calls (no QA header) log under qaHash="master"
// so admin can see catch-all usage too.

import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const USAGE_DIR = path.join("fixtures", "usage");

export type UsageEntry = {
  /** Wall-clock ISO timestamp. */
  at: string;
  /** SHA-256(token).slice(0,8). "master" for fallback master env calls. */
  qaHash: string;
  /** Diagnostic label (matches askClaude({ label }) — e.g. "catalog/PLAN"). */
  label: string;
  /** Approximate input tokens (chars/3.5 heuristic — actual count not
   *  exposed by agent SDK). */
  estInputTokens: number;
  /** Approximate output tokens (response.length/3.5). */
  estOutputTokens: number;
  /** Total response chars — useful for sanity-checking estOutputTokens
   *  if model behavior shifts. */
  outputChars: number;
  /** ms wall-clock for this call. */
  durationMs: number;
  /** Whether the call succeeded. Failed calls still cost tokens for the
   *  prompt; logging them lets QA see "I spent $X but got errors". */
  ok: boolean;
};

/** Today's log file path. Rotates daily — small enough to scan in <100ms
 *  even with hundreds of calls per QA per day. */
function todayLogPath(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return path.join(USAGE_DIR, `${y}-${m}-${day}.jsonl`);
}

/** Append one usage entry. Non-fatal on write failure — usage logging
 *  shouldn't block actual AI calls. Logs warning + drops the row. */
export async function logUsage(entry: UsageEntry): Promise<void> {
  try {
    await mkdir(USAGE_DIR, { recursive: true });
    await appendFile(todayLogPath(), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`[usage-log] append failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type UsageAggregate = {
  qaHash: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  estInputTokens: number;
  estOutputTokens: number;
  totalChars: number;
  totalMs: number;
  /** Top labels by call count (for "what's eating my tokens?" insight). */
  topLabels: Array<{ label: string; calls: number; estTokens: number }>;
  /** ISO range covered by this aggregate. */
  fromAt: string | null;
  toAt: string | null;
};

/** Aggregate usage for one qaHash over the last `dayCount` days (default
 *  1 = today only). Returns null when no entries match. */
export async function aggregateUsage(
  qaHash: string,
  dayCount: number = 1,
): Promise<UsageAggregate> {
  const summary: UsageAggregate = {
    qaHash,
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    estInputTokens: 0,
    estOutputTokens: 0,
    totalChars: 0,
    totalMs: 0,
    topLabels: [],
    fromAt: null,
    toAt: null,
  };
  const labelCounts = new Map<string, { calls: number; estTokens: number }>();
  try {
    const files = (await readdir(USAGE_DIR).catch(() => []))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-Math.max(1, dayCount));
    for (const f of files) {
      let raw: string;
      try { raw = await readFile(path.join(USAGE_DIR, f), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: UsageEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.qaHash !== qaHash) continue;
        summary.totalCalls++;
        if (e.ok) summary.successCalls++;
        else summary.failedCalls++;
        summary.estInputTokens += e.estInputTokens || 0;
        summary.estOutputTokens += e.estOutputTokens || 0;
        summary.totalChars += e.outputChars || 0;
        summary.totalMs += e.durationMs || 0;
        if (!summary.fromAt || e.at < summary.fromAt) summary.fromAt = e.at;
        if (!summary.toAt || e.at > summary.toAt) summary.toAt = e.at;
        const lc = labelCounts.get(e.label) ?? { calls: 0, estTokens: 0 };
        lc.calls++;
        lc.estTokens += (e.estInputTokens || 0) + (e.estOutputTokens || 0);
        labelCounts.set(e.label, lc);
      }
    }
  } catch (err) {
    console.warn(`[usage-log] aggregate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  summary.topLabels = Array.from(labelCounts.entries())
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  return summary;
}
