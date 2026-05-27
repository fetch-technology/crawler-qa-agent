import type { Page } from "playwright";
import type { CrawlResult } from "./types.js";
import { detectProvider } from "./provider-detector.js";

export type CrawlOptions = {
  gameUrl: string;
  gameSlug?: string;
  timeout?: number;
};

export async function crawl(page: Page, opts: CrawlOptions): Promise<CrawlResult> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(opts.gameUrl, {
    waitUntil: "networkidle",
    timeout: opts.timeout ?? 60000,
  });

  const iframeCount = page.frames().length - 1;
  const canvasCount = await page.locator("canvas").count();

  const { provider, gameName, platform } = await detectProvider(page, opts.gameUrl);

  const slug = opts.gameSlug ?? deriveSlug(opts.gameUrl);

  return {
    gameUrl: opts.gameUrl,
    gameSlug: slug,
    loaded: true,
    iframeCount,
    canvasCount,
    consoleErrors: errors,
    initialScreenshot: "",
    provider,
    gameName,
    platform,
  };
}

export function deriveSlug(url: string): string {
  const m = url.match(/\/(vs\d+\w+|[a-z0-9-]+game[a-z0-9-]*)/i);
  if (m && m[1]) return m[1].toLowerCase();
  const u = new URL(url);
  return u.pathname.split("/").filter(Boolean)[0] ?? "unknown";
}
