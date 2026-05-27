import { loadJson, saveJson, fileExists } from "./io.js";
import { SCHEMA_VERSION } from "./paths.js";
import type { GameSlug, RegistryMeta, RegistryStore } from "./types.js";

export const meta: RegistryStore<RegistryMeta> = {
  load: (slug) => loadJson<RegistryMeta>(slug, "meta"),
  save: (slug, data) => saveJson(slug, "meta", data),
  exists: (slug) => fileExists(slug, "meta"),
};

export async function initMeta(slug: GameSlug, gameUrl: string): Promise<RegistryMeta> {
  const m: RegistryMeta = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    gameUrl,
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
