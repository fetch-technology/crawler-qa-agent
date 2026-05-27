// Recovery: registry validation failed → call ai-recover-locator for broken elements,
// update registry, then re-run warm-start once.

import { openBrowser, closeBrowser } from "./browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { aiRecoverLocator } from "../step2-detect-ui/ai-recover-locator.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta } from "../registry/meta.js";
import { warmStart } from "./warm-start.js";
import type { PipelineOptions, PipelineResult } from "./types.js";
import type { UiRegistry } from "../registry/types.js";

const MAX_RETRIES = 1;

export async function recovery(
  gameSlug: string,
  brokenElements: string[],
  opts: PipelineOptions,
  attempt = 0,
): Promise<PipelineResult> {
  if (attempt >= MAX_RETRIES) {
    throw new Error(
      `REGISTRY_STALE: recovery failed after ${MAX_RETRIES} attempt(s). Broken: ${brokenElements.join(", ")}. Run cold-start instead.`,
    );
  }

  const m = await meta.load(gameSlug);
  const url = opts.url ?? m?.gameUrl;
  if (!url) throw new Error(`Cannot recover ${gameSlug} — no gameUrl available`);

  const session = await openBrowser(true);
  try {
    await crawl(session.page, { gameUrl: url, gameSlug });
    const current = (await uiRegistry.load(gameSlug)) ?? {};
    for (const element of brokenElements) {
      const key = element.split(".").pop() ?? element;
      const recovered = await aiRecoverLocator(session.page, key);
      if (recovered) (current as UiRegistry)[key] = recovered;
    }
    await uiRegistry.save(gameSlug, current);
  } finally {
    await closeBrowser(session);
  }

  return warmStart({ ...opts, gameSlug });
}
