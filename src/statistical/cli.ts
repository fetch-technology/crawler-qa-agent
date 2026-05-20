/**
 * CLI cho statistical simulator.
 *
 * Usage:
 *   tsx src/statistical/cli.ts <slug> --spins 10000
 *   tsx src/statistical/cli.ts <slug> --spins 100000 --concurrency 8 --throttle 5
 *
 * Output JSON tóm tắt vào fixtures/statistical/{slug}-{timestamp}.json + print
 * human-readable report ra stdout.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, simulate, TokenExpiredError, type SimulateOpts } from "./simulate.js";
import {
  createTestRun,
  disconnectDb,
  isDbEnabled,
  insertValidationErrors,
  updateTestRunStatus,
  upsertStatReport,
} from "../db/index.js";
import { isRedisEnabled, closeRedis } from "../queue/redis.js";
import { runStatsJob, closeStatsQueue } from "../queue/stats-queue.js";
import { existsSync, readFileSync } from "node:fs";
import type { GameSpec } from "../ai/authoring.js";

function loadSpec(slug: string): GameSpec | null {
  const p = `fixtures/specs/${slug}/${slug}.spec.json`;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GameSpec;
  } catch {
    return null;
  }
}

function parseFlag(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const slug = positional[0];
  if (!slug || process.argv.includes("--help")) {
    console.log(`
Statistical simulator — fire mass spins to verify RTP / hit frequency / win distribution.

Usage:
  tsx src/statistical/cli.ts <slug> [options]

Options:
  --spins <N>        Number of spins to fire (default 1000)
  --concurrency <N>  Parallel in-flight requests (default 4)
  --throttle <ms>    Min ms between requests per worker (default 10)
  --progress <N>     Log every N spins (default 100)
  --debug [N]        Dump first N (default 5) raw request/response pairs to
                     fixtures/statistical/{slug}-{ts}-debug/ + report unique-body
                     count. Use to diagnose "server returns same body 1000×".
  --no-consistency   Disable per-spin assertPayoutMatchesPaytable check
  --extract-scenarios
                     Auto-classify each spin and save rare labels
                     (bonus_trigger, free_spin, big_win, max_win) as scenario
                     fixtures to fixtures/scenarios/{slug}/. Doesn't overwrite.
  --overwrite-scenarios
                     With --extract-scenarios, force-overwrite existing files.
  --history-audit    After sim, fetch game's history endpoint and verify each
                     recorded round matches this sim's bet/win/balance.
                     Catches server-side audit log bugs.

Output:
  fixtures/statistical/{slug}-{ISO}.json + human-readable report on stdout.

Pre-requisite:
  fixtures/recordings/{slug}__*/  must exist (run \`npm run record\` first).
  Token in recorded URL must still be valid (most expire 24h–7d).
`);
    return;
  }

  const noConsistency = process.argv.includes("--no-consistency");
  const spec = noConsistency ? null : loadSpec(slug);
  // --debug or --debug N → dump first N request/response pairs for inspection
  const debugIdx = process.argv.indexOf("--debug");
  const dumpResponses =
    debugIdx === -1
      ? null
      : (() => {
          const next = process.argv[debugIdx + 1];
          const n = next && !next.startsWith("-") ? Number(next) : 5;
          return Number.isFinite(n) && n > 0 ? n : 5;
        })();
  const extractScenarios = process.argv.includes("--extract-scenarios");
  const overwriteScenarios = process.argv.includes("--overwrite-scenarios");
  const historyAudit = process.argv.includes("--history-audit");
  const opts: SimulateOpts = {
    slug,
    spins: parseFlag("--spins", 1_000),
    concurrency: parseFlag("--concurrency", 4),
    throttleMs: parseFlag("--throttle", 10),
    progressEvery: parseFlag("--progress", 100),
    spec,
    dumpResponses,
    extractScenarios,
    overwriteScenarios,
    historyAudit,
  };
  if (extractScenarios) {
    console.log(`[stats] scenario discovery ON — interesting labels (bonus_trigger/free_spin/big_win/max_win) auto-saved${overwriteScenarios ? " (OVERWRITE existing)" : ""}`);
  }

  console.log(`[stats] slug=${opts.slug} spins=${opts.spins} concurrency=${opts.concurrency} throttle=${opts.throttleMs}ms`);
  if (spec) {
    console.log(`[stats] consistency check ON (spec loaded — server bugs will be flagged per-spin)`);
  } else if (noConsistency) {
    console.log(`[stats] consistency check OFF (--no-consistency flag)`);
  } else {
    console.log(`[stats] consistency check OFF (no spec at fixtures/specs/${slug}/${slug}.spec.json — run Collect first)`);
  }

  // Optional DB write-through (env-gated by DATABASE_URL)
  let testRunId: string | null = null;
  if (isDbEnabled()) {
    testRunId = await createTestRun({
      gameCode: opts.slug,
      status: "running",
      totalSpins: opts.spins,
    });
    if (testRunId) {
      await updateTestRunStatus(testRunId, { startedAt: new Date() });
      console.log(`[stats] DB TestRun created: ${testRunId}`);
    }
  }

  // Distribute via BullMQ when REDIS_URL is set and --queue flag passed.
  const useQueue = process.argv.includes("--queue") && isRedisEnabled();
  let result;
  try {
    if (useQueue) {
      console.log(`[stats] dispatching to BullMQ queue (REDIS_URL set, --queue flag)`);
      result = await runStatsJob({
        slug: opts.slug,
        spins: opts.spins,
        concurrency: opts.concurrency,
        throttleMs: opts.throttleMs,
      });
    } else {
      result = await simulate(opts);
    }
  } catch (err) {
    if (testRunId) {
      await updateTestRunStatus(testRunId, {
        status: "failed",
        endedAt: new Date(),
      });
    }
    throw err;
  }

  console.log("\n" + formatReport(result));

  // Persist filesystem (unchanged)
  const outDir = "fixtures/statistical";
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `${slug}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nReport saved: ${outPath}`);

  // Persist DB stat report
  if (testRunId) {
    await upsertStatReport({
      testRunId,
      totalSpins: result.spinsSuccessful,
      totalBet: result.totalBet,
      totalWin: result.totalWin,
      rtp: result.observedRTP,
      hitRate: result.hitFrequency,
      maxWin: result.maxWin,
      averageWin: result.averageWin,
      volatility: result.volatility,
      volatilityBand: result.volatilityBand,
      rtpConfidence95: result.rtpConfidence95,
      metrics: {
        featureFrequency: result.featureFrequency,
        symbolDistribution: result.symbolDistribution,
        winDistribution: result.winDistribution,
        maxWinMultiplier: result.maxWinMultiplier,
        consistency: result.consistency,
      },
    });
    // Persist per-mismatch validation errors (capped) so dashboard can drill down.
    if (result.consistency && result.consistency.examples.length > 0) {
      await insertValidationErrors(
        result.consistency.examples.map((ex) => ({
          testRunId,
          errorType: "PAYOUT_MISMATCH",
          severity: "error" as const,
          expectedValue: ex.expected.toFixed(4),
          actualValue: ex.actual.toFixed(4),
          message: `spin#${ex.spinIndex}: server=${ex.actual.toFixed(4)} vs rule-engine=${ex.expected.toFixed(4)} (Δ=${ex.delta.toFixed(4)}) reels=${ex.reels.slice(0, 30)}`,
        })),
      );
      console.log(`[stats] DB: ${result.consistency.examples.length} payout mismatches recorded → validation_errors`);
    }
    await updateTestRunStatus(testRunId, {
      status: "completed",
      completedSpins: result.spinsSuccessful,
      endedAt: new Date(),
    });
    console.log(`[stats] DB updated: TestRun ${testRunId} + StatReport`);
  }
  await disconnectDb();
  await closeStatsQueue();
  await closeRedis();
}

main().catch((err) => {
  if (err instanceof TokenExpiredError) {
    console.error("\n❌ Token expired:\n" + err.message);
    process.exit(2); // distinct exit code cho automation tooling
  }
  console.error("simulate failed:", err);
  process.exit(1);
});
