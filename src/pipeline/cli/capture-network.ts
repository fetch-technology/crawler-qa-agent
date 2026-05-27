import path from "node:path";
import { openBrowser, closeBrowser } from "../orchestrator/browser.js";
import { startCapture } from "../step3-capture-network/recorder.js";
import { persistRounds } from "../step3-capture-network/storage.js";
import { runSmokeSpins } from "../step3-smoke/smoke-spin.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { meta } from "../registry/meta.js";
import { dirForGame } from "../registry/paths.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const spins = optionalNumber(args, "spins") ?? 10;
  const passiveDuration = optionalNumber(args, "passive-ms") ?? 15000;
  const m = await meta.load(slug);
  if (!m) printErr("capture-network", `No registry for ${slug}`);
  const ui = await uiRegistry.load(slug);

  const session = await openBrowser(true);
  try {
    // Start capture BEFORE goto so we observe init/auth/balance requests during load.
    const capture = startCapture(session.page);
    await session.page.goto(m!.gameUrl, { waitUntil: "load", timeout: 60000 });

    if (ui?.spinButton) {
      await runSmokeSpins(session.page, ui, { spins });
    } else {
      console.log(
        `[capture-network] no spinButton in registry — passive observation for ${passiveDuration}ms`,
      );
      await session.page.waitForTimeout(passiveDuration);
    }

    const rounds = capture.stop();
    const file = await persistRounds(path.join(dirForGame(slug), "network"), rounds);
    const reqCount = rounds.reduce((sum, r) => sum + r.requests.length, 0);
    const resCount = rounds.reduce((sum, r) => sum + r.responses.length, 0);
    const uniqueUrls = new Set<string>();
    for (const r of rounds) for (const res of r.responses) uniqueUrls.add(res.url);
    printOk(`captured ${rounds.length} rounds`, {
      file,
      requests: reqCount,
      responses: resCount,
      uniqueResponseUrls: uniqueUrls.size,
    });
  } finally {
    await closeBrowser(session);
  }
}

main().catch((e) => printErr("capture-network", e));
