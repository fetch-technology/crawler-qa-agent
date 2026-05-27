import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreCandidates } from "../step5-spin-api-detect/score.js";
import { apiMapping } from "../registry/api-mapping.js";
import { dirForGame } from "../registry/paths.js";
import type { NetworkRound } from "../step3-capture-network/types.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const networkFile = path.join(dirForGame(slug), "network", "network.jsonl");

  let raw: string;
  try {
    raw = await readFile(networkFile, "utf8");
  } catch {
    printErr("detect-apis", `No captured network at ${networkFile}. Run capture-network.`);
  }
  const rounds: NetworkRound[] = raw!
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NetworkRound);

  const candidates = scoreCandidates(rounds);
  const top = candidates[0];
  if (!top) printErr("detect-apis", "No spin candidate found in captured network");

  await apiMapping.save(slug, { spinApi: { url: top!.url, method: top!.method } });
  printOk(`spin API`, { ...top, alternates: candidates.slice(1, 4) });
}

main().catch((e) => printErr("detect-apis", e));
