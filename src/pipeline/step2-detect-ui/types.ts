import type { UiElement, UiRegistry } from "../registry/types.js";

export type DiscoverOptions = {
  screenshotPath?: string;
};

export type UiDiscoverResult = {
  uiMap: UiRegistry;
  screenshotPath: string;
  /** P3 — game-specific buttons the AI noticed beyond the expected list,
   *  AUTO-ADDED to uiMap as pending entries. This lists what was added (key +
   *  coord + note) so the dashboard can highlight them for QA verification. */
  autoAdded?: Array<{ key: string; x: number; y: number; confidence: number; note?: string }>;
};

export type Strategy = "dom" | "ocr" | "template" | "ai_vision";

export type StrategyResult = {
  found: boolean;
  element?: UiElement;
};
