import { loadJson, saveJson, fileExists } from "./io.js";
import { SCHEMA_VERSION } from "./paths.js";
import type { GameSlug, RegistryMeta, RegistryStore } from "./types.js";

export const meta: RegistryStore<RegistryMeta> = {
  load: (slug) => loadJson<RegistryMeta>(slug, "meta"),
  save: (slug, data) => saveJson(slug, "meta", data),
  exists: (slug) => fileExists(slug, "meta"),
};

export async function initMeta(
  slug: GameSlug,
  gameUrl: string,
  extra: Partial<Omit<RegistryMeta, "schemaVersion" | "createdAt" | "gameUrl">> = {},
): Promise<RegistryMeta> {
  const m: RegistryMeta = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    gameUrl,
    ...extra,
  };
  await meta.save(slug, m);
  return m;
}

export async function touchValidated(slug: GameSlug): Promise<void> {
  const current = await meta.load(slug);
  if (!current) return;
  current.lastValidatedAt = new Date().toISOString();
  await meta.save(slug, current);
}

/** Single write-path for all auto-onboard-scheduler meta fields (read-modify-
 *  write, mirrors touchValidated). Always stamps autoOnboardSchedAt. Returns
 *  the updated record, or null when the game has no _meta.json. */
export async function setAutoOnboardFlags(
  slug: GameSlug,
  patch: Partial<Pick<RegistryMeta,
    | "autoOnboardReady"
    | "autoOnboardPriority"
    | "autoOnboardSchedStatus"
    | "autoOnboardSchedReason"
    | "autoOnboardSchedAttempts">>,
): Promise<RegistryMeta | null> {
  const current = await meta.load(slug);
  if (!current) return null;
  Object.assign(current, patch, { autoOnboardSchedAt: new Date().toISOString() });
  await meta.save(slug, current);
  return current;
}
