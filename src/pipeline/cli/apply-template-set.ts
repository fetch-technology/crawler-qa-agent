// CLI: apply the standard reusable test-case template set to a game, then
// (unless --no-translate) rebind setup→actions against the game's ui-registry.
//
//   yarn apply-template-set --game <slug> [--mode merge|replace] [--no-translate]
//
// merge (default): keep existing AI/manual cases, append template cases with
// new ids. replace: replace the catalog's cases with the template set.
//
// Prereqs: the game must already be discovered (ui-registry.json present) for
// the translate pass to bind actions. feature-registry.json + (optional)
// game-spec-override.json drive feature-gating and {{betMin/Max/defaultBet}}.

import { applyTemplateSet } from "../step7-testcase-gen/case-templates.js";
import { translateAllCases } from "../step7-testcase-gen/case-action-translator.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const mode = args["mode"] === "replace" ? "replace" : "merge";
  const translate = args["no-translate"] !== true;

  const result = await applyTemplateSet(slug, { mode });
  console.log(
    `[apply-template-set] ${slug}: applied ${result.applied.length}, skipped ${result.skipped.length} (${result.source}, mode=${result.mode})`,
  );
  for (const s of result.skipped) console.log(`  - skip ${s.id}: ${s.reason}`);

  if (!translate) {
    printOk(`applied ${result.applied.length} template cases (translate skipped)`, {
      catalogPath: result.catalogPath,
      applied: result.applied.map((c) => c.id),
      skipped: result.skipped,
    });
    return;
  }

  const ui = await uiRegistry.load(slug);
  if (!ui) {
    printErr(
      "apply-template-set",
      `Cases written, but no ui-registry for ${slug} — run discovery, then translate with: yarn apply-template-set --game ${slug} (cases already present will rebind).`,
    );
  }
  const cache = await translateAllCases(slug, result.applied, ui!);
  const boundCount = result.applied.filter((c) => cache.cases[c.id] && !cache.cases[c.id]!.skipReason).length;
  printOk(`applied ${result.applied.length} template cases; ${boundCount} bound to actions`, {
    catalogPath: result.catalogPath,
    applied: result.applied.map((c) => c.id),
    skipped: result.skipped,
  });
}

main().catch((e) => printErr("apply-template-set", e));
