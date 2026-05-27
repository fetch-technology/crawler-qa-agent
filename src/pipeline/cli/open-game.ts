import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl, deriveSlug } from "../step1-crawl/crawler.js";
import { initMeta } from "../registry/meta.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const url = requireString(args, "url");
  const session = await openBrowser(true);
  try {
    const slug = deriveSlug(url);
    const result = await crawl(session.page, { gameUrl: url, gameSlug: slug });
    await initMeta(slug, url);
    printOk(`opened game ${slug}`, {
      slug,
      provider: result.provider,
      iframeCount: result.iframeCount,
      canvasCount: result.canvasCount,
      consoleErrors: result.consoleErrors.length,
    });
  } finally {
    await closeBrowser(session);
  }
}

main().catch((e) => printErr("open-game", e));
