import { warmStart } from "../orchestrator/warm-start.js";
import { parseArgs, printOk, printErr, requireString, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const outDir = optionalString(args, "out");
  const result = await warmStart({ gameSlug: slug, spinCount: 100, generatePdf: true, outDir });
  printOk(`report generated`, result.report);
}

main().catch((e) => printErr("generate-report", e));
