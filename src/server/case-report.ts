import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Task, CaseResult } from "./types.js";

/**
 * Playwright JSON reporter shape (subset used).
 */
type PwJsonResult = {
  config?: unknown;
  suites?: PwSuite[];
  stats?: { expected: number; unexpected: number; skipped: number; duration: number };
};
type PwSuite = {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
};
type PwSpec = {
  title: string;
  ok: boolean;
  tests?: PwTest[];
};
type PwAnnotation = { type?: string; description?: string };
type PwTest = {
  results?: PwTestResult[];
  annotations?: PwAnnotation[];
};
type PwTestResult = {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
  annotations?: PwAnnotation[];
};

export type CaseReportEntry = {
  id: string;
  name?: string;
  category?: string;
  severity?: string;
  description?: string;
  setup_instructions?: string;
  spin_count_expected?: number;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  durationMs?: number;
  error?: string;
  error_stack?: string;
  attachments?: Array<{ name?: string; path?: string }>;
};

export type CaseReport = {
  taskId: string;
  gameSlug: string;
  gameUrl: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  cases: CaseReportEntry[];
};

/**
 * Parse Playwright JSON reporter output + merge với catalog + live results.
 * Output: structured CaseReport object + markdown string.
 */
export function buildCaseReport(args: {
  task: Task;
  catalogPath: string | null;   // fixtures/specs/{slug}/{slug}.test-cases.json
  playwrightJsonPath: string | null;
}): { report: CaseReport; markdown: string } {
  const { task, catalogPath, playwrightJsonPath } = args;

  // Load catalog để lấy metadata
  let catalogCases: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    severity: string;
    setup_instructions: string;
    spin_count: number;
  }> = [];
  if (catalogPath && existsSync(catalogPath)) {
    try {
      const cat = JSON.parse(readFileSync(catalogPath, "utf8"));
      if (Array.isArray(cat?.cases)) catalogCases = cat.cases;
    } catch {}
  }

  // Load Playwright JSON nếu có. Map giữ kèm annotations từ test-level
  // (test.skip lưu reason ở đó, không phải trong error).
  let pwMap = new Map<string, { result: PwTestResult; testAnnotations: PwAnnotation[] }>();
  if (playwrightJsonPath && existsSync(playwrightJsonPath)) {
    try {
      const pw = JSON.parse(readFileSync(playwrightJsonPath, "utf8")) as PwJsonResult;
      pwMap = flattenPwSpecs(pw.suites ?? []);
    } catch {}
  }

  // Build case entries: union catalog + live + playwright-json
  const cases: CaseReportEntry[] = [];
  const liveResults = task.caseResults ?? {};
  const seen = new Set<string>();

  for (const cat of catalogCases) {
    seen.add(cat.id);
    const live = liveResults[cat.id];
    const pw = pwMap.get(cat.id);

    let status: CaseReportEntry["status"] = live?.status ?? "pending";
    let durationMs = live?.durationMs;
    let error: string | undefined;
    let errorStack: string | undefined;
    let attachments: CaseReportEntry["attachments"];

    if (pw) {
      const result = pw.result;
      status = mapPwStatus(result.status);
      if (typeof result.duration === "number") durationMs = result.duration;
      const firstErr = result.error ?? (result.errors && result.errors[0]);
      if (firstErr) {
        error = firstErr.message;
        errorStack = firstErr.stack;
      }
      // Skipped: lấy reason từ annotations (test.skip(true, "reason") → annotations[].type="skip")
      if (status === "skipped" && !error) {
        const skipAnno =
          (result.annotations ?? []).find((a) => a.type === "skip") ??
          pw.testAnnotations.find((a) => a.type === "skip");
        if (skipAnno?.description) {
          error = skipAnno.description;
        } else {
          // No annotation = Playwright auto-skip. Phổ biến nhất: serial mode +
          // 1 test trước đó fail → các test còn lại bị skip không reason.
          // Hoặc: --grep filter loại test ra khỏi run.
          error =
            "Auto-skipped by Playwright (no reason). Likely a previous test failed in serial mode, or this case was filtered out by --grep. Re-run via ▶ Run button to execute it independently.";
        }
      }
      if (result.attachments) {
        attachments = result.attachments
          .filter((a) => a.path)
          .map((a) => ({ name: a.name, path: a.path }));
      }
    }

    cases.push({
      id: cat.id,
      name: cat.name,
      category: cat.category,
      severity: cat.severity,
      description: cat.description,
      setup_instructions: cat.setup_instructions,
      spin_count_expected: cat.spin_count,
      status,
      durationMs,
      error,
      error_stack: errorStack,
      attachments,
    });
  }

  // Cases in live but not in catalog (edge case)
  for (const [id, r] of Object.entries(liveResults)) {
    if (seen.has(id)) continue;
    cases.push({
      id,
      name: r.name,
      status: r.status,
      durationMs: r.durationMs,
      error: r.error,
    });
  }

  // Stats
  const stats = { total: cases.length, passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const c of cases) {
    if (c.status === "passed") stats.passed++;
    else if (c.status === "failed") stats.failed++;
    else if (c.status === "skipped") stats.skipped++;
    else stats.pending++;
  }

  const report: CaseReport = {
    taskId: task.id,
    gameSlug: task.gameSlug,
    gameUrl: task.gameUrl,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    exitCode: task.exitCode,
    stats,
    cases,
  };

  return { report, markdown: renderMarkdown(report) };
}

