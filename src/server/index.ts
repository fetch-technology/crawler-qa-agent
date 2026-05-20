import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { config as loadEnv } from "dotenv";
import { TaskQueue, type StreamEvent } from "./queue.js";
import { TaskRunner } from "./runner.js";

loadEnv();

const PORT = Number(process.env.PORT ?? 3200);
const PUBLIC_DIR = "public";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const queue = new TaskQueue();
const runner = new TaskRunner(queue);
runner.start();

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveStatic(url: string, res: ServerResponse): boolean {
  const safePath = normalize(url === "/" ? "/index.html" : url).replace(/^\/+/, "");
  if (safePath.includes("..")) {
    res.writeHead(403);
    res.end("forbidden");
    return true;
  }
  const full = join(PUBLIC_DIR, safePath);
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const mime = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
  const data = readFileSync(full);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
  return true;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // --- API routes ---
  if (url === "/api/tasks" && method === "GET") {
    sendJson(res, 200, queue.list());
    return;
  }

  if (url === "/api/tasks" && method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const gameUrl = typeof body?.gameUrl === "string" ? body.gameUrl.trim() : "";
      if (!gameUrl) return sendJson(res, 400, { error: "gameUrl is required" });
      try {
        new URL(gameUrl);
      } catch {
        return sendJson(res, 400, { error: "Invalid URL" });
      }
      const spinsPerTest = typeof body?.spinsPerTest === "number" ? body.spinsPerTest : undefined;
      const forceRecollect = body?.forceRecollect === true;
      // autoStartAll mặc định false → user phải click button Collect/Generate/Run.
      // Set true để giữ legacy behaviour (pipeline chạy hết một mạch).
      const autoStartAll = body?.autoStartAll === true;
      const task = queue.createTask(gameUrl, { spinsPerTest, forceRecollect, autoStartAll });
      return sendJson(res, 201, task);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // --- Game Analyzer report ---
  const analyzerMatch = url.match(/^\/api\/analyzer\/([^/?]+)(?:\?.*)?$/);
  if (analyzerMatch && method === "GET") {
    try {
      const slug = decodeURIComponent(analyzerMatch[1]!);
      const path = join("fixtures", "analyzers", `${slug}.json`);
      if (!existsSync(path)) {
        return sendJson(res, 404, { error: `No analyzer report for ${slug}` });
      }
      const data = JSON.parse(readFileSync(path, "utf8"));
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  // --- DB-backed test-run history (env-gated by DATABASE_URL) ---
  if (url === "/api/test-runs" && method === "GET") {
    try {
      const { listTestRuns, isDbEnabled } = await import("../db/index.js");
      if (!isDbEnabled()) return sendJson(res, 200, { enabled: false, runs: [] });
      const runs = await listTestRuns({ limit: 100 });
      return sendJson(res, 200, { enabled: true, runs });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  // DELETE /api/test-runs?gameCode=X (wipe by slug) hoặc ?all=1 (nuke all)
  // Also wipes fixtures/statistical/{slug}-*.json filesystem reports by default.
  // Pass ?keepFiles=1 to preserve filesystem artifacts.
  if (url.startsWith("/api/test-runs?") && method === "DELETE") {
    try {
      const { deleteTestRunsByGame, deleteAllTestRuns, isDbEnabled } = await import("../db/index.js");
      if (!isDbEnabled()) return sendJson(res, 503, { error: "DB not enabled" });
      const u = new URL(req.url ?? "/", "http://x");
      const gameCode = u.searchParams.get("gameCode");
      const all = u.searchParams.get("all") === "1";
      const keepFiles = u.searchParams.get("keepFiles") === "1";

      // Wipe filesystem stats reports (matching scope)
      let filesDeleted = 0;
      if (!keepFiles) {
        const { existsSync, readdirSync, unlinkSync } = await import("node:fs");
        const dir = "fixtures/statistical";
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            if (all || (gameCode && f.startsWith(`${gameCode}-`))) {
              try {
                unlinkSync(join(dir, f));
                filesDeleted++;
              } catch {}
            }
          }
        }
      }

      if (all) {
        const n = await deleteAllTestRuns();
        return sendJson(res, 200, { ok: true, dbDeleted: n, filesDeleted, scope: "all" });
      }
      if (gameCode) {
        const n = await deleteTestRunsByGame(gameCode);
        return sendJson(res, 200, { ok: true, dbDeleted: n, filesDeleted, scope: `gameCode=${gameCode}` });
      }
      return sendJson(res, 400, { error: "Specify ?all=1 or ?gameCode=X" });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  const matchTestRunPath = url.match(/^\/api\/test-runs\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (matchTestRunPath) {
    try {
      const { getTestRun, listSpinResults, listValidationErrors, isDbEnabled } =
        await import("../db/index.js");
      if (!isDbEnabled()) return sendJson(res, 503, { error: "DB not enabled (set DATABASE_URL)" });
      const id = matchTestRunPath[1]!;
      const sub = matchTestRunPath[2] ?? "";
      if (sub === "" && method === "GET") {
        const run = await getTestRun(id);
        if (!run) return sendJson(res, 404, { error: "test-run not found" });
        return sendJson(res, 200, run);
      }
      if (sub === "/spins" && method === "GET") {
        const u = new URL(req.url ?? "/", "http://x");
        const limit = Number(u.searchParams.get("limit") ?? 200);
        const offset = Number(u.searchParams.get("offset") ?? 0);
        return sendJson(res, 200, await listSpinResults(id, { limit, offset }));
      }
      if (sub === "/errors" && method === "GET") {
        const u = new URL(req.url ?? "/", "http://x");
        const errorType = u.searchParams.get("type") ?? undefined;
        return sendJson(res, 200, await listValidationErrors(id, { errorType }));
      }
      if (sub === "/summary" && method === "POST") {
        const { summarizeBugs } = await import("../ai/bug-summarizer.js");
        const summary = await summarizeBugs({ testRunId: id });
        return sendJson(res, 200, summary);
      }
      if (sub === "" && method === "DELETE") {
        const { deleteTestRun } = await import("../db/index.js");
        const r = await deleteTestRun(id);
        if (!r.ok) return sendJson(res, 404, { error: "TestRun not found" });
        return sendJson(res, 200, { ok: true, deletedId: r.deletedId });
      }
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  const matchTaskPath = url.match(/^\/api\/tasks\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (matchTaskPath) {
    const taskId = matchTaskPath[1]!;
    const sub = matchTaskPath[2] ?? "";
    const task = queue.get(taskId);
    if (!task) return sendJson(res, 404, { error: "task not found" });

    if (sub === "" && method === "GET") return sendJson(res, 200, task);
    if (sub === "" && method === "DELETE") {
      const result = queue.delete(taskId);
      if (!result.ok) return sendJson(res, 409, { error: result.error });
      return sendJson(res, 200, { ok: true, taskId, removed: result.removed });
    }
    if (sub === "/log" && method === "GET") return sendJson(res, 200, queue.readLog(taskId));
    if (sub === "/events" && method === "GET") return sendJson(res, 200, queue.readSpinEvents(taskId));
    if (sub === "/retry" && method === "POST") return sendJson(res, 200, queue.retry(taskId));

    // 3-stage workflow: trigger từng phase độc lập.
    // - /collect: chạy bootstrap + understand → context bundle + spec
    // - /generate: chạy catalog + test code (yêu cầu stage>=context_ready)
    // - /run: chạy Playwright (yêu cầu stage>=catalog_ready)
    if ((sub === "/collect" || sub === "/generate" || sub === "/run") && method === "POST") {
      const phase = sub.slice(1) as "collect" | "generate" | "run";
      const result = queue.enqueuePhase(taskId, phase);
      if (!result.ok) return sendJson(res, 409, { error: result.error });
      return sendJson(res, 202, { ok: true, taskId, phase, task: result.task });
    }

    if (sub === "/cancel" && method === "POST") {
      // Queued → mark cancelled
      // Running → send signal to subprocess
      // Completed/Failed/Cancelled → no-op
      if (task.status === "queued") {
        return sendJson(res, 200, queue.cancel(taskId));
      }
      if (task.status === "running") {
        const ok = runner.cancelCurrent(taskId);
        if (ok) {
          return sendJson(res, 200, { ok: true, canceling: true, taskId });
        }
        return sendJson(res, 409, { error: "Task not currently running on worker" });
      }
      return sendJson(res, 200, { ok: true, alreadyFinished: true, status: task.status });
    }

    if (sub === "/case-report.json" && method === "GET") {
      const path = join("fixtures", "tasks", taskId, "case-report.json");
      if (!existsSync(path)) return sendJson(res, 404, { error: "Case report not ready yet" });
      const data = readFileSync(path);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": data.length,
        "content-disposition": `attachment; filename="case-report-${taskId.slice(0, 8)}.json"`,
      });
      res.end(data);
      return;
    }
    if (sub === "/case-report.md" && method === "GET") {
      const path = join("fixtures", "tasks", taskId, "case-report.md");
      if (!existsSync(path)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Case report not ready yet");
        return;
      }
      const data = readFileSync(path);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": data.length,
      });
      res.end(data);
      return;
    }

    // POST /api/tasks/:id/cases/:caseId/run → re-run single test case (fire-and-forget)
    const runCaseMatch = sub.match(/^\/cases\/([\w-]+)\/run$/);
    if (runCaseMatch && method === "POST") {
      const caseId = runCaseMatch[1]!;
      // Pre-flight check: spec + worker availability. Lỗi nhanh trả 409 ngay.
      const preflight = runner.checkSingleCasePreflight(taskId, caseId);
      if (!preflight.ok) return sendJson(res, 409, { error: preflight.error });
      // Kick off async; response trả ngay. UI track qua SSE /stream.
      void runner.runSingleCase(taskId, caseId);
      return sendJson(res, 202, { ok: true, taskId, caseId, started: true });
    }

    // POST /api/tasks/:id/run-stats { spins?: number, concurrency?: number }
    // Fire-and-forget statistical simulation. Output streamed via task SSE.
    if (sub === "/run-stats" && method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const spins = Number(body?.spins ?? 1000);
        const concurrency = Number(body?.concurrency ?? 4);
        const historyAudit = body?.historyAudit !== false;
        if (!Number.isFinite(spins) || spins < 1 || spins > 1_000_000) {
          return sendJson(res, 400, { error: "spins must be 1..1,000,000" });
        }
        // Kick off in background — caller polls via SSE / Test Runs (DB)
        void runner.runStatsSim(taskId, { spins, concurrency, historyAudit });
        return sendJson(res, 202, { ok: true, taskId, spins, concurrency, historyAudit });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    // POST /api/tasks/:id/record-pregame
    // Kicks off `auto-play.ts` with QA_CAPTURE_PREGAME=1 → writes
    // fixtures/pre-game/{slug}.json + baseline. Same worker-busy guard as
    // hybrid spec.
    if (sub === "/record-pregame" && method === "POST") {
      const r = runner.runPreGameRecording(taskId);
      if (!r.ok) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 202, { ok: true, taskId });
    }

    // POST /api/tasks/:id/record-ui-flows
    // Phase 2.5 — LLM-record click sequence cho replay_or_vision cases (buy_feature,
    // special_bet, ...). Yêu cầu catalog đã generated. Output:
    // fixtures/case-actions/{slug}/{caseId}/{recording.json, baseline.png}.
    if (sub === "/record-ui-flows" && method === "POST") {
      const r = runner.runUiFlowRecording(taskId);
      if (!r.ok) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 202, { ok: true, taskId });
    }

    // POST /api/tasks/:id/capture-fs-buy
    // Phase 2.6 — click Buy Feature qua LLM → capture FS chain → save
    // fixtures/scenarios/{slug}/free_spin_chain.json. Cần Buy Feature có sẵn.
    if (sub === "/capture-fs-buy" && method === "POST") {
      const r = runner.runCaptureFsViaBuy(taskId);
      if (!r.ok) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 202, { ok: true, taskId });
    }

    // GET /api/tasks/:id/pregame-stats → aggregated replay/vision stats for slug
    if (sub === "/pregame-stats" && method === "GET") {
      const { aggregatePreGameStats } = await import("../runner/pre-game-stats.js");
      const aggs = aggregatePreGameStats(task.gameSlug);
      return sendJson(res, 200, { slug: task.gameSlug, stats: aggs[0] ?? null });
    }

    // GET /api/tasks/:id/attachment?path=... → serve Playwright attachment (screenshot/video/trace).
    // Path phải nằm trong test-results/, reports/, playwright-report/, hoặc fixtures/tasks/ để chống path traversal.
    if (sub === "/attachment" && method === "GET") {
      const u = new URL(req.url ?? "/", "http://x");
      const filePath = u.searchParams.get("path") ?? "";
      const abs = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
      const cwd = process.cwd();
      const allowed = [
        join(cwd, "test-results"),
        join(cwd, "reports"),
        join(cwd, "playwright-report"),
        join(cwd, "fixtures", "tasks"),
        join(cwd, "fixtures", "statistical"),
      ];
      const isAllowed = allowed.some((root) => abs.startsWith(root + "/") || abs === root);
      if (!isAllowed || !existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404);
        res.end("not found or path not allowed");
        return;
      }
      const data = readFileSync(abs);
      const lower = abs.toLowerCase();
      const ct = lower.endsWith(".png") ? "image/png"
        : lower.endsWith(".webm") ? "video/webm"
        : lower.endsWith(".mp4") ? "video/mp4"
        : lower.endsWith(".zip") ? "application/zip"
        : lower.endsWith(".md") ? "text/markdown; charset=utf-8"
        : "application/octet-stream";
      res.writeHead(200, {
        "content-type": ct,
        "content-length": data.length,
        "cache-control": "public, max-age=600",
      });
      res.end(data);
      return;
    }

    if (sub === "/test-cases" && method === "GET") {
      const slug = task.gameSlug;
      const path = join("fixtures/specs", slug, `${slug}.test-cases.json`);
      if (!existsSync(path)) return sendJson(res, 200, { catalog: null });
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        // Auto-reconcile: if catalog IDs drift from caseResults (eg AI rename),
        // drop stale entries + add new ones as pending. Stats stay accurate.
        if (Array.isArray(data.cases)) {
          const catalogIds: string[] = data.cases
            .map((c: { id?: string }) => c.id)
            .filter((x: unknown): x is string => typeof x === "string");
          const sync = queue.reconcileCaseCatalog(taskId, catalogIds);
          if (sync.dropped > 0 || sync.added > 0) {
            console.log(`[task ${taskId.slice(0, 8)}] catalog sync: kept=${sync.kept} dropped=${sync.dropped} added=${sync.added}`);
          }
        }
        return sendJson(res, 200, { catalog: data });
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    // ===== Deterministic / Hybrid endpoints =====
    if (sub === "/scenarios" && method === "GET") {
      const { listScenarios, loadScenario } = await import("../runner/scenario.js");
      const names = listScenarios(task.gameSlug);
      const details = names.map((name) => {
        try {
          const s = loadScenario(task.gameSlug, name);
          return { name, expected: s.expected, label: s.label };
        } catch {
          return { name, expected: null, label: null };
        }
      });
      return sendJson(res, 200, { scenarios: details });
    }

    if (sub === "/gen-hybrid" && method === "POST") {
      try {
        const { generateHybridTestCode } = await import("../ai/authoring.js");
        const { writeFileSync, mkdirSync } = await import("node:fs");
        // Pass catalog nếu có → catalog-driven mode (1 test per case, ~60-80% coverage).
        // Nếu chưa có catalog (Generate phase chưa chạy) → scenario-only mode (N test = N scenario).
        const catalogPath = join("fixtures/specs", task.gameSlug, `${task.gameSlug}.test-cases.json`);
        const catalog = existsSync(catalogPath)
          ? JSON.parse(readFileSync(catalogPath, "utf8"))
          : null;
        const code = generateHybridTestCode({
          gameSlug: task.gameSlug,
          harnessImportPath: "unused",
          envVarUrl: "GAME_URL",
          catalog,
        });
        if (!code) {
          return sendJson(res, 409, {
            error: `No scenarios for ${task.gameSlug}. Run Collect phase first.`,
          });
        }
        const outDir = join("tests", "generated");
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, `${task.gameSlug}.hybrid.spec.ts`);
        writeFileSync(outPath, code);
        return sendJson(res, 200, {
          ok: true,
          path: outPath,
          sizeChars: code.length,
          mode: catalog ? "catalog-driven" : "scenario-only",
          caseCount: catalog?.cases?.length ?? 0,
        });
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    if (sub === "/run-hybrid" && method === "POST") {
      const specPath = join("tests", "generated", `${task.gameSlug}.hybrid.spec.ts`);
      if (!existsSync(specPath)) {
        return sendJson(res, 409, {
          error: `Hybrid spec không tồn tại. POST /gen-hybrid trước.`,
        });
      }
      const r = runner.runHybridSpec(taskId, specPath);
      if (!r.ok) return sendJson(res, 409, { error: r.error });
      return sendJson(res, 202, { ok: true, taskId, specPath });
    }

    if (sub === "/run-all" && method === "POST") {
      // Unified mode: auto-gen spec với mixed strategy (mock + LLM), rồi spawn
      // Playwright. Coverage 100% cases, cost optimized.
      try {
        const catalogPath = join("fixtures/specs", task.gameSlug, `${task.gameSlug}.test-cases.json`);
        if (!existsSync(catalogPath)) {
          return sendJson(res, 409, {
            error: `Chưa có catalog. Chạy "2. Generate Tests" trước.`,
          });
        }
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        const { generateUnifiedTestCode } = await import("../ai/authoring.js");
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const code = generateUnifiedTestCode({
          gameSlug: task.gameSlug,
          envVarUrl: "GAME_URL",
          catalog,
        });
        if (!code) {
          return sendJson(res, 409, { error: "Catalog empty hoặc invalid" });
        }
        const outDir = join("tests", "generated");
        mkdirSync(outDir, { recursive: true });
        const specPath = join(outDir, `${task.gameSlug}.unified.spec.ts`);
        writeFileSync(specPath, code);
        const r = runner.runHybridSpec(taskId, specPath);
        if (!r.ok) return sendJson(res, 409, { error: r.error });
        return sendJson(res, 202, { ok: true, taskId, specPath, mode: "unified" });
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    if (sub === "/run-stats" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const spins = Math.max(1, Math.min(1_000_000, Number(body?.spins) || 100));
        const concurrency = body?.concurrency ? Math.max(1, Math.min(32, Number(body.concurrency))) : undefined;
        const throttleMs = body?.throttleMs != null ? Math.max(0, Number(body.throttleMs)) : undefined;
        const historyAudit = body?.historyAudit !== false;
        // Fire-and-forget, response trả ngay. Caller poll qua /stream để biết khi xong.
        void runner.runStatsSim(taskId, { spins, concurrency, throttleMs, historyAudit });
        return sendJson(res, 202, { ok: true, taskId, spins, concurrency, throttleMs, historyAudit });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    if (sub === "/stats-report" && method === "GET") {
      // Trả về report mới nhất cho slug (nếu có).
      const { readdirSync, statSync } = await import("node:fs");
      const slug = task.gameSlug;
      const dir = "fixtures/statistical";
      if (!existsSync(dir)) return sendJson(res, 200, { report: null });
      const files = readdirSync(dir)
        .filter((n) => n.startsWith(`${slug}-`) && n.endsWith(".json"))
        .map((n) => ({ name: n, full: join(dir, n) }))
        .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
      if (files.length === 0) return sendJson(res, 200, { report: null });
      const latest = files[0]!;
      const content = JSON.parse(readFileSync(latest.full, "utf8"));
      return sendJson(res, 200, { report: content, path: latest.full });
    }

    if (sub === "/update-baselines" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const type = body?.type ?? "both";
        if (!["region", "json", "both"].includes(type)) {
          return sendJson(res, 400, { error: "type must be region|json|both" });
        }
        const specPath = join("tests", "generated", `${task.gameSlug}.hybrid.spec.ts`);
        if (!existsSync(specPath)) {
          return sendJson(res, 409, { error: "Hybrid spec không tồn tại. POST /gen-hybrid trước." });
        }
        const env: Record<string, string> = {};
        if (type === "region" || type === "both") env.REGION_SNAPSHOT_UPDATE = "1";
        if (type === "json" || type === "both") env.JSON_SNAPSHOT_UPDATE = "1";
        const r = runner.runHybridSpec(taskId, specPath, env);
        if (!r.ok) return sendJson(res, 409, { error: r.error });
        return sendJson(res, 202, { ok: true, taskId, type });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    // CSV export — flat 1-row-per-case, multi-line cells RFC 4180,
    // mở trực tiếp Excel/Sheets. Generate on-the-fly mỗi request (catalog nhỏ).
    if (sub === "/test-cases.csv" && method === "GET") {
      const slug = task.gameSlug;
      const catalogPath = join("fixtures/specs", slug, `${slug}.test-cases.json`);
      const specPath = join("fixtures/specs", slug, `${slug}.spec.json`);
      if (!existsSync(catalogPath) || !existsSync(specPath)) {
        res.statusCode = 404;
        res.end("Catalog or spec not found.");
        return;
      }
      try {
        const { catalogToCsv } = await import("../ai/catalog-markdown.js");
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        const spec = JSON.parse(readFileSync(specPath, "utf8"));
        const csv = catalogToCsv({ catalog, spec });
        res.setHeader("content-type", "text/csv; charset=utf-8");
        if (req.url?.includes("download=1")) {
          res.setHeader(
            "content-disposition",
            `attachment; filename="${slug}.test-cases.qa-review.csv"`,
          );
        }
        res.statusCode = 200;
        res.end(csv);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(`Failed to generate CSV: ${(err as Error).message}`);
        return;
      }
    }

    // QA-readable markdown export. Generate on-the-fly nếu file chưa có
    // (vd catalog cũ trước khi feature này được add).
    if (sub === "/test-cases.md" && method === "GET") {
      const slug = task.gameSlug;
      const mdPath = join("fixtures/specs", slug, `${slug}.test-cases.qa-review.md`);
      const catalogPath = join("fixtures/specs", slug, `${slug}.test-cases.json`);
      const specPath = join("fixtures/specs", slug, `${slug}.spec.json`);

      const downloadName = req.url?.includes("download=1")
        ? `${slug}.test-cases.qa-review.md`
        : null;
      const setHeaders = () => {
        res.setHeader("content-type", "text/markdown; charset=utf-8");
        if (downloadName) {
          res.setHeader("content-disposition", `attachment; filename="${downloadName}"`);
        }
      };

      if (existsSync(mdPath)) {
        setHeaders();
        res.statusCode = 200;
        res.end(readFileSync(mdPath));
        return;
      }
      // On-the-fly generate (catalog cũ chưa có file md)
      if (!existsSync(catalogPath)) {
        res.statusCode = 404;
        res.end("Catalog not found — run Generate phase first.");
        return;
      }
      try {
        const { catalogToMarkdown } = await import("../ai/catalog-markdown.js");
        const { validateCatalog } = await import("../ai/catalog-validator.js");
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : null;
        if (!spec) {
          res.statusCode = 500;
          res.end("Spec not found — cannot resolve invariants.");
          return;
        }
        const validationReport = validateCatalog(catalog, spec);
        const md = catalogToMarkdown({ catalog, spec, validationReport });
        setHeaders();
        res.statusCode = 200;
        res.end(md);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(`Failed to generate markdown: ${(err as Error).message}`);
        return;
      }
    }

    // Trả về context bundle (rules + config + options + samples) đã dùng để sinh test catalog.
    // Cho UI hiển thị "AI đã thấy gì khi sinh test case này".
    if (sub === "/catalog-context" && method === "GET") {
      const slug = task.gameSlug;
      const path = join("fixtures/specs", slug, `${slug}.catalog-context.json`);
      if (!existsSync(path)) return sendJson(res, 200, { context: null });
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        // Cũng pull spec + structured config (parse on-the-fly từ raw config) để UI render đẹp hơn
        const specPath = join("fixtures/specs", slug, `${slug}.spec.json`);
        const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : null;
        let structured_config = null;
        try {
          if (data?.inputs?.config_response) {
            const { extractStructuredFromConfig } = await import("../ai/config-extract.js");
            structured_config = extractStructuredFromConfig(data.inputs.config_response);
          }
        } catch {}
        return sendJson(res, 200, { context: data, spec, structured_config });
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    // Raw JSON snapshots (cho tab "JSON" — view tất cả structured artifact thuần JSON).
    if (sub === "/json-snapshots" && method === "GET") {
      const slug = task.gameSlug;
      const out: Record<string, { path: string; content: unknown } | { path: string; missing: true }> = {};

      const tryRead = (key: string, p: string) => {
        if (existsSync(p)) {
          try {
            out[key] = { path: p, content: JSON.parse(readFileSync(p, "utf8")) };
          } catch (err) {
            out[key] = { path: p, content: { _error: (err as Error).message } };
          }
        } else {
          out[key] = { path: p, missing: true };
        }
      };

      // Latest options run for this slug (chứa play-screen.json + api-snapshot.json + paytable.json + options.json)
      const optionsBase = "fixtures/options";
      let optionsRun: string | null = null;
      if (existsSync(optionsBase)) {
        const dirs = readdirSync(optionsBase)
          .filter((n) => n.startsWith(slug + "__"))
          .map((n) => ({ n, full: join(optionsBase, n) }))
          .filter((d) => statSync(d.full).isDirectory())
          .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
        optionsRun = dirs[0]?.full ?? null;
      }
      if (optionsRun) {
        tryRead("play_screen", join(optionsRun, "play-screen.json"));
        tryRead("api_snapshot", join(optionsRun, "api-snapshot.json"));
        tryRead("options_catalog", join(optionsRun, "options.json"));
        tryRead("paytable", join(optionsRun, "paytable.json"));
        tryRead("summary", join(optionsRun, "summary.json"));
      }

      // Spec artifacts
      tryRead("game_spec", join("fixtures/specs", slug, `${slug}.spec.json`));
      tryRead("catalog_context", join("fixtures/specs", slug, `${slug}.catalog-context.json`));
      tryRead("network_hints", join("fixtures/specs", slug, "network-hints.json"));

      return sendJson(res, 200, { game_slug: slug, options_run: optionsRun, snapshots: out });
    }

    if (sub === "/screenshots" && method === "GET") {
      const dir = join("fixtures", "tasks", taskId, "screenshots");
      if (!existsSync(dir)) return sendJson(res, 200, { dir, files: [], byCase: {} });
      // List flat files in root (pre-game / pre-case) + group subfolders by case
      const entries = readdirSync(dir);
      const files = entries
        .filter((f) => {
          const full = join(dir, f);
          return statSync(full).isFile() && f.endsWith(".png");
        })
        .sort();
      const byCase: Record<string, string[]> = {};
      for (const e of entries) {
        const full = join(dir, e);
        if (!statSync(full).isDirectory()) continue;
        // skip hidden
        if (e.startsWith(".")) continue;
        const sub = readdirSync(full)
          .filter((f) => f.endsWith(".png") && statSync(join(full, f)).isFile())
          .sort();
        if (sub.length) byCase[e] = sub;
      }
      return sendJson(res, 200, { dir, files, byCase });
    }

    // GET /api/tasks/:id/cases/:caseId/screenshots → list per-case
    const caseShotsListMatch = sub.match(/^\/cases\/([\w-]+)\/screenshots$/);
    if (caseShotsListMatch && method === "GET") {
      const caseId = caseShotsListMatch[1]!;
      const caseDir = join("fixtures", "tasks", taskId, "screenshots", caseId);
      if (!existsSync(caseDir)) return sendJson(res, 200, { caseId, files: [] });
      const files = readdirSync(caseDir)
        .filter((f) => f.endsWith(".png") && statSync(join(caseDir, f)).isFile())
        .sort();
      return sendJson(res, 200, { caseId, files });
    }

    // GET /api/tasks/:id/screenshots/:filename → serve PNG (root)
    // GET /api/tasks/:id/screenshots/:caseId/:filename → serve PNG (per-case subdir)
    const shotMatch = sub.match(/^\/screenshots\/(?:([\w-]+)\/)?([\w.-]+\.png)$/);
    if (shotMatch && method === "GET") {
      const caseDir = shotMatch[1] ?? null;
      const filename = shotMatch[2]!;
      const full = caseDir
        ? join("fixtures", "tasks", taskId, "screenshots", caseDir, filename)
        : join("fixtures", "tasks", taskId, "screenshots", filename);
      if (!existsSync(full) || !statSync(full).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const data = readFileSync(full);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": data.length,
        "cache-control": "public, max-age=3600",
      });
      res.end(data);
      return;
    }

    if (sub === "/stream" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const send = (ev: StreamEvent) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      };
      const unsub = queue.subscribe(taskId, send);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsub();
      });
      return;
    }
  }

  if (url === "/api/stream" && method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const send = (ev: StreamEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const unsub = queue.subscribeAll(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
    return;
  }

  // --- Static ---
  // Alias /dashboard → /index.html
  const pathOnly = (url.split("?")[0] ?? "/");
  const aliased = pathOnly === "/dashboard" || pathOnly === "/dashboard/" ? "/" : pathOnly;

  // Playwright HTML report — serve từ reports/html/. Cho phép browse toàn bộ
  // report (CSS/JS/screenshot relative paths) → cần static route riêng thay vì
  // /api/attachment one-file.
  if (method === "GET" && pathOnly.startsWith("/playwright-report")) {
    const sub = pathOnly.replace(/^\/playwright-report\/?/, "") || "index.html";
    if (sub.includes("..")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const full = join("reports/html", sub);
    if (!existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("playwright report not generated yet — run `npm run test` first");
      return;
    }
    const mime = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    const data = readFileSync(full);
    res.writeHead(200, {
      "content-type": mime,
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
    return;
  }

  if (method === "GET" && serveStatic(aliased, res)) return;

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  crawler-qa-agent dashboard`);
  console.log(`  http://localhost:${PORT}/dashboard`);
  console.log(`  (root redirects to /dashboard)\n`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  runner.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
});
