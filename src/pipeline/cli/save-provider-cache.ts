import { providerCache } from "../registry/provider-cache.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const current = await providerCache.load(slug);
  if (!current) printErr("save-provider-cache", `No provider cache for ${slug}`);
  printOk(`provider cache persisted`, current);
}

main().catch((e) => printErr("save-provider-cache", e));
