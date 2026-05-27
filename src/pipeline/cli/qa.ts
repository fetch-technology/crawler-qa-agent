import { run } from "../orchestrator/index.js";
import { parseArgs, printOk, printErr, optionalString, optionalNumber } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const url = optionalString(args, "url");
  const gameSlug = optionalString(args, "game");
  const spinCount = optionalNumber(args, "spins");
  const mode = optionalString(args, "mode") as "ui" | "api" | undefined;
  const outDir = optionalString(args, "out");
  const result = await run({ url, gameSlug, spinCount, spinMode: mode, outDir, generatePdf: true });
  printOk(`qa pipeline done (${result.mode})`, result);
}

main().catch((e) => printErr("qa", e));
