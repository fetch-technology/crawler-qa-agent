import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { providerCache } from "../registry/provider-cache.js";
import { meta } from "../registry/meta.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const m = await meta.load(slug);
  if (!m) printErr("detect-provider", `No registry for ${slug}`);
  const session = await openBrowser(true);
  try {
    const result = await crawl(session.page, { gameUrl: m!.gameUrl, gameSlug: slug });
    await providerCache.save(slug, {
      provider: result.provider,
      gameName: result.gameName,
      platform: result.platform,
      iframeCount: result.iframeCount,
      canvasCount: result.canvasCount,
      detectedAt: new Date().toISOString(),
    });
    printOk(`provider for ${slug}`, { provider: result.provider, platform: result.platform });
  } finally {
    await closeBrowser(session);
  }
}

main().catch((e) => printErr("detect-provider", e));
