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
}
