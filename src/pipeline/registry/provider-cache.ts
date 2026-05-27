import { loadJson, saveJson, fileExists } from "./io.js";
import type { ProviderCache, RegistryStore } from "./types.js";

export const providerCache: RegistryStore<ProviderCache> = {
  load: (slug) => loadJson<ProviderCache>(slug, "providerCache"),
  save: (slug, data) => saveJson(slug, "providerCache", data),
  exists: (slug) => fileExists(slug, "providerCache"),
};
