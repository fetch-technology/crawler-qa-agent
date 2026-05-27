import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaseReportInput } from "./types.js";

export async function writeJsonReport(outDir: string, input: CaseReportInput): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "report.json");
  await writeFile(file, JSON.stringify(input, null, 2) + "\n", "utf8");
  return file;
}
