/**
 * CLI: generate a bug-summary Markdown report for a TestRun.
 *
 * Usage:
 *   tsx src/ai/bug-summarizer-cli.ts <test-run-id> [--out report.md]
 *
 * Requires DATABASE_URL to read validation errors. If LLM creds are absent,
 * falls back to a deterministic skeleton summary (no Claude call).
 */

import { writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { summarizeBugs } from "./bug-summarizer.js";
import { disconnectDb, isDbEnabled } from "../db/client.js";

loadEnv();

async function main() {
  const testRunId = process.argv[2];
  if (!testRunId) {
    console.error("Usage: tsx src/ai/bug-summarizer-cli.ts <test-run-id> [--out report.md]");
    process.exit(1);
  }
  if (!isDbEnabled()) {
    console.error("DATABASE_URL not set — bug summary needs DB to read errors.");
    process.exit(1);
  }
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

  const summary = await summarizeBugs({ testRunId });
  if (outPath) {
    writeFileSync(outPath, summary.markdown);
    console.log(`Saved: ${outPath}`);
  } else {
    console.log(summary.markdown);
  }
  console.log(
    `\n[meta] source=${summary.source} groups=${summary.groupCounts.length} errors=${summary.groupCounts.reduce(
      (a, b) => a + b.count,
      0,
    )}`,
  );
  await disconnectDb();
}

main().catch((err) => {
  console.error("bug-summary failed:", err);
  process.exit(1);
});
