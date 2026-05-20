/**
 * Server-side DB write-through helpers.
 *
 * Maps `Task` + spin events + case results from the in-memory queue to the
 * PostgreSQL schema (test_runs, spin_results, validation_errors, stat_reports).
 *
 * All functions are env-gated and no-op when DATABASE_URL is unset, so the
 * runner doesn't need conditional branches.
 *
 * Lifecycle:
 *   onRunPhaseStart  — upsert TestRun + clear children (idempotent retry)
 *   onSpinEvent      — append SpinResult
 *   onCaseEnd        — append ValidationError when status=failed
 *   onTaskComplete   — upsert StatReport + set status/endedAt
 */

import {
  upsertTestRun,
  clearTestRunChildren,
  updateTestRunStatus,
  insertSpinResults,
  insertValidationErrors,
  upsertStatReport,
  isDbEnabled,
} from "../db/index.js";
import type { CaseResult, Task, TaskSpinEvent } from "./types.js";

export async function onRunPhaseStart(task: Task): Promise<void> {
  if (!isDbEnabled()) return;
  try {
    await upsertTestRun({
      id: task.id,
      gameCode: task.gameSlug,
      url: task.gameUrl,
      status: "running",
      totalSpins: task.spinsPerTest ?? 0,
    });
    await clearTestRunChildren(task.id);
    await updateTestRunStatus(task.id, { startedAt: new Date() });
  } catch (err) {
    console.warn(`[db-writethrough] onRunPhaseStart failed for ${task.id}:`, (err as Error).message);
  }
}

export async function onSpinEvent(taskId: string, gameSlug: string, ev: TaskSpinEvent): Promise<void> {
  if (!isDbEnabled()) return;
  try {
    await insertSpinResults([
      {
        testRunId: taskId,
        roundIndex: ev.spinNumber,
        gameCode: gameSlug,
        totalBet: ev.betAmount ?? 0,
        totalWin: ev.winAmount ?? 0,
        balanceBefore: ev.balanceBefore,
        balanceAfter: ev.balanceAfter ?? 0,
        isFreeSpin: false,
        hasBonus: false,
      },
    ]);
  } catch (err) {
    console.warn(`[db-writethrough] onSpinEvent failed for ${taskId}:`, (err as Error).message);
  }
}

export async function onCaseEnd(taskId: string, caseId: string, result: CaseResult): Promise<void> {
  if (!isDbEnabled()) return;
  if (result.status !== "failed") return;
  try {
    await insertValidationErrors([
      {
        testRunId: taskId,
        errorType: result.errorCategory ?? "case_failed",
        severity: "error",
        message:
          result.errorTitle ??
          result.errorSummary ??
          (result.error ? String(result.error).split("\n")[0]!.slice(0, 500) : `Case ${caseId} failed`),
        expectedValue: null,
        actualValue: null,
      },
    ]);
  } catch (err) {
    console.warn(`[db-writethrough] onCaseEnd failed for ${taskId}:`, (err as Error).message);
  }
}

export async function onTaskComplete(
  task: Task,
  args: {
    status: "completed" | "failed" | "cancelled";
    endedAt: Date;
  },
): Promise<void> {
  if (!isDbEnabled()) return;
  try {
    // Persist final status + stats
    const summary = task.summary;
    const stats = task.caseStats;
    await updateTestRunStatus(task.id, {
      status: args.status,
      endedAt: args.endedAt,
      completedSpins: summary?.spinCount ?? 0,
    });

    // Upsert StatReport if we have any spin data. Volatility/RTP CI are not
    // tracked at the per-task level (the harness doesn't compute them — only
    // statistical CLI does), so they stay null here. The Stat Report row is
    // still useful to link case stats + totals to the run.
    if (summary && summary.spinCount > 0) {
      await upsertStatReport({
        testRunId: task.id,
        totalSpins: summary.spinCount,
        totalBet: summary.totalBet,
        totalWin: summary.totalWin,
        rtp: summary.rtp,
        hitRate: null,
        maxWin: null,
        averageWin: null,
        volatility: null,
        volatilityBand: null,
        rtpConfidence95: null,
        metrics: {
          source: "server-runner",
          caseStats: stats ?? null,
          phase: task.nextPhase ?? "run",
        },
      });
    }
  } catch (err) {
    console.warn(`[db-writethrough] onTaskComplete failed for ${task.id}:`, (err as Error).message);
  }
}
