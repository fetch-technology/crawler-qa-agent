// Per-game session pool. Replaces the previous single-tenant
// `manualSession` singleton so the server can run auto-onboard / preview-case
// / discover-via against multiple games concurrently (each game gets its own
// browser process per the "N browsers" choice — full isolation, no shared
// CDP, no contention on Playwright page state).
//
// Lookup strategy:
//   - Routes that already carry a `gameSlug` (resume, status?gameSlug, etc.)
//     use it directly.
//   - Routes that don't (start, click, confirm, …) can default via the LRU
//     pointer — useful for backwards-compat dashboards that issue an
//     un-slugged status poll right after a slugged start. The LRU is the
//     last slug that called `markLRU`; routes call it on entry.
//
// Lifecycle:
//   - `getOrCreate(slug)` lazily instantiates a ManualSessionManager on
//     first touch.
//   - `remove(slug)` deletes the entry (caller is responsible for calling
//     manager.stop() / cleanup beforehand if it had a live browser).

import { ManualSessionManager } from "./manual-session.js";

const pool = new Map<string, ManualSessionManager>();
let lastUsedSlug: string | null = null;

// ---- Admission control + start queue ----------------------------------------
// The Mac mini runs under a 7-core cpulimit ceiling (see scripts/qa-server.sh),
// so only ~5 games can ACTIVELY run before everything throttles. We cap the
// number of slot-occupying sessions and queue any further starts FIFO. A slot
// frees when a session is stopped — manually, OR by the idle-reaper below which
// auto-stops an abandoned session (no batch running + idle) to admit a waiting
// game. Backstop: when every slot is genuinely busy (all mid-batch), a queued
// game waits indefinitely (by design) — the dashboard shows its position +
// which games hold the slots.
const MAX_ACTIVE = Math.max(1, Number(process.env.QA_MAX_ACTIVE_SESSIONS ?? 5));
const REAP_IDLE_MS = Math.max(60_000, Number(process.env.QA_REAP_IDLE_MS ?? 5 * 60_000));
const REAPER_INTERVAL_MS = 30_000;

type QueueEntry = { sess: ManualSessionManager; start: () => void; enqueuedAt: number };
const startQueue: QueueEntry[] = [];

/** Sessions counting toward the active cap: holding a browser OR mid-start. */
export function countOccupiedSlots(): number {
  let n = 0;
  for (const m of pool.values()) {
    try { if (m.occupiesSlot()) n++; } catch { /* broken manager — ignore */ }
  }
  return n;
}

export function maxActiveSessions(): number {
  return MAX_ACTIVE;
}

/** gameSlugs of sessions currently holding a slot — shown to a queued QA so
 *  they know who to ask to free one (the queue can wait indefinitely). */
export function occupiedSlugs(): string[] {
  const out: string[] = [];
  for (const [slug, m] of pool.entries()) {
    try { if (m.occupiesSlot()) out.push(slug); } catch { /* ignore */ }
  }
  return out;
}

function refreshQueuePositions(): void {
  startQueue.forEach((e, i) => e.sess.setQueued(i + 1, startQueue.length));
}

/** Admit a start now if there's room, else enqueue it FIFO. `start` is the
 *  thunk that actually kicks the background start (startInBackground) — invoked
 *  immediately when admitted, or later by promoteQueued(). */
export function admitOrQueueStart(
  sess: ManualSessionManager,
  start: () => void,
): { admitted: boolean; position: number } {
  if (countOccupiedSlots() < MAX_ACTIVE) {
    sess.setQueued(null, 0);
    start();
    return { admitted: true, position: 0 };
  }
  startQueue.push({ sess, start, enqueuedAt: Date.now() });
  refreshQueuePositions();
  return { admitted: false, position: startQueue.length };
}

/** Promote queued starts while slots are free. Call after any slot frees. */
export function promoteQueued(): void {
  while (startQueue.length > 0 && countOccupiedSlots() < MAX_ACTIVE) {
    const e = startQueue.shift()!;
    e.sess.setQueued(null, 0);
    // start() flips startInProgress synchronously → occupiesSlot() true on the
    // next loop check, so we never over-admit.
    try { e.start(); } catch (err) { console.error("[session-pool] promote start failed:", err); }
  }
  refreshQueuePositions();
}

