import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Custom Playwright reporter — emit EVENT:case_end với full error/stack/attachments
 * NGAY KHI mỗi test kết thúc (khác list reporter chỉ in symbol + tên).
 *
 * Runner.ts (server/runner.ts) parse stdout và update caseResults live → UI
 * thấy error chi tiết ngay sau khi 1 test fail, không phải đợi toàn bộ run xong.
 */
export default class CaseReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    // test.title format: "case-id: Case Name" (do generate-and-run sinh)
    const idMatch = test.title.match(/^([\w-]+)/);
    const caseId = idMatch ? idMatch[1] : test.title;

    const status: "passed" | "failed" | "skipped" =
      result.status === "passed"
        ? "passed"
        : result.status === "skipped"
          ? "skipped"
          : "failed";

    const firstErr = result.error ?? result.errors?.[0];
    let error = firstErr?.message;
    let errorStack = firstErr?.stack;

    // Skip annotation reason (test.skip(true, "reason"))
    if (status === "skipped" && !error) {
      const skipAnno =
        result.annotations?.find((a) => a.type === "skip") ??
        test.annotations?.find((a) => a.type === "skip");
      error =
        skipAnno?.description ??
        "Auto-skipped by Playwright (likely filtered by --grep or earlier failure).";
    }

    const attachments = (result.attachments ?? [])
      .filter((a) => !!a.path)
      .map((a) => ({ name: a.name, path: a.path, contentType: a.contentType }));

    const payload = {
      caseId,
      status,
      durationMs: result.duration,
      error: error ?? null,
      errorStack: errorStack ?? null,
      attachments,
      timestamp: new Date().toISOString(),
    };

    // Stringify, đảm bảo 1 dòng (no newline trong JSON.stringify)
    process.stdout.write(`EVENT:case_end ${JSON.stringify(payload)}\n`);
  }
}
