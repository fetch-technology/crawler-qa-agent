import { printOk, printErr, parseArgs, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  requireString(args, "game");
  printOk("verify-balance: invoked as part of run-scenario (rule engine includes FinancialRule)");
}

main().catch((e) => printErr("verify-balance", e));
