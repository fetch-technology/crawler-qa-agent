import { loadJson, saveJson, fileExists } from "./io.js";
import type { FieldMapping, RegistryStore } from "./types.js";

export const fieldMapping: RegistryStore<FieldMapping> = {
  load: (slug) => loadJson<FieldMapping>(slug, "fieldMapping"),
  save: (slug, data) => saveJson(slug, "fieldMapping", data),
  exists: (slug) => fileExists(slug, "fieldMapping"),
};
