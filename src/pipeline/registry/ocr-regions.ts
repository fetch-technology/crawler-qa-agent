import { loadJson, saveJson, fileExists } from "./io.js";
import type { OcrRegions, RegistryStore } from "./types.js";

export const ocrRegions: RegistryStore<OcrRegions> = {
  load: (slug) => loadJson<OcrRegions>(slug, "ocrRegions"),
  save: (slug, data) => saveJson(slug, "ocrRegions", data),
  exists: (slug) => fileExists(slug, "ocrRegions"),
};
