import { providerCache } from "../registry/provider-cache.js";
import { apiMapping } from "../registry/api-mapping.js";
import { parserCache } from "../registry/parser-cache.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const [provider, api, parser] = await Promise.all([
    providerCache.load(slug),
    apiMapping.load(slug),
    parserCache.load(slug),
  ]);
  printOk(`loaded provider cache`, { provider, api, parser });
}

main().catch((e) => printErr("load-provider-cache", e));
