import { printOk, printErr, parseArgs, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  requireString(args, "game");
  printOk(
    "calculate-rtp: RTP/hit-rate/volatility/feature-frequency are computed as part of run-spins → aggregator. See report output for stats.",
  );
}

main().catch((e) => printErr("calculate-rtp", e));
