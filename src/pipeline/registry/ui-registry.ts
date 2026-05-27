import { loadJson, saveJson, fileExists } from "./io.js";
import type { GameSlug, RegistryStore, UiElement, UiRegistry } from "./types.js";

export const uiRegistry: RegistryStore<UiRegistry> = {
  load: (slug) => loadJson<UiRegistry>(slug, "uiRegistry"),
  save: (slug, data) => saveJson(slug, "uiRegistry", data),
  exists: (slug) => fileExists(slug, "uiRegistry"),
};

export async function updateElement(
  slug: GameSlug,
  key: keyof UiRegistry,
  element: UiElement,
): Promise<void> {
  const current = (await uiRegistry.load(slug)) ?? {};
  current[key] = element;
  await uiRegistry.save(slug, current);
}
