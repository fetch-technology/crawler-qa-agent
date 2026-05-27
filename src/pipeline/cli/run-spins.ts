import "../step6-build-model/index.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import { runMassiveSpins } from "../step8-run-scenarios/runner.js";
import { apiMapping } from "../registry/api-mapping.js";
import { parseArgs, printOk, printErr, requireString, optionalNumber, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const count = optionalNumber(args, "count") ?? 10000;
  const mode = (optionalString(args, "mode") as "ui" | "api" | undefined) ?? "api";
  const api = await apiMapping.load(slug);
  if (!api) printErr("run-spins", `No api mapping for ${slug}. Run detect-apis.`);
  const parser = await createParserForGame(slug);
  const result = await runMassiveSpins({ gameSlug: slug, api: api!, parser }, { count, mode });
  printOk(`ran ${count} spins`, {
    mode: result.mode,
    attempted: result.attempted,
    succeeded: result.succeeded,
    durationMs: result.durationMs,
  });
}

main().catch((e) => printErr("run-spins", e));
