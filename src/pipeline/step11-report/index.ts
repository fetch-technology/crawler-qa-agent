import { writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonReport } from "./json-report.js";
import { writeHtmlReport } from "./html-report.js";
import { writePdfReport } from "./pdf-report.js";
import { explainFailures } from "./ai-explainer.js";
import type { CaseReportInput, CaseReportOutput } from "./types.js";

export type ReportOptions = {
  outDir: string;
  generatePdf?: boolean;
};

export async function generateReport(
  input: CaseReportInput,
  opts: ReportOptions,
): Promise<CaseReportOutput & { aiExplanationPath?: string }> {
  // Step 11a — AI explainer (gated by QA_AI_EXPLAIN=1).
  let aiExplanation: string | null = null;
  let aiExplanationPath: string | undefined;
  if (input.rules.failed > 0) {
    aiExplanation = await explainFailures(input);
    if (aiExplanation) {
      aiExplanationPath = path.join(opts.outDir, "ai-explanation.md");
      await writeFile(aiExplanationPath, aiExplanation, "utf8");
    }
  }

  const enrichedInput: CaseReportInput & { aiExplanation?: string } = {
    ...input,
    aiExplanation: aiExplanation ?? undefined,
  };

  const jsonPath = await writeJsonReport(opts.outDir, enrichedInput);
  const htmlPath = await writeHtmlReport(opts.outDir, enrichedInput);
  let pdfPath: string | undefined;
  if (opts.generatePdf !== false) {
    pdfPath = await writePdfReport(htmlPath);
  }
  return { jsonPath, htmlPath, pdfPath, aiExplanationPath };
}

export type { CaseReportInput, CaseReportOutput } from "./types.js";
