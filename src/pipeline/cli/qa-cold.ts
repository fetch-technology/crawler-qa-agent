import { coldStart } from "../orchestrator/cold-start.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const url = requireString(args, "url");
  const spinCount = optionalNumber(args, "spins") ?? 10;
  const mode = (optionalString(args, "mode") as "ui" | "api" | undefined) ?? "ui";
  const outDir = optionalString(args, "out");
  const result = await coldStart({
    url,
    spinCount,
    spinMode: mode,
    outDir,
    generatePdf: true,
  });
  printOk(`qa:cold done`, result);
}

main().catch((e) => printErr("qa:cold", e));
