/**
 * Pre-game attempt logger — append-only JSONL stats for each pre-game run.
 *
 * Each invocation of `preGameWithReplayOrVision` writes one line. Lets us
 * answer:
 *   - What % of runs used replay vs. fell back to vision?
 *   - Which slugs have brittle baselines (high fallback rate)?
 *   - How long does replay take vs. vision?
 *
 * File: fixtures/pre-game/_stats.jsonl (append-only — never re-written)
 *
 * Aggregation is computed on read, not on write — keeps the hot path cheap.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PreGameAttempt = {
  ts: string;
  slug: string;
  /** Path taken. */
  source: "replay" | "vision";
  /** Final outcome. */
  ready: boolean;
  /** Detail string from underlying engine. */
  reason: string;
  /** Wall-clock duration of the attempt (ms). */
  duration_ms: number;
  /** Replay-specific: pixel diff ratio when verification ran. */
  replay_diff_ratio?: number | null;
  /** Replay-specific: number of clicks fired before exit. */
  replay_clicks_fired?: number;
  /** Vision-specific: number of LLM iterations needed. */
  vision_iterations?: number;
  /** Vision-specific: blockers dismissed. */
  vision_dismissed?: number;
  /** True nếu vision ran AFTER replay failed (auto-fallback). */
  is_fallback?: boolean;
  /** True nếu baseline đã được auto-re-captured trong attempt này. */
  auto_healed?: boolean;
};

const STATS_PATH = join("fixtures", "pre-game", "_stats.jsonl");

export function logPreGameAttempt(attempt: PreGameAttempt): void {
  try {
    mkdirSync(dirname(STATS_PATH), { recursive: true });
    appendFileSync(STATS_PATH, JSON.stringify(attempt) + "\n");
  } catch (err) {
    console.warn(`[pre-game-stats] log failed:`, (err as Error).message);
  }
}

export type PreGameAggregate = {
  slug: string;
  total: number;
  ready: number;
  notReady: number;
  bySource: Record<"replay" | "vision", number>;
  /** Vision invocations that happened because replay failed first. */
  fallbacks: number;
  /** % of total attempts that needed vision. */
  visionRate: number;
  /** % of total attempts where replay alone succeeded. */
  replaySuccessRate: number;
  avgDurationMs: { replay: number | null; vision: number | null };
  /** Most recent attempt timestamp. */
  lastAttemptAt: string | null;
  /** Last 5 attempts (most recent first). */
  recent: PreGameAttempt[];
};

export function readAllAttempts(): PreGameAttempt[] {
  if (!existsSync(STATS_PATH)) return [];
  const lines = readFileSync(STATS_PATH, "utf8").split("\n").filter(Boolean);
  const out: PreGameAttempt[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

export function aggregatePreGameStats(slug?: string): PreGameAggregate[] {
  const all = readAllAttempts();
  const filtered = slug ? all.filter((a) => a.slug === slug) : all;
  const bySlug = new Map<string, PreGameAttempt[]>();
  for (const a of filtered) {
    const arr = bySlug.get(a.slug) ?? [];
    arr.push(a);
    bySlug.set(a.slug, arr);
  }
  const out: PreGameAggregate[] = [];
  for (const [s, attempts] of bySlug) {
    attempts.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const total = attempts.length;
    const ready = attempts.filter((a) => a.ready).length;
    const replays = attempts.filter((a) => a.source === "replay");
    const visions = attempts.filter((a) => a.source === "vision");
    const fallbacks = visions.filter((a) => a.is_fallback === true).length;
    const avg = (arr: PreGameAttempt[]) =>
      arr.length === 0 ? null : arr.reduce((sum, x) => sum + x.duration_ms, 0) / arr.length;
    out.push({
      slug: s,
      total,
      ready,
      notReady: total - ready,
      bySource: { replay: replays.length, vision: visions.length },
      fallbacks,
      visionRate: total > 0 ? visions.length / total : 0,
      replaySuccessRate: total > 0 ? replays.filter((r) => r.ready).length / total : 0,
      avgDurationMs: { replay: avg(replays), vision: avg(visions) },
      lastAttemptAt: attempts[0]?.ts ?? null,
      recent: attempts.slice(0, 5),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}
