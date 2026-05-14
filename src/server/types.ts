export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Pipeline phase user request runner thực hiện. */
export type TaskPhase = "collect" | "generate" | "run" | "all";

/**
 * Stage = mức progress đã đạt được. Khác với status (last subprocess outcome).
 *
 * - init: task vừa tạo, chưa run gì
 * - context_ready: phase=collect đã xong, có spec + context bundle
 * - catalog_ready: phase=generate đã xong, có catalog + test code
 * - tests_done: phase=run đã xong (pass/fail không quan trọng)
 */
export type TaskStage = "init" | "context_ready" | "catalog_ready" | "tests_done";

export type CaseStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type CaseResult = {
  id: string;
  name?: string;
  status: CaseStatus;
  durationMs?: number;
  error?: string;
  errorStack?: string;
  startedAt?: string;
  finishedAt?: string;
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
  /** Phân loại error (code_bug | assertion_failure | setup_failure | ...). */
  errorCategory?: string;
  /** 1-line label cho UI badge. */
  errorTitle?: string;
  /** 1-2 sentence plain English explanation. */
  errorSummary?: string;
  /** 1-2 sentence — cách debug. */
  errorSuggestion?: string;
  /** file:line (nếu trích được từ stack). */
  errorLocation?: string;
};

export type TaskLogEntry = {
  t: number; // ms since task start
  timestamp: string; // ISO
  stream: "stdout" | "stderr" | "system";
  text: string;
};

export type TaskSpinEvent = {
  kind: "spin";
  taskId: string;
  spinNumber: number;
  timestamp: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  betAmount: number | null;
  winAmount: number | null;
  netChange: number | null;
  status: string | null;
  spinId: string | null;
  currency: string | null;
};

export type Task = {
  id: string;
  gameUrl: string;
  gameSlug: string;
  provider: string;
  providerName: string;
  host: string;
  status: TaskStatus;
  /** Mức progress đã đạt qua các phase (init → context_ready → catalog_ready → tests_done). */
  stage: TaskStage;
  /** Phase cần chạy khi runner pick task này lên. null khi task không queued. */
  nextPhase: TaskPhase | null;
  spinsPerTest: number;
  forceRecollect: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  summary: {
    totalBet: number;
    totalWin: number;
    spinCount: number;
    rtp: number | null;
  } | null;
  caseStats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  } | null;
  caseResults: Record<string, CaseResult> | null;
  lastError: string | null;
};
