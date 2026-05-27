import type { CaseReportOutput } from "../step11-report/index.js";

export type PipelineOptions = {
  url?: string;
  gameSlug?: string;
  spinCount?: number;
  spinMode?: "ui" | "api";
  generatePdf?: boolean;
  outDir?: string;
};

export type PipelineResult = {
  mode: "cold" | "warm" | "recovery";
  gameSlug: string;
  report: CaseReportOutput;
};
