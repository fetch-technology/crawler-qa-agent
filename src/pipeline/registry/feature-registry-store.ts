import { loadJson, saveJson, fileExists } from "./io.js";
import type { GameSlug, RegistryStore } from "./types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";

export const featureRegistry: RegistryStore<FeatureRegistry> = {
  load: (slug: GameSlug) => loadJson<FeatureRegistry>(slug, "featureRegistry"),
  save: (slug: GameSlug, data) => saveJson(slug, "featureRegistry", data),
  exists: (slug: GameSlug) => fileExists(slug, "featureRegistry"),
};
