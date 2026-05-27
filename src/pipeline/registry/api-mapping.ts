import { loadJson, saveJson, fileExists } from "./io.js";
import type { ApiMapping, RegistryStore } from "./types.js";

export const apiMapping: RegistryStore<ApiMapping> = {
  load: (slug) => loadJson<ApiMapping>(slug, "apiMapping"),
  save: (slug, data) => saveJson(slug, "apiMapping", data),
  exists: (slug) => fileExists(slug, "apiMapping"),
};
