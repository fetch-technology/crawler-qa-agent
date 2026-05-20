/**
 * validation_errors repository.
 */

import { getDb } from "../client.js";

export type ValidationErrorInput = {
  testRunId: string;
  spinResultId?: string | null;
  errorType: string;
  severity?: "error" | "warn" | "info";
  expectedValue?: string | null;
  actualValue?: string | null;
  message: string;
  screenshotUrl?: string | null;
};

export async function insertValidationErrors(
  rows: ValidationErrorInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  if (!db) return 0;
  const r = await db.validationError.createMany({
    data: rows.map((e) => ({
      testRunId: e.testRunId,
      spinResultId: e.spinResultId ?? null,
      errorType: e.errorType,
      severity: e.severity ?? "error",
      expectedValue: e.expectedValue ?? null,
      actualValue: e.actualValue ?? null,
      message: e.message,
      screenshotUrl: e.screenshotUrl ?? null,
    })),
  });
  return r.count;
}

export async function listValidationErrors(
  testRunId: string,
  opts: { errorType?: string; limit?: number } = {},
) {
  const db = getDb();
  if (!db) return [];
  return db.validationError.findMany({
    where: {
      testRunId,
      errorType: opts.errorType ?? undefined,
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 200,
  });
}

export async function groupValidationErrorsByType(testRunId: string) {
  const db = getDb();
  if (!db) return [];
  return db.validationError.groupBy({
    by: ["errorType"],
    where: { testRunId },
    _count: { _all: true },
  });
}
