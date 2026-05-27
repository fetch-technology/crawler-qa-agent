// UI navigation graph: states (= unique screens) + transitions (which click leads
// where). Produced by recursive graph explorer; consumed by scenario executor
// to navigate between arbitrary states via BFS shortest-path.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { GameSlug, RegistryStore } from "./types.js";

export type UiGraphState = {
  id: string;                              // e.g. "main", "menu", "history-popup"
  description: string | null;              // human label
  baselineImage: string;                   // path relative to registry dir
  elements: string[];                      // keys into ui-registry.json
  transitions: Record<string, string>;     // elementKey → target stateId
  parentState?: string | null;             // optional: state we came from (for back-nav)
  closeElement?: string | null;            // element that closes/dismisses this state
};

export type UiGraph = {
  schemaVersion: 1;
  generatedAt: string;
  initialState: string;       // usually "main"
  states: Record<string, UiGraphState>;
  exploration: {
    aiCallsUsed: number;
    statesDiscovered: number;
    transitionsRecorded: number;
    elapsedMs: number;
  };
};

// Register the new file in registry paths.
import { REGISTRY_FILES } from "./paths.js";

declare module "./paths.js" {
  // (file already registered above; this is just a marker)
}

// Add the path entry at module load.
(REGISTRY_FILES as Record<string, string>).uiGraph = "ui-graph.json";

export const uiGraphStore: RegistryStore<UiGraph> = {
  load: (slug: GameSlug) => loadJson<UiGraph>(slug, "uiGraph" as never),
  save: (slug: GameSlug, data: UiGraph) => saveJson(slug, "uiGraph" as never, data),
  exists: (slug: GameSlug) => fileExists(slug, "uiGraph" as never),
};
