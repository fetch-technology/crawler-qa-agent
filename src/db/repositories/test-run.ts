/**
 * test_runs repository — create + status updates.
 *
 * All functions accept env-gated client and no-op when DB is disabled.
 */

import { getDb } from "../client.js";

export type TestRunInput = {
  id?: string;
  gameCode: string;
  url?: string | null;
  status?: string;
  totalSpins?: number;
  betPerLine?: number | null;
  lines?: number | null;
};

export async function createTestRun(args: TestRunInput): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const row = await db.testRun.create({
    data: {
      id: args.id,
      gameCode: args.gameCode,
      url: args.url ?? null,
      status: args.status ?? "queued",
      totalSpins: args.totalSpins ?? 0,
      betPerLine: args.betPerLine ?? null,
      lines: args.lines ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Idempotent variant — used when caller has a stable external id (e.g. server
 * Task.id) and may re-run the task. Updates `status`, `startedAt`, and
 * `totalSpins` while preserving createdAt + existing children.
 */
export async function upsertTestRun(
  args: TestRunInput & { id: string },
): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const data = {
    gameCode: args.gameCode,
    url: args.url ?? null,
    status: args.status ?? "queued",
    totalSpins: args.totalSpins ?? 0,
    betPerLine: args.betPerLine ?? null,
    lines: args.lines ?? null,
  };
  const row = await db.testRun.upsert({
    where: { id: args.id },
    create: { id: args.id, ...data },
    update: data,
    select: { id: true },
  });
  return row.id;
}

export async function updateTestRunStatus(
  id: string,
  patch: {
    status?: string;
    completedSpins?: number;
    startedAt?: Date | null;
    endedAt?: Date | null;
    summaryMd?: string | null;
  },
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.testRun.update({
    where: { id },
    data: patch,
  });
}

export async function getTestRun(id: string) {
  const db = getDb();
  if (!db) return null;
  return db.testRun.findUnique({
    where: { id },
    include: { statReport: true, _count: { select: { spinResults: true, validationErrors: true } } },
  });
}

/** Delete one TestRun (cascades to spins/errors/statReport via FK). */
export async function deleteTestRun(id: string): Promise<{ ok: boolean; deletedId?: string }> {
  const db = getDb();
  if (!db) return { ok: false };
  try {
    await db.testRun.delete({ where: { id } });
    return { ok: true, deletedId: id };
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return { ok: false }; // not found
    throw err;
  }
}

/** Delete all TestRuns for a game (cascades). Returns count deleted. */
export async function deleteTestRunsByGame(gameCode: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const r = await db.testRun.deleteMany({ where: { gameCode } });
  return r.count;
}

/** Nuke ALL TestRuns (and cascade children). Returns count. */
export async function deleteAllTestRuns(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const r = await db.testRun.deleteMany({});
  return r.count;
}

/** Wipe child rows (spins + errors + stat report) before re-running. */
export async function clearTestRunChildren(id: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.$transaction([
    db.spinResult.deleteMany({ where: { testRunId: id } }),
    db.validationError.deleteMany({ where: { testRunId: id } }),
    db.statReport.deleteMany({ where: { testRunId: id } }),
  ]);
}

export async function listTestRuns(opts: { gameCode?: string; limit?: number } = {}) {
  const db = getDb();
  if (!db) return [];
  return db.testRun.findMany({
    where: opts.gameCode ? { gameCode: opts.gameCode } : undefined,
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    include: { statReport: true, _count: { select: { spinResults: true, validationErrors: true } } },
  });
}
