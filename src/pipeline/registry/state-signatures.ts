import { loadJson, saveJson, fileExists } from "./io.js";
import type { RegistryStore, StateSignatures } from "./types.js";

export const stateSignatures: RegistryStore<StateSignatures> = {
  load: (slug) => loadJson<StateSignatures>(slug, "stateSignatures"),
  save: (slug, data) => saveJson(slug, "stateSignatures", data),
  exists: (slug) => fileExists(slug, "stateSignatures"),
};
