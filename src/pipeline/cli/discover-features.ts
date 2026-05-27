import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverFeatures } from "../step4-feature-discovery/index.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { dirForGame } from "../registry/paths.js";
import "../step6-build-model/index.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import { parserCache } from "../registry/parser-cache.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");

  const uiMap = await uiRegistry.load(slug);
  if (!uiMap) printErr("discover-features", `No ui registry for ${slug}. Run discover-ui first.`);

  const networkFile = path.join(dirForGame(slug), "network", "network.jsonl");
  let rounds: NetworkRound[] = [];
  try {
    const raw = await readFile(networkFile, "utf8");
    rounds = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as NetworkRound);
  } catch {
    // ok — gameplay step skips if no captures
  }

  const parserKind = (await parserCache.load(slug))?.parser;
  const spins: import("../step6-build-model/normalized.js").NormalizedSpinResult[] = [];
  if (parserKind) {
    const parser = await createParserForGame(slug);
    for (const r of rounds) {
      for (const res of r.responses) {
        if (res.body && parser.canParseResponse(res.body, res.url)) {
          try {
            spins.push(parser.parseResponse(res.body));
          } catch {
            // ignore
          }
        }
      }
    }
  }

  const paytable = await paytableStore.load(slug);

  const result = await discoverFeatures({ uiMap: uiMap!, rounds, paytable, spins });
  await featureRegistry.save(slug, result);

  const present = Object.entries(result.features)
    .filter(([, v]) => v?.present)
    .map(([k, v]) => `${k} (${v!.confidence.toFixed(2)}, ${v!.sources.join("+")})`);
  printOk(`discovered ${present.length} features`, { present, totalSignals: result.signals.length });
}

main().catch((e) => printErr("discover-features", e));
