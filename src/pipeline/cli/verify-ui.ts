// verify-ui: standalone diagnostic that opens the game in a real browser,
// OCRs each configured region from ocr-regions.json, and prints a per-region
// pass/fail report. Useful for:
//   - Verifying that OCR regions are correctly aligned after a game UI patch
//   - Cross-checking UI balance against the last captured spin's API balance
//     (using UiBalanceMatchesApiRule)
//
// AI scope: ZERO AI calls.
//
// Usage:
//   npm run verify-ui -- --game <slug>
//   npm run verify-ui -- --game <slug> --url <override>
//   npm run verify-ui -- --game <slug> --headless

import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { initPreGame } from "../step3-smoke/pregame-init.js";
import { meta } from "../registry/meta.js";
import { ocrRegions } from "../registry/ocr-regions.js";
import { ocrRegion, parseNumericFromOcr } from "../utils/ocr-popup.js";
import { UiBalanceMatchesApiRule } from "../step9-verify/ui-rule.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { parseArgs, printOk, printErr, requireString, optionalString } from "./shared.js";

type RegionReport = {
  region: string;
  configured: boolean;
  ocrText?: string;
  parsedValue?: number | null;
  durationMs?: number;
  skipped?: string;
};

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const urlOverride = optionalString(args, "url");
  const headless = args["headless"] === true;

  const m = await meta.load(slug);
  if (!m) printErr("verify-ui", `No registry for ${slug}. Run discover-ui or qa:cold first.`);
  const url = urlOverride ?? m!.gameUrl;

  const regions = await ocrRegions.load(slug);
  if (!regions) {
    console.warn(`[verify-ui] No ocr-regions.json for ${slug}. Run discover-ocr-regions first.`);
  }

  const session = await openBrowser(headless);
  const reports: RegionReport[] = [];
  let uiBalanceCheck: { ok: boolean; detail?: string } | null = null;
  try {
    await crawl(session.page, { gameUrl: url, gameSlug: slug });
    await initPreGame(session.page, slug);

    const allRegions: Array<keyof NonNullable<typeof regions>> = [
      "balanceArea",
      "winArea",
      "freeSpinCounter",
      "betArea",
    ];

    for (const key of allRegions) {
      const r = regions?.[key];
      if (!r) {
        reports.push({ region: String(key), configured: false, skipped: "not in ocr-regions.json" });
        continue;
      }
      try {
        const ocr = await ocrRegion(session.page, { x: r.x, y: r.y, w: r.width, h: r.height }, { numeric: true });
        const parsed = parseNumericFromOcr(ocr.text);
        reports.push({
          region: String(key),
          configured: true,
          ocrText: ocr.text.slice(0, 80),
          parsedValue: parsed,
          durationMs: ocr.durationMs,
        });
      } catch (err) {
        reports.push({
          region: String(key),
          configured: true,
          skipped: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Optional UI vs API balance cross-check. Activates when there's a fresh
    // OCR balance AND --api-balance flag with the latest known balance from
    // a recent test run. Caller supplies the value so we don't need to dig
    // through fixtures/test-runs/.
    const apiBalanceFlag = optionalString(args, "api-balance");
    const balanceReport = reports.find((r) => r.region === "balanceArea");
    if (apiBalanceFlag && balanceReport?.parsedValue !== undefined && balanceReport.parsedValue !== null) {
      const apiBalance = Number(apiBalanceFlag);
      if (Number.isFinite(apiBalance)) {
        const fakeSpin: NormalizedSpinResult = {
          roundId: "verify-ui",
          bet: 0,
          win: 0,
          balanceBefore: null,
          balanceAfter: apiBalance,
          reels: [],
          cascadeFrames: [],
          state: "NORMAL",
          freeSpinsRemaining: null,
          isFreeSpin: false,
          hasBonus: false,
          raw: { _ocrBalance: balanceReport.parsedValue },
        };
        const rule = new UiBalanceMatchesApiRule();
        const result = rule.check(fakeSpin, { previousBalance: null, previousState: null, roundIndex: 0 });
        uiBalanceCheck = { ok: result.pass, detail: result.detail };
      }
    }
  } finally {
    await closeBrowser(session);
  }

  printOk("verify-ui report", { slug, regions: reports, uiBalanceCheck });
  const anyFailed = uiBalanceCheck && !uiBalanceCheck.ok;
  if (anyFailed) process.exit(1);
}

main().catch((e) => printErr("verify-ui", e));
