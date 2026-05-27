import { loadJson, saveJson, fileExists } from "./io.js";
import type { Paytable, RegistryStore } from "./types.js";

export const paytable: RegistryStore<Paytable> = {
  load: (slug) => loadJson<Paytable>(slug, "paytable"),
  save: (slug, data) => saveJson(slug, "paytable", data),
  exists: (slug) => fileExists(slug, "paytable"),
};