/** Drop a session from the queue (e.g. cancelled before promotion). */
export function dequeueStart(sess: ManualSessionManager): boolean {
  const i = startQueue.findIndex((e) => e.sess === sess);
  if (i === -1) return false;
  startQueue.splice(i, 1);
  sess.setQueued(null, 0);
  refreshQueuePositions();
  return true;
}

export function queueLength(): number {
  return startQueue.length;
}

// ---- Batch admission control (run-all-testcases + auto-onboard) --------------
// SEPARATE from the start-queue above. That queue caps how many games hold a
// browser; this one caps how many games concurrently run one of the two
// token-heavy / long batches — `run-all-testcases` and `auto-onboard`. Any
// further batch trigger is queued FIFO and promoted when a running batch
// finishes. Every OTHER operation (generate-catalog, retranslate-all,
// preview-case, start, discover) is ungated. Cap via QA_MAX_ACTIVE_BATCHES
// (default 2). In-memory + single-process — a restart drops the queue, matching
// the start-queue's design.
const MAX_ACTIVE_BATCHES = Math.max(1, Number(process.env.QA_MAX_ACTIVE_BATCHES ?? 2));

export type BatchKind = "run-all" | "auto-onboard";
type BatchQueueEntry = { sess: ManualSessionManager; start: () => void; kind: BatchKind; enqueuedAt: number };
const batchQueue: BatchQueueEntry[] = [];

/** Distinct sessions currently running one of the two gated batches. One game
 *  counts as at most 1 slot — occupiesBatchSlot() is an OR over the two
 *  batch markers, so a game running both batches still uses a single slot. */
export function countActiveBatches(): number {
  let n = 0;
  for (const m of pool.values()) {
    try { if (m.occupiesBatchSlot()) n++; } catch { /* broken manager — ignore */ }
  }
  return n;
}

export function maxActiveBatches(): number {
  return MAX_ACTIVE_BATCHES;
}

/** gameSlugs currently holding a batch slot — shown to a queued QA so they
 *  know which games are running tests (the queue can wait indefinitely). */
export function activeBatchSlugs(): string[] {
  const out: string[] = [];
  for (const [slug, m] of pool.entries()) {
    try { if (m.occupiesBatchSlot()) out.push(slug); } catch { /* ignore */ }
  }
  return out;
}

function refreshBatchQueuePositions(): void {
  batchQueue.forEach((e, i) => e.sess.setBatchQueued(i + 1, batchQueue.length));
}

/** Admit a batch now if under cap, else enqueue it FIFO. `start` is the thunk
 *  that kicks the background batch (runAllTestcasesInBackground /
 *  autoOnboardInBackground) — invoked immediately when admitted, or later by
 *  promoteQueuedBatch(). A session that ALREADY holds a batch slot is admitted
 *  immediately (same slot — one game triggering both batches never self-blocks
 *  or deadlocks). */
export function admitOrQueueBatch(
  sess: ManualSessionManager,
  kind: BatchKind,
  start: () => void,
): { admitted: boolean; position: number } {
  if (sess.occupiesBatchSlot() || countActiveBatches() < MAX_ACTIVE_BATCHES) {
    sess.setBatchQueued(null, 0);
    start();
    return { admitted: true, position: 0 };
  }
  batchQueue.push({ sess, start, kind, enqueuedAt: Date.now() });
  refreshBatchQueuePositions();
  return { admitted: false, position: batchQueue.length };
}

/** Promote queued batches while slots are free. Call after any batch slot
 *  frees (a background batch settled, or a queued game was stopped/deleted). */
