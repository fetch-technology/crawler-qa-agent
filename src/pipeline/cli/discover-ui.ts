import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { discoverUi } from "../step2-detect-ui/resolver.js";
import { captureBaselines } from "../step2-detect-ui/baseline-capture.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta } from "../registry/meta.js";
import type { UiElement, UiRegistry } from "../registry/types.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const m = await meta.load(slug);
  if (!m) printErr("discover-ui", `No registry for ${slug}. Run open-game first.`);
  const session = await openBrowser(true);
  try {
    await crawl(session.page, { gameUrl: m!.gameUrl, gameSlug: slug });
    const { uiMap: discovered } = await discoverUi(session.page, { slug });

    // Manual coordinate overrides for canvas games where DOM/OCR/AI strategies
    // can't auto-detect. Pass via CLI: --spin-x 1660 --spin-y 870
    const overrides = collectOverrides(args);
    const merged: UiRegistry = { ...discovered, ...overrides };

    const uiMap = await captureBaselines(session.page, slug, merged);
    await uiRegistry.save(slug, uiMap);
    printOk(`discovered UI for ${slug}`, Object.keys(uiMap));
  } finally {
    await closeBrowser(session);
  }
}

function collectOverrides(args: Record<string, string | boolean>): UiRegistry {
  const out: UiRegistry = {};
  const keys: Array<{ flag: string; key: keyof UiRegistry }> = [
    { flag: "spin", key: "spinButton" },
    { flag: "auto", key: "autoButton" },
    { flag: "turbo", key: "turboButton" },
    { flag: "buy-bonus", key: "buyBonusButton" },
    { flag: "history", key: "historyButton" },
    { flag: "paytable", key: "paytableButton" },
    { flag: "bet-plus", key: "betPlus" },
    { flag: "bet-minus", key: "betMinus" },
  ];
  for (const { flag, key } of keys) {
    const x = optionalNumber(args, `${flag}-x`);
    const y = optionalNumber(args, `${flag}-y`);
    if (x !== undefined && y !== undefined) {
      const element: UiElement = {
        x,
        y,
        strategy: "ai_vision",
        confidence: 1,
        detectedAt: new Date().toISOString(),
      };
      out[key] = element;
    }
  }
  return out;
}


main().catch((e) => printErr("discover-ui", e));
