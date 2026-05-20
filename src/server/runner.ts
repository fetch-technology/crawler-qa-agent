import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { TaskQueue } from "./queue.js";
import type { Task, TaskSpinEvent } from "./types.js";
import { buildCaseReport, writeCaseReport } from "./case-report.js";
import { categorizeError } from "./error-categorize.js";
import { extractLatestForSlug } from "../runner/scenario-extractor.js";
import {
  onRunPhaseStart,
  onSpinEvent,
  onCaseEnd,
  onTaskComplete,
} from "./db-writethrough.js";

/**
 * Tìm test case trong Playwright JSON output → trả error/skip reason + duration.
 * Skip reason nằm trong test.annotations[].description (type=skip), không phải error.
 */
function extractSingleCaseResult(
  json: unknown,
  caseId: string,
): { status: "passed" | "failed" | "skipped"; durationMs?: number; error?: string } | null {
  type Anno = { type?: string; description?: string };
  type Result = {
    status?: "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
    duration?: number;
    error?: { message?: string };
    errors?: Array<{ message?: string }>;
    annotations?: Anno[];
  };
  type Test = { results?: Result[]; annotations?: Anno[] };
  type Spec = { title?: string; tests?: Test[] };
  type Suite = { specs?: Spec[]; suites?: Suite[] };
  type Root = { suites?: Suite[] };

  const root = json as Root;
  const stack: Suite[] = [...(root.suites ?? [])];
  while (stack.length) {
    const s = stack.shift()!;
    for (const spec of s.specs ?? []) {
      const id = (spec.title ?? "").match(/^([\w-]+)/)?.[1];
      if (id !== caseId) continue;
      const test = spec.tests?.[0];
      const result = test?.results?.[0];
      if (!result) return null;

      const status: "passed" | "failed" | "skipped" =
        result.status === "passed"
          ? "passed"
          : result.status === "skipped"
            ? "skipped"
            : "failed";

      let error: string | undefined;
      const firstErr = result.error ?? result.errors?.[0];
      if (firstErr?.message) error = firstErr.message;

      if (status === "skipped" && !error) {
        const skipAnno =
          result.annotations?.find((a) => a.type === "skip") ??
          test?.annotations?.find((a) => a.type === "skip");
        error =
          skipAnno?.description ??
          "Auto-skipped by Playwright (likely filtered by --grep or earlier failure in serial mode).";
      }

      return {
        status,
        durationMs: typeof result.duration === "number" ? result.duration : undefined,
        error,
      };
    }
    if (s.suites) stack.push(...s.suites);
  }
  return null;
}