export function promoteQueuedBatch(): void {
  while (batchQueue.length > 0 && countActiveBatches() < MAX_ACTIVE_BATCHES) {
    const e = batchQueue.shift()!;
    e.sess.setBatchQueued(null, 0);
    // start() flips the wrapper's batch marker SYNCHRONOUSLY → occupiesBatchSlot()
    // true on the next loop check, so we never over-admit.
    try { e.start(); } catch (err) { console.error("[session-pool] promote batch failed:", err); }
  }
  refreshBatchQueuePositions();
}

/** Drop a session's queued batch (e.g. game stopped/deleted before promotion).
 *  No-op if the session isn't queued. */
export function dequeueBatch(sess: ManualSessionManager): boolean {
  const i = batchQueue.findIndex((e) => e.sess === sess);
  if (i === -1) return false;
  batchQueue.splice(i, 1);
  sess.setBatchQueued(null, 0);
  refreshBatchQueuePositions();
  return true;
}

export function batchQueueLength(): number {
  return batchQueue.length;
}

// Idle-reaper: ONLY runs when games are waiting (reap-on-demand — never kills a
// session when nobody needs the slot). Picks the most-idle reapable session
// (live browser, no batch in progress, idle ≥ REAP_IDLE_MS) and stops it
// (stop() saves state), then promotes the queue. If nothing is reapable (all
// slots mid-batch) the queue simply waits.
async function reapTick(): Promise<void> {
  if (startQueue.length === 0) return;
  if (countOccupiedSlots() < MAX_ACTIVE) { promoteQueued(); return; }
  let victim: ManualSessionManager | null = null;
  let victimSlug: string | null = null;
  let mostIdle = -1;
  for (const [slug, m] of pool.entries()) {
    let idle = -1;
    try { idle = m.reapableIdleMs(REAP_IDLE_MS); } catch { idle = -1; }
    if (idle > mostIdle) { mostIdle = idle; victim = m; victimSlug = slug; }
  }
  if (!victim) return; // nothing reapable → queued game keeps waiting (by design)
  console.log(`[session-pool] reaping idle session "${victimSlug}" (idle ${(mostIdle / 1000).toFixed(0)}s) to free a slot for ${startQueue.length} queued`);
  try { await victim.stop(); } catch (err) { console.error("[session-pool] reap stop failed:", err); }
  promoteQueued();
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;
/** Start the periodic idle-reaper. Call once at server boot. */
export function startReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => { void reapTick().catch(() => undefined); }, REAPER_INTERVAL_MS);
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
}
export function stopReaper(): void {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
}

/** Get the manager for `slug` — creates one on first access. */
export function getOrCreate(slug: string): ManualSessionManager {
  let s = pool.get(slug);
  if (!s) {
    s = new ManualSessionManager();
    pool.set(slug, s);
  }
  lastUsedSlug = slug;
  return s;
}

/** Returns the manager for `slug` without creating one. */
export function get(slug: string): ManualSessionManager | null {
  return pool.get(slug) ?? null;
}

/** Register a pre-constructed manager under `slug`. Used by `start` —
 *  the slug isn't known until the URL is crawled, so the manager is
 *  built transiently first, then registered after start() resolves. */
export function set(slug: string, manager: ManualSessionManager): void {
  pool.set(slug, manager);
  lastUsedSlug = slug;
}

/** Mark slug as most-recently-used. Routes that need a default fallback
 *  consult this. */
export function markLRU(slug: string): void {
  lastUsedSlug = slug;
}

/** Return the most-recently-used manager, or the lone manager if only one
 *  is registered. Throws when ambiguous (multiple sessions, no slug given).
 *  Used by legacy un-slugged routes during the multi-game migration. */
export function getDefaultOrThrow(): ManualSessionManager {
  if (pool.size === 0) {
    // No sessions yet — return a fresh transient manager. Caller will
    // bind it on start(url). LRU stays null until they do.
    const transient = new ManualSessionManager();
    return transient;
  }
  if (pool.size === 1) {
    const only = pool.values().next().value as ManualSessionManager;
    return only;
  }
  if (lastUsedSlug && pool.has(lastUsedSlug)) {
    return pool.get(lastUsedSlug)!;
  }
  throw new Error(
    `multiple manual sessions registered (${pool.size}) — pass gameSlug to disambiguate`,
  );
}