function mapPwStatus(s: PwTestResult["status"]): CaseReportEntry["status"] {
  if (s === "passed") return "passed";
  if (s === "failed" || s === "timedOut" || s === "interrupted") return "failed";
  if (s === "skipped") return "skipped";
  return "pending";
}

function flattenPwSpecs(
  suites: PwSuite[],
): Map<string, { result: PwTestResult; testAnnotations: PwAnnotation[] }> {
  const out = new Map<string, { result: PwTestResult; testAnnotations: PwAnnotation[] }>();
  const walk = (s: PwSuite) => {
    for (const spec of s.specs ?? []) {
      const idMatch = spec.title.match(/^([\w-]+)(?::\s+(.+))?$/);
      const caseId = idMatch?.[1] ?? spec.title;
      const firstTest = spec.tests?.[0];
      const firstResult = firstTest?.results?.[0];
      if (firstResult) {
        out.set(caseId, {
          result: firstResult,
          testAnnotations: firstTest?.annotations ?? [],
        });
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of suites) walk(s);
  return out;
}

function renderMarkdown(report: CaseReport): string {
  const lines: string[] = [];
  const { stats } = report;
  lines.push(`# Case Report — ${report.gameSlug}`);
  lines.push("");
  lines.push(`**Task**: \`${report.taskId}\`  `);
  lines.push(`**URL**: ${report.gameUrl}  `);
  lines.push(`**Duration**: ${report.durationMs ? (report.durationMs / 1000).toFixed(1) + "s" : "—"}  `);
  lines.push(`**Exit code**: ${report.exitCode ?? "—"}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Total | Passed | Failed | Skipped | Pending |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| ${stats.total} | ✓ ${stats.passed} | ✘ ${stats.failed} | — ${stats.skipped} | ⊚ ${stats.pending} |`);
  lines.push("");

  // Failed cases đầu tiên cho dễ tìm
  const failed = report.cases.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    lines.push(`## ❌ Failed Cases (${failed.length})`);
    lines.push("");
    for (const c of failed) {
      lines.push(`### ${c.id} — ${c.name ?? ""}`);
      if (c.category) lines.push(`- Category: \`${c.category}\``);
      if (c.severity) lines.push(`- Severity: **${c.severity}**`);
      if (c.durationMs) lines.push(`- Duration: ${(c.durationMs / 1000).toFixed(1)}s`);
      if (c.setup_instructions) lines.push(`- Setup: ${c.setup_instructions}`);
      lines.push("");
      if (c.error) {
        lines.push("```");
        lines.push(c.error.slice(0, 2000));
        lines.push("```");
      }
      if (c.error_stack) {
        lines.push("<details><summary>Stack trace</summary>");
        lines.push("");
        lines.push("```");
        lines.push(c.error_stack.slice(0, 4000));
        lines.push("```");
        lines.push("</details>");
      }
      if (c.attachments && c.attachments.length) {
        lines.push(`- Attachments: ${c.attachments.map((a) => `${a.name ?? "file"}: \`${a.path}\``).join(", ")}`);
      }
      lines.push("");
    }
  }

  // Passed cases
  const passed = report.cases.filter((c) => c.status === "passed");
  if (passed.length > 0) {
    lines.push(`## ✓ Passed Cases (${passed.length})`);
    lines.push("");
    lines.push(`| ID | Name | Category | Duration |`);
    lines.push(`|---|---|---|---|`);
    for (const c of passed) {
      lines.push(
        `| \`${c.id}\` | ${c.name ?? ""} | ${c.category ?? ""} | ${c.durationMs ? (c.durationMs / 1000).toFixed(1) + "s" : "—"} |`,
      );
    }
    lines.push("");
  }

  // Skipped / pending
  const skipped = report.cases.filter((c) => c.status === "skipped");
  if (skipped.length > 0) {
    lines.push(`## — Skipped (${skipped.length})`);
    lines.push("");
    for (const c of skipped) {
      lines.push(`- \`${c.id}\` ${c.name ?? ""}${c.error ? ` — ${c.error}` : ""}`);
    }
    lines.push("");
  }

  const pending = report.cases.filter((c) => c.status === "pending");
  if (pending.length > 0) {
    lines.push(`## ⊚ Pending (${pending.length})`);
    lines.push("");
    lines.push(`_Tests never ran (task interrupted or Playwright didn't reach them)._`);
    lines.push("");
    for (const c of pending) lines.push(`- \`${c.id}\` ${c.name ?? ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function writeCaseReport(taskDir: string, report: CaseReport, markdown: string) {
  writeFileSync(join(taskDir, "case-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(taskDir, "case-report.md"), markdown);
}
