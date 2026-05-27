import { warmStart } from "../orchestrator/warm-start.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const spinCount = optionalNumber(args, "spins") ?? 10;
  const mode = (optionalString(args, "mode") as "ui" | "api" | undefined) ?? "ui";
  const result = await warmStart({ gameSlug: slug, spinCount, spinMode: mode, generatePdf: false });
  printOk(`scenario complete`, result);
}

main().catch((e) => printErr("run-scenario", e));