/** List active sessions with their current status snapshot. */
export function listSessions(): Array<{ gameSlug: string; status: ReturnType<ManualSessionManager["status"]> }> {
  const out: Array<{ gameSlug: string; status: ReturnType<ManualSessionManager["status"]> }> = [];
  for (const [slug, mgr] of Array.from(pool.entries())) {
    try { out.push({ gameSlug: slug, status: mgr.status() }); } catch { /* ignore broken managers */ }
  }
  return out;
}

/** Remove the manager from the pool. Caller is responsible for any
 *  cleanup of the underlying browser session BEFORE calling this. */
export function remove(slug: string): boolean {
  const had = pool.delete(slug);
  if (lastUsedSlug === slug) lastUsedSlug = null;
  return had;
}

// ---- Auto-onboard scheduler --------------------------------------------------
// Keeps the auto-onboard pipeline filled: when a batch slot AND a browser slot
// are both free, it opens (resumes) the highest-priority admin-marked game and
// runs auto-onboard on it — unattended. Mirrors the idle-reaper's interval loop.
// Master switch persisted in registry/auto-scheduler-store.ts (default OFF).
//
// Lives here (not manual-session) so it can read countActiveBatches /
// countOccupiedSlots / getOrCreate directly; it reaches manual-session +
// eligibility + meta via lazy dynamic import inside the tick to avoid a static
// import cycle (manual-session already imports nothing from this file at module
// top, and the queue/eligibility modules don't import this one).

const SCHED_INTERVAL_MS = 30_000;
/** Stop auto-retrying a game after this many failed onboard attempts (guards a
 *  tight failure loop). Re-marking (toggle off→on) resets the counter. */
export const MAX_SCHED_ATTEMPTS = 2;

// ---- Claude quota gate -------------------------------------------------------
// Before opening a NEW game to onboard (which burns dozens of Claude calls over
// 30+ min), the scheduler probes the master token's quota. If rate-limited /
// usage-exhausted, it pauses admitting new onboards for a long backoff (limits
// reset on the order of minutes/hours) rather than re-probing every 30s tick.
const QUOTA_BACKOFF_MS = Math.max(60_000, Number(process.env.QA_QUOTA_BACKOFF_MS ?? 20 * 60_000));   // 20 min
const QUOTA_PROBE_TTL_MS = Math.max(30_000, Number(process.env.QA_QUOTA_PROBE_TTL_MS ?? 5 * 60_000)); // trust a good probe this long
let quotaBackoffUntil = 0;   // epoch ms; while now < this, skip admitting new onboards
let quotaProbeOkUntil = 0;   // epoch ms; while now < this, skip re-probing (quota believed OK)
let lastQuotaReason: "rate_limit" | "auth" | "error" | null = null;

/** Current quota-gate state for the dashboard (why new onboards are paused). */
export function getSchedulerQuotaState(): { blockedUntil: number; reason: "rate_limit" | "auth" | "error" | null } {
  return { blockedUntil: quotaBackoffUntil, reason: lastQuotaReason };
}

/** Minimal shape the pure selection helper needs — matches
 *  manual-session.AutoOnboardQueueEntry structurally. */
export type SchedulableGame = {
  gameSlug: string;
  ready: boolean;
  priority: number;
  schedStatus?: "queued" | "running" | "done" | "failed" | "skipped";
  schedAttempts: number;
  eligibility: { ok: boolean; reason?: string };
};

/**
 * PURE selection: given the marked-game queue, an `isActive` predicate (a game
 * already running a batch manually), and the attempts cap, return the next game
 * to auto-onboard, or null. Deterministic (priority asc, then slug). Excludes
 * done/running, attempts-exhausted, currently-active, and still-ineligible
 * skips. Exported for unit testing without disk/browser.
 */
