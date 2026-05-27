import { uiRegistry } from "../registry/ui-registry.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const ui = await uiRegistry.load(slug);
  if (!ui) printErr("load-ui-registry", `No ui registry for ${slug}`);
  printOk(`loaded ui registry`, Object.keys(ui!));
}

main().catch((e) => printErr("load-ui-registry", e));
