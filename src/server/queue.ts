import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseGameUrl } from "../utils/url.js";
import { cleanGame, cleanTaskFolder, cleanGlobalReports } from "../utils/cleanup.js";
import type { Task, TaskLogEntry, TaskSpinEvent, TaskStatus, TaskStage, TaskPhase, CaseResult, CaseStatus } from "./types.js";

const TASKS_ROOT = "fixtures/tasks";
const INDEX_PATH = join(TASKS_ROOT, "index.json");

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private subscribers = new Map<string, Set<(ev: StreamEvent) => void>>();

  constructor() {
    mkdirSync(TASKS_ROOT, { recursive: true });
    this.load();
  }

  private load() {
    if (!existsSync(INDEX_PATH)) return;
    try {
      const arr = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as Task[];
      for (const t of arr) {
        // Resurrect tasks: any "running" at restart → "failed" (crash)
        if (t.status === "running") {
          t.status = "failed";
          t.lastError = "Server restart during run";
          t.finishedAt = new Date().toISOString();
        }
        // Backfill new fields cho tasks cũ (trước stage refactor)
        if (!("stage" in t)) (t as Task).stage = "init";
        if (!("nextPhase" in t)) (t as Task).nextPhase = null;
        this.tasks.set(t.id, t);
      }
    } catch (e) {
      console.error("Failed to load tasks index:", e);
    }
  }

  private persist() {
    const arr = [...this.tasks.values()].sort(
      (a, b) => (b.createdAt > a.createdAt ? 1 : -1),
    );
    writeFileSync(INDEX_PATH, JSON.stringify(arr, null, 2));
  }

  taskDir(taskId: string): string {
    const dir = join(TASKS_ROOT, taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  list(): Task[] {
    return [...this.tasks.values()].sort(
      (a, b) => (b.createdAt > a.createdAt ? 1 : -1),
    );
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  createTask(
    gameUrl: string,
    opts: {
      spinsPerTest?: number;
      forceRecollect?: boolean;
      /**
       * Nếu true: enqueue task ngay với phase "all" (legacy behaviour).
       * Nếu false (default mới): tạo task ở trạng thái idle (status=completed, stage=init),
       * user sẽ click button Collect/Generate/Run để trigger từng phase riêng.
       */
      autoStartAll?: boolean;
    } = {},
  ): Task {
    // Kiểm tra trùng: nếu có task đang queued/running cùng gameUrl, reject
    for (const t of this.tasks.values()) {
      if (t.gameUrl === gameUrl && (t.status === "queued" || t.status === "running")) {
        throw new Error("An active task with this gameUrl already exists");
      }
    }

    const info = parseGameUrl(gameUrl);
    const id = randomUUID();
    const now = new Date().toISOString();
    const autoStart = opts.autoStartAll === true;
    const task: Task = {
      id,
      gameUrl,
      gameSlug: info.gameSlug,
      provider: info.provider,
      providerName: info.providerName,
      host: info.host,
      // Idle = completed-style nhưng durationMs=null phân biệt (chưa từng chạy).
      // Nếu autoStartAll → queued ngay với nextPhase="all".
      status: autoStart ? "queued" : "completed",
      stage: "init",
      nextPhase: autoStart ? "all" : null,
      spinsPerTest: opts.spinsPerTest ?? 3,
      forceRecollect: opts.forceRecollect ?? false,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      summary: null,
      caseStats: null,
      caseResults: null,
      lastError: null,
    };
    this.tasks.set(id, task);
    this.taskDir(id);
    this.persist();
    this.broadcast(id, { type: "task_created", task });
    return task;
  }

  /**
   * Mark task ready để runner pick lên với phase tương ứng.
   * Validate: phase chỉ được trigger nếu prerequisite stage đã đạt.
   */
  enqueuePhase(id: string, phase: TaskPhase): { ok: boolean; error?: string; task?: Task } {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: "Task không tồn tại" };
    if (t.status === "running" || t.status === "queued") {
      return { ok: false, error: `Task đang ${t.status}, đợi xong rồi enqueue phase mới` };
    }
    // Validate stage prerequisite
    if (phase === "generate" && t.stage === "init") {
      return { ok: false, error: "Cần chạy Collect trước khi Generate" };
    }
    if (phase === "run" && t.stage !== "catalog_ready" && t.stage !== "tests_done") {
      return { ok: false, error: "Cần chạy Generate trước khi Run" };
    }

    t.status = "queued";
    t.nextPhase = phase;
    // Reset run-output fields nhưng GIỮ stage (để biết progress trước đó)
    t.startedAt = null;
    t.finishedAt = null;
    t.durationMs = null;
    t.exitCode = null;
    t.lastError = null;
    // Reset toàn bộ case state ở mọi phase — user yêu cầu xóa log cũ mỗi lần
    // chạy. case-report file trên disk cũng xóa để buildCaseReport tiếp theo
    // không merge với output cũ.
    t.caseStats = null;
    t.caseResults = null;
    t.summary = null;
    const taskFolder = this.taskDir(id);
    for (const f of ["case-report.json", "case-report.md"]) {
      const p = join(taskFolder, f);
      if (existsSync(p)) {
        try { rmSync(p); } catch {}
      }
    }
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });
    return { ok: true, task: t };
  }

  /**
   * Cập nhật stage sau khi 1 phase chạy xong (runner gọi từ EVENT:phase_done).
   */
  advanceStage(id: string, stage: TaskStage) {
    const t = this.tasks.get(id);
    if (!t) return;
    // Chỉ tiến tới — không lùi
    const order: TaskStage[] = ["init", "context_ready", "catalog_ready", "tests_done"];
    if (order.indexOf(stage) > order.indexOf(t.stage)) {
      t.stage = stage;
      this.persist();
      this.broadcast(id, { type: "task_updated", task: t });
    }
  }

  nextQueued(): Task | null {
    // Nếu đang có task running, không pick
    for (const t of this.tasks.values()) {
      if (t.status === "running") return null;
    }
    for (const t of this.tasks.values()) {
      if (t.status === "queued") return t;
    }
    return null;
  }

  setStatus(id: string, status: TaskStatus, patch: Partial<Task> = {}) {
    const t = this.tasks.get(id);
    if (!t) return;
    Object.assign(t, patch, { status });
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });
  }

  appendLog(id: string, entry: TaskLogEntry) {
    const path = join(this.taskDir(id), "log.jsonl");
    appendFileSync(path, JSON.stringify(entry) + "\n");
    this.broadcast(id, { type: "log", taskId: id, entry });
  }

  appendSpinEvent(id: string, event: TaskSpinEvent) {
    const path = join(this.taskDir(id), "events.jsonl");
    appendFileSync(path, JSON.stringify(event) + "\n");
    const t = this.tasks.get(id);
    if (t) {
      t.summary ??= { totalBet: 0, totalWin: 0, spinCount: 0, rtp: null };
      if (event.betAmount != null) t.summary.totalBet += event.betAmount;
      if (event.winAmount != null) t.summary.totalWin += event.winAmount;
      t.summary.spinCount = event.spinNumber;
      t.summary.rtp = t.summary.totalBet > 0 ? t.summary.totalWin / t.summary.totalBet : null;
      this.persist();
      this.broadcast(id, { type: "task_updated", task: t });
    }
    this.broadcast(id, { type: "spin", taskId: id, event });
  }

  /** Khởi tạo caseResults khi nhận catalog từ Phase B */
  initCaseCatalog(id: string, caseIds: string[]) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.caseResults = {};
    for (const cid of caseIds) {
      t.caseResults[cid] = { id: cid, status: "pending" };
    }
    t.caseStats = {
      total: caseIds.length,
      passed: 0,
      failed: 0,
      skipped: 0,
      pending: caseIds.length,
    };
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });
  }

  /**
   * Reconcile caseResults với catalog IDs hiện tại. Khi catalog regen ngoài
   * Phase B (vd direct edit, AI rename), caseResults có thể có stale IDs.
   * Smart sync:
   *   - Giữ entries có ID match catalog → preserve status
   *   - Drop entries có ID không trong catalog (stale)
   *   - Add entries cho catalog IDs mới (status=pending)
   *   - Recompute caseStats
   *
   * Trả về: số lượng entry stale đã drop + added.
   */
  reconcileCaseCatalog(id: string, catalogIds: string[]): {
    kept: number;
    dropped: number;
    added: number;
  } {
    const t = this.tasks.get(id);
    if (!t) return { kept: 0, dropped: 0, added: 0 };
    const current = t.caseResults ?? {};
    const catalogSet = new Set(catalogIds);
    const next: Record<string, CaseResult> = {};
    let kept = 0;
    let dropped = 0;
    let added = 0;
    // Preserve match
    for (const cid of catalogIds) {
      if (current[cid]) {
        next[cid] = current[cid]!;
        kept++;
      } else {
        next[cid] = { id: cid, status: "pending" };
        added++;
      }
    }
    // Count drops (entries in current but not in catalog)
    for (const cid of Object.keys(current)) {
      if (!catalogSet.has(cid)) dropped++;
    }
    if (dropped === 0 && added === 0) {
      return { kept, dropped, added }; // no-op
    }
    t.caseResults = next;
    // Recompute caseStats
    const stats = { total: catalogIds.length, passed: 0, failed: 0, skipped: 0, pending: 0 };
    for (const r of Object.values(next)) {
      if (r.status === "passed") stats.passed++;
      else if (r.status === "failed") stats.failed++;
      else if (r.status === "skipped") stats.skipped++;
      else stats.pending++;
    }
    t.caseStats = stats;
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });
    return { kept, dropped, added };
  }

  updateCaseResult(id: string, caseId: string, patch: Partial<CaseResult>) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (!t.caseResults) t.caseResults = {};
    const prev = t.caseResults[caseId] ?? { id: caseId, status: "pending" as CaseStatus };
    const next: CaseResult = { ...prev, ...patch };
    t.caseResults[caseId] = next;

    // Recompute stats
    const stats = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };
    for (const c of Object.values(t.caseResults)) {
      stats.total++;
      if (c.status === "passed") stats.passed++;
      else if (c.status === "failed") stats.failed++;
      else if (c.status === "skipped") stats.skipped++;
      else if (c.status === "pending" || c.status === "running") stats.pending++;
    }
    t.caseStats = stats;
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });
    this.broadcast(id, { type: "case_result", taskId: id, caseId, result: next });
  }

  retry(id: string): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.status === "running" || t.status === "queued") return t;

    const removed: string[] = [];

    // 1. Game-scoped artifacts: rules / options / recordings / specs / generated spec
    try {
      const r = cleanGame(t.gameSlug);
      removed.push(...r.removed);
    } catch (err) {
      console.warn(`[retry] cleanGame failed:`, (err as Error).message);
    }

    // 2. Task folder: screenshots + log.jsonl + events.jsonl + case-report + playwright-results
    try {
      cleanTaskFolder(id);
      removed.push(`fixtures/tasks/${id}`);
    } catch (err) {
      console.warn(`[retry] cleanTaskFolder failed:`, (err as Error).message);
    }

    // 3. Global Playwright outputs: reports/html, test-results, playwright-report
    try {
      const r = cleanGlobalReports();
      removed.push(...r.removed);
    } catch (err) {
      console.warn(`[retry] cleanGlobalReports failed:`, (err as Error).message);
    }

    console.log(
      `[retry] cleaned ${removed.length} paths for task ${id} / game ${t.gameSlug}:\n  - ${removed.join("\n  - ")}`,
    );

    // 4. Reset task state — không còn dữ liệu cũ leak ra UI
    t.status = "queued";
    t.stage = "init"; // retry = redo from scratch
    t.nextPhase = "all";
    t.startedAt = null;
    t.finishedAt = null;
    t.durationMs = null;
    t.exitCode = null;
    t.lastError = null;
    t.summary = null;
    t.caseStats = null;
    t.caseResults = null;
    this.persist();
    this.broadcast(id, { type: "task_updated", task: t });

    // Append vào log mới (tạo lại task folder) để user thấy retry đã clean những gì
    this.appendLog(id, {
      t: 0,
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `[retry] Cleared ${removed.length} paths: ${removed.map((p) => p.replace(/^.*\//, "")).join(", ")}`,
    });

    return t;
  }

  /**
   * Xóa hẳn 1 task khỏi index + xóa toàn bộ artifact:
   * - task folder (logs, events, screenshots, case-report)
   * - game artifacts (rules / options / recordings / specs / generated test) NẾU
   *   không còn task khác cùng gameSlug — tránh phá vỡ task khác đang dùng chung spec.
   * - global Playwright reports (xóa bất kể) — UI chỉ hiển thị run mới nhất, an toàn để wipe.
   *
   * Không cho phép xóa task đang queued/running (caller phải cancel trước).
   */
  delete(id: string): { ok: boolean; error?: string; removed?: string[] } {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: "Task không tồn tại" };
    if (t.status === "queued" || t.status === "running") {
      return { ok: false, error: `Task đang ${t.status} — cancel trước khi xóa` };
    }

    const removed: string[] = [];
    const slug = t.gameSlug;

    // Task folder
    try {
      cleanTaskFolder(id);
      removed.push(`fixtures/tasks/${id}`);
    } catch (err) {
      console.warn(`[delete] cleanTaskFolder failed:`, (err as Error).message);
    }

    // Remove from in-memory index BEFORE checking siblings,
    // để cleanGame nhìn đúng "có task khác cùng slug không".
    this.tasks.delete(id);

    // Game artifacts: chỉ wipe nếu không còn task nào cùng slug
    const stillUsed = [...this.tasks.values()].some((other) => other.gameSlug === slug);
    if (!stillUsed) {
      try {
        const r = cleanGame(slug);
        removed.push(...r.removed);
      } catch (err) {
        console.warn(`[delete] cleanGame failed:`, (err as Error).message);
      }
      try {
        const r = cleanGlobalReports();
        removed.push(...r.removed);
      } catch (err) {
        console.warn(`[delete] cleanGlobalReports failed:`, (err as Error).message);
      }
    }

    this.persist();
    this.subscribers.delete(id);
    this.broadcast(id, { type: "task_deleted", taskId: id });

    console.log(
      `[delete] removed task ${id} / game ${slug} — ${removed.length} paths cleaned${stillUsed ? " (game artifacts kept — other tasks share slug)" : ""}`,
    );
    return { ok: true, removed };
  }

  /**
   * Cancel queued task (đánh dấu cancelled ngay).
   * Cho running task, caller (server) phải gọi runner.cancelCurrent() riêng.
   */
  cancel(id: string): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.status === "queued") {
      t.status = "cancelled";
      t.nextPhase = null;
      t.finishedAt = new Date().toISOString();
      this.persist();
      this.broadcast(id, { type: "task_updated", task: t });
    }
    return t;
  }

  readLog(id: string): TaskLogEntry[] {
    const path = join(this.taskDir(id), "log.jsonl");
    if (!existsSync(path)) return [];
    const out: TaskLogEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  readSpinEvents(id: string): TaskSpinEvent[] {
    const path = join(this.taskDir(id), "events.jsonl");
    if (!existsSync(path)) return [];
    const out: TaskSpinEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  subscribe(taskId: string, cb: (ev: StreamEvent) => void): () => void {
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set();
      this.subscribers.set(taskId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set?.size === 0) this.subscribers.delete(taskId);
    };
  }

  subscribeAll(cb: (ev: StreamEvent) => void): () => void {
    return this.subscribe("*", cb);
  }

  private broadcast(taskId: string, ev: StreamEvent) {
    for (const cb of this.subscribers.get(taskId) ?? []) cb(ev);
    for (const cb of this.subscribers.get("*") ?? []) cb(ev);
  }
}

export type StreamEvent =
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; taskId: string }
  | { type: "log"; taskId: string; entry: TaskLogEntry }
  | { type: "spin"; taskId: string; event: TaskSpinEvent }
  | { type: "case_result"; taskId: string; caseId: string; result: CaseResult };
