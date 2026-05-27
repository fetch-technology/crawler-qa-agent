// Catalog → CSV export (RFC 4180, opens directly in Excel/Sheets). Reuses
// legacy `catalogToCsv`.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { catalogToCsv } from "../../ai/catalog-markdown.js";
import type { TestCaseCatalog } from "../../ai/test-catalog.js";
import type { GameSpec } from "../../ai/authoring.js";
import { dirForGame } from "../registry/paths.js";

const FILE_NAME = "test-cases.csv";

export async function saveCatalogCsv(
  gameSlug: string,
  catalog: TestCaseCatalog,
  spec: GameSpec,
): Promise<string> {
  const csv = catalogToCsv({ catalog, spec });
  const dir = dirForGame(gameSlug);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, FILE_NAME);
  await writeFile(filePath, csv, "utf8");
  return filePath;
}
