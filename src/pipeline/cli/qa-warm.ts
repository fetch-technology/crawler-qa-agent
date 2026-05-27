import { warmStart } from "../orchestrator/warm-start.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const spinCount = optionalNumber(args, "spins") ?? 100;
  const mode = (optionalString(args, "mode") as "ui" | "api" | undefined) ?? "api";
  const outDir = optionalString(args, "out");
  const result = await warmStart({
    gameSlug: slug,
    spinCount,
    spinMode: mode,
    outDir,
    generatePdf: true,
  });
  printOk(`qa:warm done`, result);
}

main().catch((e) => printErr("qa:warm", e));
