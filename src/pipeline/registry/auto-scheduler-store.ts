// Global (NOT per-game) persistence for the auto-onboard scheduler master
// switch. io.ts / REGISTRY_FILES are keyed per-slug, so this uses node:fs
// directly against a single top-level file under fixtures/registry/.
//
// The `_`-prefixed filename is safe: listRegisteredGames iterates readdir and
// skips any entry without a loadable _meta.json + ui-registry.json, so this
// plain file is never mistaken for a game directory.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "fixtures", "registry");
const FILE = path.join(ROOT, "_auto-scheduler.json");

export type SchedulerConfig = {
  enabled: boolean;
  updatedAt?: string;
};

// In-memory cache so the hot-path scheduler tick + isSchedulerEnabledCached()
// don't hit disk every 30s. Written through on every set.
let cache: SchedulerConfig | null = null;

/** Load config (default OFF on first boot / missing file — safe: nothing runs
 *  unattended until an admin explicitly enables it). Cached after first read. */
export async function loadSchedulerConfig(): Promise<SchedulerConfig> {
  if (cache) return cache;
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerConfig>;
    cache = { enabled: parsed.enabled === true, updatedAt: parsed.updatedAt };
  } catch {
    cache = { enabled: false }; // ENOENT / parse error → default OFF
  }
  return cache;
}

/** Persist the master switch + refresh the cache. */
export async function setSchedulerEnabled(enabled: boolean): Promise<SchedulerConfig> {
  cache = { enabled, updatedAt: new Date().toISOString() };
  await mkdir(ROOT, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
  return cache;
}

/** Synchronous read of the cached value (null cache → false). Callers that
 *  need a guaranteed-fresh value should await loadSchedulerConfig() first. */
export function isSchedulerEnabledCached(): boolean {
  return cache?.enabled ?? false;
}

/** For tests. */
export function _resetSchedulerConfigForTest(): void {
  cache = null;
}
