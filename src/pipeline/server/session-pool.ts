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

/** For tests. */
export function _resetForTest(): void {
  pool.clear();
  lastUsedSlug = null;
  startQueue.length = 0;
  stopReaper();
}
