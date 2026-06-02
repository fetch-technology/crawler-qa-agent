import { loadJson, saveJson, fileExists } from "./io.js";
import type { PayoutModel, RegistryStore } from "./types.js";

export const payoutModel: RegistryStore<PayoutModel> = {
  load: (slug) => loadJson<PayoutModel>(slug, "payoutModel"),
  save: (slug, data) => saveJson(slug, "payoutModel", data),
  exists: (slug) => fileExists(slug, "payoutModel"),
};
