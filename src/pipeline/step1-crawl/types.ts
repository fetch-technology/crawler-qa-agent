import type { ProviderName } from "../registry/types.js";

export type CrawlResult = {
  gameUrl: string;
  gameSlug: string;
  loaded: boolean;
  iframeCount: number;
  canvasCount: number;
  consoleErrors: string[];
  initialScreenshot: string;
  provider: ProviderName;
  gameName: string;
  platform: "HTML5" | "Unity" | "Flash" | "Unknown";
};
