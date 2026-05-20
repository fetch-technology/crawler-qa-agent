/**
 * BullMQ worker that consumes `stats-batches` jobs and runs `simulate()`.
 *
 * Run as a standalone process:
 *   REDIS_URL=redis://localhost:6380 npm run worker:stats
 *
 * Scale by running N processes (each gets its own job).
 */

import { Worker } from "bullmq";
import { config as loadEnv } from "dotenv";
import { simulate } from "../statistical/simulate.js";
import { STATS_QUEUE_NAME, type StatsJobData, type StatsJobReturn } from "./stats-queue.js";
import { getRedis, isRedisEnabled, closeRedis } from "./redis.js";
import { disconnectDb } from "../db/client.js";

loadEnv();

if (!isRedisEnabled()) {
  console.error("REDIS_URL not set — worker cannot start. Set REDIS_URL=redis://localhost:6380");
  process.exit(1);
}

const conn = getRedis()!;
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);

console.log(`[stats-worker] starting concurrency=${concurrency} queue=${STATS_QUEUE_NAME}`);

const worker = new Worker<StatsJobData, StatsJobReturn>(
  STATS_QUEUE_NAME,
  async (job) => {
    console.log(`[stats-worker] picked job ${job.id} slug=${job.data.slug} spins=${job.data.spins}`);
    const t0 = Date.now();
    const result = await simulate({
      slug: job.data.slug,
      spins: job.data.spins,
      concurrency: job.data.concurrency ?? 4,
      throttleMs: job.data.throttleMs ?? 10,
      preflightTokenCheck: true,
    });
    console.log(
      `[stats-worker] job ${job.id} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — RTP=${
        result.observedRTP != null ? (result.observedRTP * 100).toFixed(2) + "%" : "n/a"
      }`,
    );
    return result;
  },
  { connection: conn, concurrency },
);

worker.on("failed", (job, err) => {
  console.error(`[stats-worker] job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job) => {
  console.log(`[stats-worker] job ${job.id} completed`);
});

process.on("SIGINT", async () => {
  console.log("\n[stats-worker] SIGINT — closing");
  await worker.close();
  await disconnectDb();
  await closeRedis();
  process.exit(0);
});
