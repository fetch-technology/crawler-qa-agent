import type { CrawlResult } from "../step1-crawl/types.js";
import type { SmokeResult } from "../step3-smoke/types.js";
import type { SpinApiDetection } from "../step5-spin-api-detect/types.js";
import type { RuleEngineSummary } from "../step9-verify/types.js";
import type { MassiveSpinResult } from "../step8-run-scenarios/types.js";
import type { CaseRunSummary } from "../step8-run-scenarios/case-runner.js";
import type { StatReport } from "../step10-statistical/types.js";

export type CaseReportInput = {
  crawl: CrawlResult;
  smoke?: SmokeResult;
  spinApi?: SpinApiDetection;
  /** Aggregate rule engine summary (mass-spin invariants). */
  rules: RuleEngineSummary;
  massive?: MassiveSpinResult;
  stats?: StatReport;
  /**
   * Per-case execution results — when AI catalog is loaded and executed, each
   * case runs with its own setup_instructions + spin + assertions. This is the
   * primary "tests run" view; `rules` is the aggregate/mass-spin counterpart.
   */
  caseRun?: CaseRunSummary;
};

export type CaseReportOutput = {
  jsonPath: string;
  htmlPath?: string;
  pdfPath?: string;
};
