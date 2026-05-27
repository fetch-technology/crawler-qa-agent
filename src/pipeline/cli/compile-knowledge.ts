// CLI: compile knowledge for a game. Writes
// fixtures/registry/<slug>/compiled-knowledge.json with full snapshot of
// effective configs after defaults + cross-validation.
//
//   npm run compile:knowledge -- --game vs20rnriches
//   npm run compile:knowledge -- --game vs20rnriches --json   (print only, no write)

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileKnowledge } from "../knowledge/index.js";
import { dirForGame } from "../registry/paths.js";
import { parseArgs, requireString, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");
  const onlyPrint = optionalString(args, "json") !== undefined;

  const knowledge = await compileKnowledge(slug);
  if (knowledge.errors.length > 0) {
    console.error(`[compile-knowledge] ${slug}: ${knowledge.errors.length} ERRORS:`);
    for (const e of knowledge.errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  if (knowledge.warnings.length > 0) {
    console.warn(`[compile-knowledge] ${slug}: ${knowledge.warnings.length} warnings:`);
    for (const w of knowledge.warnings) console.warn(`  ⚠ ${w}`);
  }

  if (onlyPrint) {
    console.log(JSON.stringify(knowledge, null, 2));
    return;
  }

  const outFile = path.join(dirForGame(slug), "compiled-knowledge.json");
  await writeFile(outFile, JSON.stringify(knowledge, null, 2));
  console.log(`[compile-knowledge] ${slug}: wrote ${outFile}`);
  console.log(`  uiElements=${Object.keys(knowledge.ui).length}`);
  console.log(`  parser=${knowledge.parser?.parser ?? "missing"}`);
  console.log(`  mechanic=${knowledge.mechanics?.mechanic ?? "unknown"}`);
  console.log(`  betFormula=${knowledge.derived.betFormulaDescription}`);
  console.log(`  popupKeywords=interstitial(${knowledge.popupKeywords.interstitial.length})+substate(${knowledge.popupKeywords.substate.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
