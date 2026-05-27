import { uiRegistry } from "../registry/ui-registry.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const current = await uiRegistry.load(slug);
  if (!current) printErr("save-ui-registry", `No in-memory ui state; use discover-ui first`);
  printOk(`registry already persisted for ${slug}`, Object.keys(current ?? {}));
}

main().catch((e) => printErr("save-ui-registry", e));
