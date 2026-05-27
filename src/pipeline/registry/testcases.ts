import { loadText, saveText, fileExists } from "./io.js";
import type { GameSlug } from "./types.js";

export const testcases = {
  load: (slug: GameSlug) => loadText(slug, "testcases"),
  save: (slug: GameSlug, yaml: string) => saveText(slug, "testcases", yaml),
  exists: (slug: GameSlug) => fileExists(slug, "testcases"),
};
