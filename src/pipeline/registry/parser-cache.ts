import { loadJson, saveJson, fileExists } from "./io.js";
import type { ParserCache, RegistryStore } from "./types.js";

export const parserCache: RegistryStore<ParserCache> = {
  load: (slug) => loadJson<ParserCache>(slug, "parserCache"),
  save: (slug, data) => saveJson(slug, "parserCache", data),
  exists: (slug) => fileExists(slug, "parserCache"),
};
