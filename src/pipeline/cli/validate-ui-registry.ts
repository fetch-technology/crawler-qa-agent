import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { validateRegistry } from "../step2-5-validate-registry/validator.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta, touchValidated } from "../registry/meta.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const m = await meta.load(slug);
  if (!m) printErr("validate-ui-registry", `No registry for ${slug}`);
  const ui = await uiRegistry.load(slug);

  const session = await openBrowser(true);
  try {
    await crawl(session.page, { gameUrl: m!.gameUrl, gameSlug: slug });
    const result = await validateRegistry(session.page, ui, { gameSlug: slug });
    if (result.ok) {
      await touchValidated(slug);
      printOk(`registry valid for ${slug}`);
    } else {
      console.error(`[fail] invalid: ${result.invalidEntries.join(", ")}`);
      console.error(`  reason: ${result.reason ?? "n/a"}`);
      process.exit(1);
    }
  } finally {
    await closeBrowser(session);
  }
}

main().catch((e) => printErr("validate-ui-registry", e));
