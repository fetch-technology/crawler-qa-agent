import { printOk, printErr, parseArgs, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  requireString(args, "game");
  printOk("verify-api: invoked as part of run-scenario (rule engine includes ApiResponseShapeRule)");
}

main().catch((e) => printErr("verify-api", e));
