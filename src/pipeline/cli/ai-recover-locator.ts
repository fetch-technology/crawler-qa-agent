import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { aiRecoverLocator } from "../step2-detect-ui/ai-recover-locator.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta } from "../registry/meta.js";
import type { UiRegistry } from "../registry/types.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const element = requireString(args, "element");
  const m = await meta.load(slug);
  if (!m) printErr("ai-recover-locator", `No registry for ${slug}`);

  const session = await openBrowser(true);
  try {
    await crawl(session.page, { gameUrl: m!.gameUrl, gameSlug: slug });
    const recovered = await aiRecoverLocator(session.page, element);
    if (!recovered) printErr("ai-recover-locator", `AI could not locate ${element}`);
    const current = (await uiRegistry.load(slug)) ?? {};
    (current as UiRegistry)[element] = recovered!;
    await uiRegistry.save(slug, current);
    printOk(`recovered ${element}`, recovered);
  } finally {
    await closeBrowser(session);
  }
}

main().catch((e) => printErr("ai-recover-locator", e));
