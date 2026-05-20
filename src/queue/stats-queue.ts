/**
 * BullMQ queue for distributed statistical simulation jobs.
 *
 * Pattern: producer (CLI or server) enqueues a `stats-batch` job describing
 * N spins for a slug. One or more workers (`npm run worker:stats`) consume
 * jobs, run `simulate()`, return aggregated metrics.
 *
 * Why this beats in-process Promise.all:
 *   - Multi-machine fan-out (run workers on cheap throwaway boxes).
 *   - Server restart safe — pending jobs persist in Redis.
 *   - Observable via BullMQ board / arena.
 *
 * Env: REDIS_URL gates. Without it, this module no-ops and callers should
 * fall back to in-process `simulate()`.
 */

import { Queue, type JobsOptions } from "bullmq";
import { getRedis, isRedisEnabled } from "./redis.js";
import type { SimulateOpts, SimulateResult } from "../statistical/simulate.js";

export const STATS_QUEUE_NAME = "stats-batches";

export type StatsJobData = {
  slug: string;
  spins: number;
  concurrency?: number;
  throttleMs?: number;
  /** Override starting balance / template metadata if needed in the future. */
  meta?: Record<string, unknown>;
};

export type StatsJobReturn = SimulateResult;

let queue: Queue<StatsJobData, StatsJobReturn> | null | undefined;

export function getStatsQueue(): Queue<StatsJobData, StatsJobReturn> | null {
  if (queue !== undefined) return queue;
  if (!isRedisEnabled()) {
    queue = null;
    return null;
  }
  const conn = getRedis();
  if (!conn) {
    queue = null;
    return null;
  }
  queue = new Queue<StatsJobData, StatsJobReturn>(STATS_QUEUE_NAME, { connection: conn });
  return queue;
}

export async function enqueueStatsJob(
  data: StatsJobData,
  opts: JobsOptions = {},
): Promise<string | null> {
  const q = getStatsQueue();
  if (!q) return null;
  const job = await q.add("stats-batch", data, {
    attempts: 1, // statistical jobs are expensive; don't auto-retry whole batch
    removeOnComplete: { age: 86_400, count: 100 },
    removeOnFail: { age: 86_400 * 7 },
    ...opts,
  });
  return job.id ?? null;
}

/** Synchronous-ish helper: enqueue + wait for completion (polls). */
export async function runStatsJob(
  data: StatsJobData,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SimulateResult> {
  const q = getStatsQueue();
  if (!q) throw new Error("REDIS_URL not set — stats queue unavailable");
  const job = await q.add("stats-batch", data, { attempts: 1 });
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await job.getState();
    if (state === "completed") return (await job.returnvalue) as SimulateResult;
    if (state === "failed") {
      const reason = job.failedReason ?? "unknown";
      throw new Error(`stats job failed: ${reason}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`stats job timed out after ${timeoutMs}ms`);
}

export async function closeStatsQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}

// Forward type for ergonomic imports
export type { SimulateOpts, SimulateResult };