function parseDuration(s: string): number | undefined {
  const m = s.match(/^([\d.]+)(ms|m|s)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return undefined;
}

export class TaskRunner {
  private currentProcess: ChildProcess | null = null;
  private currentTaskId: string | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private cancellingTaskIds = new Set<string>();

  constructor(private queue: TaskQueue) {}

  start() {
    this.stopped = false;
    this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.currentProcess) this.killProcess(this.currentProcess, "SIGINT");
  }

  /**
   * Kill process group (graceful SIGINT → SIGKILL after 8s).
   */
  private killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGINT") {
    const pid = proc.pid;
    if (!pid) return;
    try {
      // Spawn với detached=true → có process group riêng → kill group bằng -pid
      process.kill(-pid, signal);
    } catch {
      // Fallback: kill riêng process
      try {
        proc.kill(signal);
      } catch {}
    }
  }

  /**
   * Hủy task đang chạy (status=running). Return true nếu đã trigger kill.
   */
  /**
   * Pre-flight: verify worker rảnh + spec đã tồn tại.
   * Dùng trước khi fire-and-forget runSingleCase.
   */
  checkSingleCasePreflight(taskId: string, _caseId: string): { ok: boolean; error?: string } {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };
    // At least ONE spec (vision OR hybrid) must exist — actual selection in runSingleCase.
    const visionSpec = resolve(join("tests", "generated", `${task.gameSlug}.spec.ts`));
    const hybridSpec = resolve(join("tests", "generated", `${task.gameSlug}.hybrid.spec.ts`));
    if (!existsSync(visionSpec) && !existsSync(hybridSpec)) {
      return { ok: false, error: `Chưa có file spec — chạy full pipeline trước` };
    }
    const hintsAbsPath = resolve(join("fixtures/specs", task.gameSlug, "network-hints.json"));
    if (!existsSync(hintsAbsPath)) {
      return { ok: false, error: `Chưa có network-hints — chạy full pipeline trước` };
    }
    return { ok: true };
  }

  /**
   * Re-run 1 test case duy nhất từ spec đã sinh.
   * Yêu cầu: task đã có spec generated trước đó (tests/generated/{slug}.spec.ts).
   * Chạy nối tiếp sau khi worker rảnh — nếu đang có task chạy → reject.
   */
  async runSingleCase(taskId: string, caseId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };

    // Smart routing — mirror logic from generate-and-run.ts run phase:
    // Prefer hybrid spec (deterministic, $0-0.20) when scenarios exist + hybrid
    // spec file present. Fall back to vision spec when not (real LLM cost).
    const visionSpecPath = resolve(join("tests", "generated", `${task.gameSlug}.spec.ts`));
    const hybridSpecPath = resolve(join("tests", "generated", `${task.gameSlug}.hybrid.spec.ts`));
    const { listScenarios } = await import("../runner/scenario.js");
    const scenarios = listScenarios(task.gameSlug);
    const forceVision = process.env.QA_FORCE_VISION === "1";
    const useHybrid = !forceVision && scenarios.length > 0 && existsSync(hybridSpecPath);
    const specPath = useHybrid ? hybridSpecPath : visionSpecPath;
    if (!existsSync(specPath)) {
      return { ok: false, error: `Chưa có file spec tại ${specPath} — chạy full pipeline trước` };
    }
    // Catalog/spec drift detection — if spec doesn't contain a test() block
    // for this caseId (vd catalog re-named after Generate), auto-regen spec
    // from current catalog (codegen, no AI call).
    if (useHybrid) {
      const { readFileSync } = await import("node:fs");
      const specContent = readFileSync(specPath, "utf8");
      const grepPattern = `test\\(["\\\`]${caseId}:`;
      if (!new RegExp(grepPattern).test(specContent)) {
        this.queue.appendLog(taskId, {
          t: 0,
          timestamp: new Date().toISOString(),
          stream: "system",
          text: `[regen] Case "${caseId}" không có trong spec — regen hybrid spec từ catalog hiện tại`,
        });
        try {
          const catalogPath = join("fixtures/specs", task.gameSlug, `${task.gameSlug}.test-cases.json`);
          if (existsSync(catalogPath)) {
            const { generateHybridTestCode } = await import("../ai/authoring.js");
            const { writeFileSync } = await import("node:fs");
            const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
            const code = generateHybridTestCode({
              gameSlug: task.gameSlug,
              harnessImportPath: "unused",
              envVarUrl: "GAME_URL",
              catalog,
            });
            if (code) {
              writeFileSync(specPath, code);
              this.queue.appendLog(taskId, {
                t: 0,
                timestamp: new Date().toISOString(),
                stream: "system",
                text: `[regen] ✓ Re-emitted ${specPath} from catalog (${catalog.cases?.length ?? "?"} cases)`,
              });
            }
          }
        } catch (err) {
          this.queue.appendLog(taskId, {
            t: 0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `[regen] Spec regen failed: ${(err as Error).message} — proceeding anyway (grep may still fail)`,
          });
        }
      }
    }
    const hintsAbsPath = resolve(join("fixtures/specs", task.gameSlug, "network-hints.json"));
    if (!existsSync(hintsAbsPath)) {
      return { ok: false, error: `Chưa có network-hints — chạy full pipeline trước` };
    }

    this.currentTaskId = taskId;
    const startedAt = Date.now();

    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `>>> Re-running single case: ${caseId} (mode=${useHybrid ? "hybrid/deterministic — $0" : "vision/LLM — $$$"})`,
    });
    // Reset case status → running
    this.queue.updateCaseResult(taskId, caseId, {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      durationMs: undefined,
      error: undefined,
    });

    const screenshotDir = resolve(join("fixtures", "tasks", taskId, "screenshots"));
    const playwrightJsonPath = resolve(
      join("fixtures", "tasks", taskId, `playwright-results.${caseId}.json`),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: taskId,
      QA_SCREENSHOT_DIR: screenshotDir,
      QA_HINTS_FILE: hintsAbsPath,
      QA_TOTAL_TESTS: "1", // single case → cuối cùng → harness keep-open dựa vào flag
      PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightJsonPath,
      QA_SLUG: task.gameSlug, // hybrid spec reads this to select scenarios
    };

    // Grep theo prefix `caseId:` (test titles format `${id}: ${name}`).
    const grep = `${caseId}:`;
    const caseReporterPath = resolve("src/runner/case-reporter.ts");
    const child = spawn(
      "npx",
      [
        "playwright",
        "test",
        specPath,
        `--grep=${grep}`,
        `--reporter=list,json,${caseReporterPath}`,
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(taskId, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(taskId, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", () => resolve(-1));
    });

    this.currentProcess = null;
    this.currentTaskId = null;

    const durationMs = Date.now() - startedAt;
    this.queue.appendLog(taskId, {
      t: durationMs,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `<<< Single case ${caseId} finished (exit ${exitCode}, ${(durationMs / 1000).toFixed(1)}s)`,
    });

    // Enrich case result với error/skip-reason từ Playwright JSON
    try {
      if (existsSync(playwrightJsonPath)) {
        const enriched = extractSingleCaseResult(
          JSON.parse(readFileSync(playwrightJsonPath, "utf8")),
          caseId,
        );
        if (enriched) {
          this.queue.updateCaseResult(taskId, caseId, enriched);
          if (enriched.error) {
            this.queue.appendLog(taskId, {
              t: durationMs,
              timestamp: new Date().toISOString(),
              stream: "system",
              text: `[case:${enriched.status}] ${caseId} — ${enriched.error}`,
            });
          }
        }
      }
    } catch (err) {
      this.queue.appendLog(taskId, {
        t: durationMs,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Could not parse single-case JSON: ${(err as Error).message}`,
      });
    }

    return { ok: true };
  }

  /**
   * Chạy statistical RTP sim cho slug. Trả về promise resolve khi xong.
   * Không spawn subprocess — call simulate() trực tiếp để stream progress qua log.
   *
   * @returns Promise<{ ok, error?, report? }>
   */
  async runStatsSim(
    taskId: string,
    opts: { spins: number; concurrency?: number; throttleMs?: number; historyAudit?: boolean },
  ): Promise<{ ok: boolean; error?: string; report?: unknown }> {
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác" };
    }

    const { simulate, formatReport, TokenExpiredError } = await import("../statistical/simulate.js");

    const startedAt = Date.now();
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `>>> Stats sim start: ${opts.spins} spins, concurrency=${opts.concurrency ?? 4}`,
    });

    // Load GameSpec → enable consistency check (server bug detection per spin).
    const { existsSync, readFileSync } = await import("node:fs");
    const specPath = join("fixtures/specs", task.gameSlug, `${task.gameSlug}.spec.json`);
    let spec = null;
    if (existsSync(specPath)) {
      try {
        spec = JSON.parse(readFileSync(specPath, "utf8"));
      } catch {}
    }

    try {
      const result = await simulate({
        slug: task.gameSlug,
        spins: opts.spins,
        concurrency: opts.concurrency,
        throttleMs: opts.throttleMs,
        progressEvery: Math.max(50, Math.floor(opts.spins / 20)),
        spec,
        historyAudit: opts.historyAudit ?? true,
      });

      const dur = Date.now() - startedAt;
      const consistencyTag = result.consistency
        ? `  consistency: ${result.consistency.payoutMismatches}❌ / ${result.consistency.spinsChecked} (${result.consistency.inconclusive} inconclusive)`
        : "";
      this.queue.appendLog(taskId, {
        t: dur,
        timestamp: new Date().toISOString(),
        stream: "system",
        text:
          `<<< Stats done: RTP=${((result.observedRTP ?? 0) * 100).toFixed(2)}% ` +
          `HF=${((result.hitFrequency ?? 0) * 100).toFixed(2)}% ` +
          `(${result.spinsSuccessful}/${result.spinsRequested} ok)` +
          consistencyTag,
      });

      // DB write-through: persist as TestRun + StatReport + ValidationErrors
      try {
        const { isDbEnabled, createTestRun, upsertStatReport, insertValidationErrors, updateTestRunStatus } = await import(
          "../db/index.js"
        );
        if (isDbEnabled()) {
          const testRunId = await createTestRun({
            gameCode: task.gameSlug,
            url: task.gameUrl,
            status: "running",
            totalSpins: opts.spins,
          });
          if (testRunId) {
            await updateTestRunStatus(testRunId, {
              startedAt: new Date(startedAt),
              endedAt: new Date(),
              completedSpins: result.spinsSuccessful,
              status: "completed",
            });
            await upsertStatReport({
              testRunId,
              totalSpins: result.spinsSuccessful,
              totalBet: result.totalBet,
              totalWin: result.totalWin,
              rtp: result.observedRTP,
              hitRate: result.hitFrequency,
              maxWin: result.maxWin,
              averageWin: result.averageWin,
              volatility: result.volatility,
              volatilityBand: result.volatilityBand,
              rtpConfidence95: result.rtpConfidence95,
              metrics: {
                featureFrequency: result.featureFrequency,
                symbolDistribution: result.symbolDistribution,
                winDistribution: result.winDistribution,
                maxWinMultiplier: result.maxWinMultiplier,
                consistency: result.consistency,
                source: "dashboard-run-stats",
              },
            });
            if (result.consistency && result.consistency.examples.length > 0) {
              await insertValidationErrors(
                result.consistency.examples.map((ex) => ({
                  testRunId,
                  errorType: "PAYOUT_MISMATCH",
                  severity: "error" as const,
                  expectedValue: ex.expected.toFixed(4),
                  actualValue: ex.actual.toFixed(4),
                  message: `spin#${ex.spinIndex}: server=${ex.actual.toFixed(4)} vs rule-engine=${ex.expected.toFixed(4)} (Δ=${ex.delta.toFixed(4)}) reels=${ex.reels.slice(0, 30)}`,
                })),
              );
              this.queue.appendLog(taskId, {
                t: Date.now() - startedAt,
                timestamp: new Date().toISOString(),
                stream: "system",
                text: `❌ Recorded ${result.consistency.examples.length} payout mismatch(es) → /api/test-runs/${testRunId}/errors`,
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[runStatsSim] DB persist failed: ${(err as Error).message}`);
      }

      // Persist report (filesystem)
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const outDir = "fixtures/statistical";
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outPath = join(outDir, `${task.gameSlug}-${stamp}.json`);
      writeFileSync(outPath, JSON.stringify(result, null, 2));

      // Log human-readable report
      for (const line of formatReport(result).split("\n")) {
        this.queue.appendLog(taskId, {
          t: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
          stream: "stdout",
          text: line,
        });
      }

      return { ok: true, report: { ...result, reportPath: outPath } };
    } catch (err) {
      const isTokenExpired = err instanceof TokenExpiredError;
      const msg = (err as Error).message;
      this.queue.appendLog(taskId, {
        t: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        stream: "stderr",
        text: `Stats failed${isTokenExpired ? " (token expired)" : ""}: ${msg}`,
      });
      return { ok: false, error: msg };
    }
  }

  /**
   * Kick off Playwright run cho hybrid spec (LLM pre-game + deterministic spin).
   * Fire-and-forget: response trả ngay, output stream qua existing SSE.
   *
   * Yêu cầu: worker rảnh (không có currentProcess), spec file tồn tại.
   */
  runHybridSpec(
    taskId: string,
    specPath: string,
    extraEnv: Record<string, string> = {},
  ): { ok: boolean; error?: string } {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };
    if (!existsSync(specPath)) {
      return { ok: false, error: `Spec không tồn tại: ${specPath}` };
    }

    this.currentTaskId = taskId;
    const startedAt = Date.now();
    const envFlags = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(" ");
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `>>> Running hybrid spec: ${specPath}${envFlags ? ` (${envFlags})` : ""}`,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: taskId,
    };

    const child = spawn(
      "npx",
      ["playwright", "test", specPath, "--reporter=list"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(taskId, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(taskId, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    child.on("exit", (code) => {
      this.currentProcess = null;
      this.currentTaskId = null;
      const dur = Date.now() - startedAt;
      this.queue.appendLog(taskId, {
        t: dur,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `<<< Hybrid spec finished (exit ${code}, ${(dur / 1000).toFixed(1)}s)`,
      });
    });
    return { ok: true };
  }

  /**
   * Run `auto-play.ts` with QA_CAPTURE_PREGAME=1 so the pre-game vision flow
   * records click sequence + baseline. Fire-and-forget; output streams via SSE.
   *
   * Use case: dashboard button "Record Pre-game" — captures the click sequence
   * needed for $0 deterministic regression replay.
   */
  /**
   * Phase 2.5: spawn record-ui-flows.ts cho slug. Stream output qua task log.
   * Trả về promise resolve khi xong. Fire-and-forget pattern giống pregame.
   */
  runUiFlowRecording(taskId: string): { ok: boolean; error?: string } {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };

    this.currentTaskId = taskId;
    const startedAt = Date.now();
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: ">>> Recording UI flows (Phase 2.5 — replay_or_vision cases)",
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: taskId,
    };

    const child = spawn(
      "npx",
      ["tsx", "src/runner/record-ui-flows.ts", task.gameSlug],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(taskId, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(taskId, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    child.on("exit", (code) => {
      this.currentProcess = null;
      this.currentTaskId = null;
      const dur = Date.now() - startedAt;
      this.queue.appendLog(taskId, {
        t: dur,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `<<< UI flow recording finished (exit ${code}, ${(dur / 1000).toFixed(1)}s)`,
      });
    });
    return { ok: true };
  }

  /**
   * Phase 2.6: spawn capture-fs-via-buy.ts. Click Buy Feature → capture FS chain
   * → save scenarios/{slug}/free_spin_chain.json. Cần Buy Feature có sẵn UI.
   */
  runCaptureFsViaBuy(taskId: string): { ok: boolean; error?: string } {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };

    this.currentTaskId = taskId;
    const startedAt = Date.now();
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: ">>> Capturing FS chain via Buy Feature (Phase 2.6)",
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: taskId,
    };

    const child = spawn(
      "npx",
      ["tsx", "src/runner/capture-fs-via-buy.ts", task.gameSlug],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(taskId, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(taskId, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    child.on("exit", (code) => {
      this.currentProcess = null;
      this.currentTaskId = null;
      const dur = Date.now() - startedAt;
      this.queue.appendLog(taskId, {
        t: dur,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `<<< Capture FS via Buy finished (exit ${code}, ${(dur / 1000).toFixed(1)}s)`,
      });
    });
    return { ok: true };
  }

  runPreGameRecording(taskId: string): { ok: boolean; error?: string } {
    if (this.currentProcess) {
      return { ok: false, error: "Worker đang bận với task khác — đợi xong" };
    }
    const task = this.queue.get(taskId);
    if (!task) return { ok: false, error: "Task không tồn tại" };

    this.currentTaskId = taskId;
    const startedAt = Date.now();
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: ">>> Recording pre-game click sequence (QA_CAPTURE_PREGAME=1)",
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: taskId,
      QA_CAPTURE_PREGAME: "1",
    };

    const child = spawn("npx", ["tsx", "src/auto-play.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(taskId, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(taskId, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    child.on("exit", (code) => {
      this.currentProcess = null;
      this.currentTaskId = null;
      const dur = Date.now() - startedAt;
      this.queue.appendLog(taskId, {
        t: dur,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `<<< Pre-game recording finished (exit ${code}, ${(dur / 1000).toFixed(1)}s)`,
      });
    });
    return { ok: true };
  }

  /**
   * Best-effort scenario extraction sau Collect phase. Đọc recording mới nhất
   * cho slug, phân loại spin responses, ghi vào fixtures/scenarios/{slug}/.
   *
   * Chạy sync ngay trong event handler — extractor file I/O thuần, không async,
   * vài chục KB JSONL → typical < 50ms. Nếu task slug không tìm được recording
   * (vd Collect chạy nhưng spin response chưa được capture) thì silent no-op.
   */
  private maybeExtractScenarios(taskId: string, t0: number): void {
    const task = this.queue.get(taskId);
    if (!task) return;
    try {
      const result = extractLatestForSlug(task.gameSlug);
      const text = result.scenarios.length > 0
        ? `Auto-extracted ${result.scenarios.length} scenario(s) → fixtures/scenarios/${task.gameSlug}/`
        : `No scenarios extracted (no spin responses found in recording${result.recording ? "" : "; no recording"}).`;
      this.queue.appendLog(taskId, {
        t: Date.now() - t0,
        timestamp: new Date().toISOString(),
        stream: "system",
        text,
      });
    } catch (err) {
      this.queue.appendLog(taskId, {
        t: Date.now() - t0,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Scenario extraction failed (non-fatal): ${(err as Error).message}`,
      });
    }
  }

  cancelCurrent(taskId: string): boolean {
    if (this.currentTaskId !== taskId || !this.currentProcess) return false;
    if (this.cancellingTaskIds.has(taskId)) return true; // đã gọi rồi
    this.cancellingTaskIds.add(taskId);

    const proc = this.currentProcess;
    this.queue.appendLog(taskId, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: "Cancel requested — sending SIGINT to subprocess...",
    });

    this.killProcess(proc, "SIGINT");

    // Escalate: SIGTERM sau 5s, SIGKILL sau 10s nếu chưa exit
    setTimeout(() => {
      if (proc.exitCode == null) {
        this.queue.appendLog(taskId, {
          t: 5_000,
          timestamp: new Date().toISOString(),
          stream: "system",
          text: "Still running after 5s — escalating to SIGTERM",
        });
        this.killProcess(proc, "SIGTERM");
      }
    }, 5_000);
    setTimeout(() => {
      if (proc.exitCode == null) {
        this.queue.appendLog(taskId, {
          t: 10_000,
          timestamp: new Date().toISOString(),
          stream: "system",
          text: "Still running after 10s — forcing SIGKILL",
        });
        this.killProcess(proc, "SIGKILL");
      }
    }, 10_000);

    return true;
  }

  private poll() {
    if (this.stopped) return;
    if (!this.currentTaskId) {
      const next = this.queue.nextQueued();
      if (next) {
        void this.runTask(next);
      }
    }
    this.timer = setTimeout(() => this.poll(), 1_000);
  }

  private async runTask(task: Task) {
    this.currentTaskId = task.id;
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const phase = task.nextPhase ?? "all";
    this.queue.setStatus(task.id, "running", { startedAt: startedAtIso });

    // DB write-through: upsert TestRun when this run will actually fire spins.
    // Run phase + 'all' phase both end up running Playwright + producing spin
    // events. Generate/collect-only phases don't (no spins → no TestRun row).
    if (phase === "run" || phase === "all") {
      void onRunPhaseStart(task);
    }

    this.queue.appendLog(task.id, {
      t: 0,
      timestamp: startedAtIso,
      stream: "system",
      text: `Starting task ${task.id} — ${task.providerName} / ${task.gameSlug} [phase=${phase}]`,
    });

    const screenshotDir = resolve(join("fixtures", "tasks", task.id, "screenshots"));
    const playwrightJsonPath = resolve(join("fixtures", "tasks", task.id, "playwright-results.json"));
    // Auto-capture pre-game clicks during Collect / All phases. Cost is
    // negligible (writes 1 JSON + 1 baseline PNG) and bundles the recording
    // step into the existing vision pass — no separate user action needed.
    // Disable via QA_NO_CAPTURE_PREGAME=1 if recording is unwanted.
    const capturePreGame =
      (phase === "collect" || phase === "all") &&
      process.env.QA_NO_CAPTURE_PREGAME !== "1";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_URL: task.gameUrl,
      QA_TASK_ID: task.id,
      QA_PHASE: phase,
      QA_SCREENSHOT_DIR: screenshotDir,
      QA_SPINS_PER_TEST: String(task.spinsPerTest),
      QA_FORCE: task.forceRecollect ? "1" : "",
      PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightJsonPath,
      QA_PLAYWRIGHT_JSON: playwrightJsonPath, // cho generate-and-run truyền tiếp vào --reporter
      ...(capturePreGame ? { QA_CAPTURE_PREGAME: "1" } : {}),
    };

    const child = spawn("npx", ["tsx", "src/generate-and-run.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // detached=true → child có process group riêng → kill(-pid) kill cả cây
      // (Playwright browser, tsx, v.v.). Chỉ dùng ở Unix; Windows skip silently.
      detached: process.platform !== "win32",
    });
    this.currentProcess = child;

    const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(task.id, name, line, startedAt);
      });
      stream.on("end", () => {
        if (buf) this.handleLine(task.id, name, buf, startedAt);
      });
    };
    if (child.stdout) pipe(child.stdout, "stdout");
    if (child.stderr) pipe(child.stderr, "stderr");

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", (err) => {
        this.queue.appendLog(task.id, {
          t: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
          stream: "system",
          text: `Spawn error: ${err.message}`,
        });
        resolve(-1);
      });
    });

    this.currentProcess = null;
    this.currentTaskId = null;
    const wasCancelled = this.cancellingTaskIds.has(task.id);
    this.cancellingTaskIds.delete(task.id);

    const finishedAt = new Date().toISOString();
    const finishedAtDate = new Date(finishedAt);
    const durationMs = Date.now() - startedAt;
    const status = exitCode === 0 ? "completed" : wasCancelled || exitCode === null ? "cancelled" : "failed";
    this.queue.setStatus(task.id, status, {
      finishedAt,
      durationMs,
      exitCode,
      lastError: status === "failed" ? `Pipeline exited with code ${exitCode}` : null,
      nextPhase: null, // clear sau khi run xong — runner cần signal mới (button click) để chạy tiếp
    });

    // DB write-through: close TestRun + persist final stat report.
    // Only fires for run/all phases (TestRun row only created in those cases).
    if (phase === "run" || phase === "all") {
      const updated = this.queue.get(task.id);
      if (updated) void onTaskComplete(updated, { status, endedAt: finishedAtDate });
    }
    this.queue.appendLog(task.id, {
      t: durationMs,
      timestamp: finishedAt,
      stream: "system",
      text: `Task ${status} (exit ${exitCode}, duration ${(durationMs / 1000).toFixed(1)}s)`,
    });

    // Build case report (merge catalog + live results + Playwright JSON)
    try {
      const updatedTask = this.queue.get(task.id);
      if (updatedTask) {
        const catalogPath = resolve(join("fixtures", "specs", task.gameSlug, `${task.gameSlug}.test-cases.json`));
        const { report, markdown } = buildCaseReport({
          task: updatedTask,
          catalogPath: existsSync(catalogPath) ? catalogPath : null,
          playwrightJsonPath: existsSync(playwrightJsonPath) ? playwrightJsonPath : null,
        });
        writeCaseReport(this.queue.taskDir(task.id), report, markdown);
        this.queue.appendLog(task.id, {
          t: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
          stream: "system",
          text: `Case report written: case-report.json + case-report.md (${report.stats.passed} passed, ${report.stats.failed} failed, ${report.stats.skipped} skipped)`,
        });
        // Enrich caseResults với error messages + stack + attachments + category
        for (const c of report.cases) {
          if (c.error || c.durationMs != null || (c.attachments && c.attachments.length)) {
            const cat =
              c.status === "failed" || c.status === "skipped"
                ? categorizeError(c.error, c.error_stack)
                : null;
            this.queue.updateCaseResult(task.id, c.id, {
              status: c.status,
              name: c.name,
              durationMs: c.durationMs,
              error: c.error,
              errorStack: c.error_stack,
              attachments: c.attachments,
              errorCategory: cat?.category,
              errorTitle: cat?.title,
              errorSummary: cat?.summary,
              errorSuggestion: cat?.suggestion,
              errorLocation: cat?.location,
            });
          }
        }
      }
    } catch (err) {
      this.queue.appendLog(task.id, {
        t: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Case report generation failed: ${(err as Error).message}`,
      });
    }
  }

  private handleLine(taskId: string, stream: "stdout" | "stderr", line: string, t0: number) {
    if (!line) return;

    // EVENT:<kind> {...json...}
    const eventMatch = line.match(/^EVENT:(\w+)\s+(\{.*\})\s*$/);
    if (eventMatch) {
      try {
        const data = JSON.parse(eventMatch[2]!);
        if (eventMatch[1] === "test_mode" && typeof data.mode === "string") {
          // Surface effective test mode (hybrid vs vision) to UI via log line
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `[mode=${data.mode}] ${data.mode === "hybrid" ? `${data.scenarios} scenarios available — using deterministic spin` : "no scenarios — using vision-driven flow ($$$)"}`,
          });
        } else if (eventMatch[1] === "spin" && data.kind === "spin") {
          const ev = { ...data, taskId } as TaskSpinEvent;
          this.queue.appendSpinEvent(taskId, ev);
          // DB write-through (fire-and-forget; no-op when DB disabled)
          const t = this.queue.get(taskId);
          if (t) void onSpinEvent(taskId, t.gameSlug, ev);
        } else if (eventMatch[1] === "catalog_ready" && Array.isArray(data.caseIds)) {
          this.queue.initCaseCatalog(taskId, data.caseIds);
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `catalog ready: ${data.caseIds.length} cases (${data.emittedTests} test blocks)`,
          });
        } else if (eventMatch[1] === "phase_done" && typeof data.stage === "string") {
          // Pipeline finished 1 stage (collect / generate / run) — advance task.stage.
          this.queue.advanceStage(taskId, data.stage);
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `Phase ${data.phase} done → stage=${data.stage}`,
          });
          // Sau Collect: auto-extract scenarios cho deterministic test layer.
          // Best-effort — không fail task nếu extract lỗi (recording có thể chưa
          // có spin response valid, vd game crashed trước khi spin).
          if (data.phase === "collect") {
            this.maybeExtractScenarios(taskId, t0);
          }
        } else if (eventMatch[1] === "case_end" && typeof data.caseId === "string") {
          // LIVE update khi 1 test xong — đầy đủ error + stack + attachments,
          // không đợi cả run kết thúc.
          const cat =
            data.status === "failed" || data.status === "skipped"
              ? categorizeError(data.error, data.errorStack)
              : null;
          const caseResult = {
            id: data.caseId,
            status: data.status,
            durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
            error: data.error ?? undefined,
            errorStack: data.errorStack ?? undefined,
            attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
            finishedAt: data.timestamp ?? new Date().toISOString(),
            errorCategory: cat?.category,
            errorTitle: cat?.title,
            errorSummary: cat?.summary,
            errorSuggestion: cat?.suggestion,
            errorLocation: cat?.location,
          };
          this.queue.updateCaseResult(taskId, data.caseId, caseResult);
          // DB write-through (fire-and-forget; only writes when status=failed)
          void onCaseEnd(taskId, data.caseId, caseResult);
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `[case:${data.status}] ${data.caseId}${data.error ? ` — ${(String(data.error).split("\n")[0] ?? "").slice(0, 200)}` : ""}`,
          });
        } else if (eventMatch[1] === "case_start" && typeof data.caseId === "string") {
          // Mark case là RUNNING ngay khi test bắt đầu (Playwright list reporter
          // chỉ in status cuối — không có signal khi test bắt đầu).
          this.queue.updateCaseResult(taskId, data.caseId, {
            status: "running",
            startedAt: data.timestamp ?? new Date().toISOString(),
            // Reset error/duration cũ nếu re-run
            error: undefined,
            errorStack: undefined,
            durationMs: undefined,
            attachments: undefined,
          });
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `[case:running] ${data.caseId}`,
          });
        } else {
          this.queue.appendLog(taskId, {
            t: Date.now() - t0,
            timestamp: new Date().toISOString(),
            stream: "system",
            text: `event=${eventMatch[1]} ${eventMatch[2]}`,
          });
        }
        return;
      } catch {
        // fall through
      }
    }

    // Parse Playwright list reporter output cho per-case status.
    // Format: "  ✓  3 [chromium] › tests/generated/X.spec.ts:11:3 › X — test cases › case-id: Case Name (45.2s)"
    // hoặc: "  ✘  5 [chromium] › ... › case-id: Name (30s)"
    // hoặc: "  -  7 [chromium] › ... › case-id (skipped)"
    const pwMatch = line.match(
      /^\s*(✓|✘|-|×)\s+\d+\s+\[.*?\]\s+›\s+.*?›\s+.*?›\s+(.+?)\s*(?:\(([\d.]+m?s?)\))?\s*$/,
    );
    if (pwMatch) {
      const symbol = pwMatch[1];
      const testTitle = (pwMatch[2] ?? "").trim();
      const durText = pwMatch[3];
      const status: "passed" | "failed" | "skipped" =
        symbol === "✓" ? "passed" : symbol === "-" ? "skipped" : "failed";
      // testTitle: "case-id: Case Name" hoặc chỉ "case-id"
      const idMatch = testTitle.match(/^([\w-]+)(?::\s+(.+))?$/);
      const caseId = idMatch?.[1] ?? testTitle;
      const caseName = idMatch?.[2] ?? undefined;
      const durationMs = durText ? parseDuration(durText) : undefined;
      this.queue.updateCaseResult(taskId, caseId, {
        status,
        name: caseName,
        durationMs,
        finishedAt: new Date().toISOString(),
      });
      // Log để user thấy trong stream
      this.queue.appendLog(taskId, {
        t: Date.now() - t0,
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `[case:${status}] ${caseId}${caseName ? `: ${caseName}` : ""}${durText ? ` (${durText})` : ""}`,
      });
    }

    this.queue.appendLog(taskId, {
      t: Date.now() - t0,
      timestamp: new Date().toISOString(),
      stream,
      text: line,
    });
  }
}
