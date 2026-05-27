// Catalog → markdown export (QA-readable). Reuses legacy `catalogToMarkdown`.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { catalogToMarkdown } from "../../ai/catalog-markdown.js";
import type { TestCaseCatalog } from "../../ai/test-catalog.js";
import type { GameSpec } from "../../ai/authoring.js";
import { dirForGame } from "../registry/paths.js";

const FILE_NAME = "test-cases.md";

export async function saveCatalogMarkdown(
  gameSlug: string,
  catalog: TestCaseCatalog,
  spec: GameSpec,
): Promise<string> {
  const md = catalogToMarkdown({ catalog, spec });
  const dir = dirForGame(gameSlug);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, FILE_NAME);
  await writeFile(filePath, md, "utf8");
  return filePath;
}
