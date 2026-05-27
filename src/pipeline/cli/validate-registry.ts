// CLI: validate registry config files against JSON Schemas.
//   npm run validate:registry -- --game vs20rnriches
//   npm run validate:registry --                       (all games)
//
// Exits 0 if all valid, 1 if any file fails. Used as a CI/manual sanity gate.

import { validateRegistry, validateAllRegistries, formatReport } from "../registry/validator.js";
import { parseArgs, optionalString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = optionalString(args, "game");

  if (slug) {
    const report = await validateRegistry(slug);
    console.log(formatReport(report));
    process.exit(report.failed > 0 ? 1 : 0);
  }

  const reports = await validateAllRegistries();
  let totalFailed = 0;
  for (const report of reports) {
    console.log(formatReport(report));
    totalFailed += report.failed;
  }
  console.log(`\n[summary] ${reports.length} games, ${totalFailed} schema violations`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
