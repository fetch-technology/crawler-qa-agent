/**
 * CLI: export balance trace table for a TestRun.
 *
 * Usage:
 *   tsx src/runner/balance-trace-cli.ts <test-run-id> [--format csv|md|json] [--out file]
 *
 * Reads from DB (test_runs + spin_results). Outputs spreadsheet/markdown
 * matching QA sign-off document format.
 */

import { config as loadEnv } from "dotenv";
import { buildTrace, saveTrace, traceToMarkdown } from "./balance-trace-export.js";
import { getTestRun, listSpinResults, disconnectDb, isDbEnabled } from "../db/index.js";

loadEnv();

async function main() {
  const testRunId = process.argv[2];
  if (!testRunId) {
    console.error("Usage: tsx src/runner/balance-trace-cli.ts <test-run-id> [--format csv|md|json] [--out file]");
    process.exit(1);
  }
  if (!isDbEnabled()) {
    console.error("DATABASE_URL not set — balance trace needs DB to read spin_results.");
    process.exit(1);
  }
  const formatIdx = process.argv.indexOf("--format");
  const format = (formatIdx === -1 ? "md" : process.argv[formatIdx + 1] ?? "md") as "csv" | "md" | "json";
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx === -1 ? null : process.argv[outIdx + 1] ?? null;

  const run = await getTestRun(testRunId);
  if (!run) {
    console.error(`TestRun ${testRunId} not found.`);
    process.exit(1);
  }
  const spins = await listSpinResults(testRunId, { limit: 10_000 });
  if (spins.length === 0) {
    console.error(`No spin_results for TestRun ${testRunId} (run hasn't recorded spins).`);
    process.exit(1);
  }
  const rows = buildTrace({
    spins: spins.map((s) => ({
      roundIndex: s.roundIndex,
      balanceBefore: s.balanceBefore,
      totalBet: s.totalBet,
      totalWin: s.totalWin,
      balanceAfter: s.balanceAfter,
    })),
    env: "DB",
    currency: undefined,
    gameUrl: run.url ?? undefined,
  });
  if (outPath) {
    saveTrace(rows, outPath, format);
    console.log(`Saved: ${outPath}`);
  } else {
    if (format === "md") console.log(traceToMarkdown(rows));
    else {
      const { traceToCsv } = await import("./balance-trace-export.js");
      console.log(format === "csv" ? traceToCsv(rows) : JSON.stringify(rows, null, 2));
    }
  }
  const fails = rows.filter((r) => r.status === "FALSE").length;
  console.error(`[meta] ${rows.length} spins, ${rows.length - fails} pass, ${fails} fail`);
  await disconnectDb();
}

main().catch((err) => {
  console.error("balance-trace failed:", err);
  process.exit(1);
});
