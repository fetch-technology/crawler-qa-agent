import { loadJson, saveJson, fileExists } from "./io.js";
import type { PopupRegions, RegistryStore } from "./types.js";

export const popupRegions: RegistryStore<PopupRegions> = {
  load: (slug) => loadJson<PopupRegions>(slug, "popupRegions"),
  save: (slug, data) => saveJson(slug, "popupRegions", data),
  exists: (slug) => fileExists(slug, "popupRegions"),
};