export function selectNextAutoOnboard(
  queue: SchedulableGame[],
  isActive: (slug: string) => boolean,
  maxAttempts: number,
): SchedulableGame | null {
  const candidates = queue
    .filter((g) => g.ready)
    .filter((g) => g.schedStatus !== "done" && g.schedStatus !== "running")
    .filter((g) => g.schedAttempts < maxAttempts)
    .filter((g) => !isActive(g.gameSlug))
    // A game we skipped stays skipped until its eligibility flips to ok —
    // otherwise it'd be re-skipped every tick forever.
    .filter((g) => !(g.schedStatus === "skipped" && !g.eligibility.ok))
    .sort((a, b) => (a.priority - b.priority) || a.gameSlug.localeCompare(b.gameSlug));
  return candidates[0] ?? null;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false; // re-entrancy guard — never overlap while awaiting resume

/** One scheduler pass. Admits ready games up to BOTH caps (batch + session).
 *  Safe to call ad-hoc (e.g. right after enabling, or on batch settle). */
export async function autoOnboardSchedulerTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const { loadSchedulerConfig } = await import("../registry/auto-scheduler-store.js");
    if (!(await loadSchedulerConfig()).enabled) return; // master switch OFF

    const { listAutoOnboardQueue } = await import("./manual-session.js");
    const { setAutoOnboardFlags } = await import("../registry/meta.js");

    await reconcileStaleRunning();

    // Claude quota gate: before opening a NEW game, make sure the master token
    // still has quota. While backing off from a prior rate-limit, do nothing.
    const nowMs = Date.now();
    if (nowMs < quotaBackoffUntil) return;
    if (nowMs >= quotaProbeOkUntil) {
      // Only spend a probe when there's actually a game to admit + a free slot
      // (avoid probing on idle ticks). Peek without mutating anything.
      const slotFree = countActiveBatches() < MAX_ACTIVE_BATCHES && countOccupiedSlots() < MAX_ACTIVE;
      if (slotFree) {
        const peek = selectNextAutoOnboard(
          await listAutoOnboardQueue(),
          (slug) => { const s = get(slug); return !!s && s.hasActiveBatch(); },
          MAX_SCHED_ATTEMPTS,
        );
        if (peek) {
          const { probeClaudeQuota } = await import("../../ai/claude.js");
          const probe = await probeClaudeQuota();
          if (!probe.ok) {
            quotaBackoffUntil = Date.now() + QUOTA_BACKOFF_MS;
            lastQuotaReason = probe.reason ?? "error";
            console.log(`[auto-scheduler] Claude ${probe.reason} — pausing new onboards for ${Math.round(QUOTA_BACKOFF_MS / 60_000)}m (${probe.detail ?? ""})`);
            return;
          }
          quotaProbeOkUntil = Date.now() + QUOTA_PROBE_TTL_MS; // quota OK → skip re-probing for a while
          lastQuotaReason = null;
        }
      }
    }

    // Recompute both counters each iteration: resume() flips occupiesSlot()
    // synchronously and autoOnboardInBackground flips occupiesBatchSlot()
    // synchronously, so the next check reflects the new occupant → no over-admit.
    while (
      countActiveBatches() < MAX_ACTIVE_BATCHES &&
      countOccupiedSlots() < MAX_ACTIVE
    ) {
      const queue = await listAutoOnboardQueue();
      const next = selectNextAutoOnboard(
        queue,
        (slug) => { const s = get(slug); return !!s && s.hasActiveBatch(); },
        MAX_SCHED_ATTEMPTS,
      );
      if (!next) break;

      // Eligibility already computed in the queue entry (disk-only). If not ok,
      // record skipped + reason and move on to the next-priority game.
      if (!next.eligibility.ok) {
        await setAutoOnboardFlags(next.gameSlug, {
          autoOnboardSchedStatus: "skipped",
          autoOnboardSchedReason: next.eligibility.reason,
        });
        continue;
      }

      // Mark running FIRST (before any await) + bump attempts so a later tick
      // can't repick it and a crash leaves a reconcilable marker.
      await setAutoOnboardFlags(next.gameSlug, {
        autoOnboardSchedStatus: "running",
        autoOnboardSchedReason: undefined,
        autoOnboardSchedAttempts: next.schedAttempts + 1,
      });

      const sess = getOrCreate(next.gameSlug);
      try {
        if (!sess.status().active) await sess.resume(next.gameSlug); // unattended browser open
      } catch (err) {
        await setAutoOnboardFlags(next.gameSlug, {
          autoOnboardSchedStatus: "failed",
          autoOnboardSchedReason: `resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        try { await sess.stop(); } catch { /* ignore */ }
        continue;
      }

      const gate = sess.autoOnboardPreflight();
      if (!gate.ok) {
        await setAutoOnboardFlags(next.gameSlug, {
          autoOnboardSchedStatus: "failed",
          autoOnboardSchedReason: gate.reason,
        });
        try { await sess.stop(); } catch { /* ignore */ }
        continue;
      }

      console.log(`[auto-scheduler] onboarding "${next.gameSlug}" (priority ${next.priority}, attempt ${next.schedAttempts + 1})`);
      const slug = next.gameSlug;
      admitOrQueueBatch(sess, "auto-onboard", () =>
        sess.autoOnboardInBackground({}, () => {
          promoteQueuedBatch();          // preserve the HTTP-route behavior
          void onAutoOnboardSettled(slug);
        }));
    }
  } catch (err) {
    console.error("[auto-scheduler] tick failed:", err);
  } finally {
    tickRunning = false;
  }
}

/** Called when a scheduled auto-onboard settles: read its terminal status,
 *  record done/failed in meta, stop the browser to free the session slot, and
 *  kick another tick to pull the next game. */
async function onAutoOnboardSettled(slug: string): Promise<void> {
  const sess = get(slug);
  if (!sess) return;
  const { setAutoOnboardFlags } = await import("../registry/meta.js");
  let failed = false;
  try {
    const st = sess.status();
    failed = st.autoOnboardPhases.some((p) => p.status === "fail")
      || !!st.gameError
      || st.autoOnboardResumeAvailable; // paused/interrupted → not a clean done
  } catch { failed = true; }
  if (failed) {
    await setAutoOnboardFlags(slug, { autoOnboardSchedStatus: "failed", autoOnboardSchedReason: "onboard did not complete cleanly" });
  } else {
    // Done → clear ready so it leaves the queue; keep status for history/UI.
    await setAutoOnboardFlags(slug, { autoOnboardReady: false, autoOnboardSchedStatus: "done", autoOnboardSchedReason: undefined });
  }
  try { await sess.stop(); } catch { /* ignore */ } // free the session slot for the next game
  void autoOnboardSchedulerTick();
}

/** Reconcile games stuck at schedStatus "running" whose session isn't actually
 *  running a batch (process restarted mid-run, or a dropped onSettled). Resets
 *  them to "queued" so the tick can re-run them (attempts already counted).
 *  Runs at the start of every tick as a backstop. */
async function reconcileStaleRunning(): Promise<void> {
  const { listAutoOnboardQueue } = await import("./manual-session.js");
  const { setAutoOnboardFlags } = await import("../registry/meta.js");
  const queue = await listAutoOnboardQueue();
  for (const g of queue) {
    if (g.schedStatus !== "running") continue;
    const s = get(g.gameSlug);
    if (!s || !s.occupiesBatchSlot()) {
      await setAutoOnboardFlags(g.gameSlug, { autoOnboardSchedStatus: "queued", autoOnboardSchedReason: undefined });
    }
  }
}

/** Start the periodic auto-onboard scheduler. Call once at server boot. */
export function startAutoOnboardScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { void autoOnboardSchedulerTick(); }, SCHED_INTERVAL_MS);
  if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
}
export function stopAutoOnboardScheduler(): void {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

/** For tests. */
export function _resetForTest(): void {
  pool.clear();
  lastUsedSlug = null;
  startQueue.length = 0;
  batchQueue.length = 0;
  tickRunning = false;
  quotaBackoffUntil = 0;
  quotaProbeOkUntil = 0;
  lastQuotaReason = null;
  stopReaper();
  stopAutoOnboardScheduler();
}
