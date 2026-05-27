// HTTP routes for the new 11-step pipeline. Mounted from src/server/index.ts.
// All endpoints prefixed with /api/qa.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

type QaTaskStatus = "queued" | "running" | "completed" | "failed";

export type QaTask = {
  id: string;
  kind: "cold" | "warm";
  args: Record<string, string | number | boolean | undefined>;
  status: QaTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reportDir?: string;
  log: string[];
};

const tasks = new Map<string, QaTask>();
const procs = new Map<string, ChildProcess>();
const subscribers = new Map<string, Set<(line: string) => void>>();

function nextId(): string {
  return `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
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

function broadcast(taskId: string, line: string): void {
  const subs = subscribers.get(taskId);
  if (!subs) return;
  for (const fn of subs) fn(line);
}

function startTask(kind: "cold" | "warm", args: QaTask["args"]): QaTask {
  const id = nextId();
  const task: QaTask = {
    id,
    kind,
    args,
    status: "queued",
    createdAt: new Date().toISOString(),
    log: [],
  };
  tasks.set(id, task);

  mkdirSync(join("fixtures", "test-runs"), { recursive: true });

  const cliFlags: string[] = [];
  if (kind === "cold") {
    if (typeof args.url === "string") cliFlags.push("--url", args.url);
  } else {
    if (typeof args.game === "string") cliFlags.push("--game", args.game);
  }
  if (typeof args.spins === "number") cliFlags.push("--spins", String(args.spins));
  if (typeof args.mode === "string") cliFlags.push("--mode", args.mode);

  // Pass-through env vars from args (e.g. QA_STOP_AFTER_CATALOG=1 for
  // "Generate Cases" mode). Merge with parent process.env so existing config
  // (CLAUDE_CODE_OAUTH_TOKEN, etc.) carries through.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (args.stopAfterCatalog === true) childEnv.QA_STOP_AFTER_CATALOG = "1";
  if (args.skipCases === true) childEnv.QA_RUN_CASES = "0";

  const script = kind === "cold" ? "qa-cold.ts" : "qa-warm.ts";
  const proc = spawn("npx", ["tsx", `src/pipeline/cli/${script}`, ...cliFlags], {
    cwd: process.cwd(),
    env: childEnv,
  });

  task.status = "running";
  task.startedAt = new Date().toISOString();
  procs.set(id, proc);

  const tag = `[${task.kind}:${id.slice(-6)}]`;
  const handleChunk = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    // Echo to server stdout so `npm run serve` terminal shows live progress.
    process.stdout.write(text.split("\n").filter((l) => l).map((l) => `${tag} ${l}\n`).join(""));
    for (const line of text.split("\n")) {
      if (!line) continue;
      task.log.push(line);
      if (task.log.length > 5000) task.log.shift();
      broadcast(id, line);
      // sniff for report dir
      const m = line.match(/fixtures\/test-runs\/[0-9TZ:.-]+/);
      if (m && !task.reportDir) task.reportDir = m[0];
    }
  };
  proc.stdout?.on("data", handleChunk);
  proc.stderr?.on("data", handleChunk);

  proc.on("close", (code) => {
    task.exitCode = code ?? -1;
    task.status = code === 0 ? "completed" : "failed";
    task.finishedAt = new Date().toISOString();
    procs.delete(id);
    broadcast(id, `[exit] code=${code} status=${task.status}`);
    setTimeout(() => subscribers.delete(id), 5000);
  });

  return task;
}

export async function handleQaRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith("/api/qa")) return false;
  if (!url.startsWith("/api/qa/manual")) console.log(`[qa] ${method} ${url}`);

  // POST /api/qa/cold { url, spins?, mode?, stopAfterCatalog?, skipCases? }
  if (url === "/api/qa/cold" && method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const targetUrl = typeof body?.url === "string" ? body.url.trim() : "";
      if (!targetUrl) return sendJson(res, 400, { error: "url required" }), true;
      try {
        new URL(targetUrl);
      } catch {
        return sendJson(res, 400, { error: "invalid URL" }), true;
      }
      const task = startTask("cold", {
        url: targetUrl,
        spins: body?.spins,
        mode: body?.mode,
        stopAfterCatalog: body?.stopAfterCatalog === true,
        skipCases: body?.skipCases === true,
      });
      return sendJson(res, 202, task), true;
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message }), true;
    }
  }

  // POST /api/qa/warm { game, spins?, mode?, skipCases? }
  if (url === "/api/qa/warm" && method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const slug = typeof body?.game === "string" ? body.game.trim() : "";
      if (!slug) return sendJson(res, 400, { error: "game (slug) required" }), true;
      const task = startTask("warm", {
        game: slug,
        spins: body?.spins,
        mode: body?.mode,
        skipCases: body?.skipCases === true,
      });
      return sendJson(res, 202, task), true;
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message }), true;
    }
  }

  // GET /api/qa/tasks
  if (url === "/api/qa/tasks" && method === "GET") {
    return sendJson(res, 200, Array.from(tasks.values()).reverse()), true;
  }

  // GET /api/qa/tasks/:id
  const taskMatch = url.match(/^\/api\/qa\/tasks\/([^/?]+)(\/[^?]*)?$/);
  if (taskMatch) {
    const id = taskMatch[1]!;
    const sub = taskMatch[2] ?? "";
    const task = tasks.get(id);
    if (!task) return sendJson(res, 404, { error: "task not found" }), true;

    if (sub === "" && method === "GET") return sendJson(res, 200, task), true;
    if (sub === "/log" && method === "GET") {
      return sendJson(res, 200, { log: task.log }), true;
    }
    if (sub === "/stream" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      // Send buffered log first
      for (const line of task.log) {
        res.write(`data: ${JSON.stringify({ line })}\n\n`);
      }
      const subs = subscribers.get(id) ?? new Set<(line: string) => void>();
      subscribers.set(id, subs);
      const send = (line: string): void => {
        res.write(`data: ${JSON.stringify({ line })}\n\n`);
      };
      subs.add(send);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        subs.delete(send);
      });
      return true;
    }
    if (sub === "/cancel" && method === "POST") {
      const proc = procs.get(id);
      if (proc) {
        proc.kill("SIGTERM");
        return sendJson(res, 200, { ok: true, canceling: true }), true;
      }
      return sendJson(res, 200, { ok: true, alreadyFinished: true, status: task.status }), true;
    }
  }

  // GET /api/qa/games/:slug/test-cases.{json,md,csv}
  const tcMatch = url.match(/^\/api\/qa\/games\/([^/?]+)\/test-cases\.(json|md|csv)$/);
  if (tcMatch && method === "GET") {
    const slug = tcMatch[1]!;
    const ext = tcMatch[2]!;
    const fname = ext === "json" ? "test-cases.json" : `test-cases.${ext}`;
    const filePath = join("fixtures", "registry", slug, fname);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return true;
    }
    const data = readFileSync(filePath);
    const ct =
      ext === "json"
        ? "application/json; charset=utf-8"
        : ext === "md"
          ? "text/markdown; charset=utf-8"
          : "text/csv; charset=utf-8";
    res.writeHead(200, {
      "content-type": ct,
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
    return true;
  }

  // GET /api/qa/games — list registry slugs available for warm-start
  if (url === "/api/qa/games" && method === "GET") {
    const dir = join("fixtures", "registry");
    if (!existsSync(dir)) return sendJson(res, 200, { games: [] }), true;
    const games = readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .map((slug) => {
        const metaPath = join(dir, slug, "_meta.json");
        let meta: Record<string, unknown> = {};
        if (existsSync(metaPath)) {
          try {
            meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        return { slug, meta };
      });
    return sendJson(res, 200, { games }), true;
  }

  // GET /api/qa/runs — list all completed test runs (filesystem)
  if (url === "/api/qa/runs" && method === "GET") {
    const dir = join("fixtures", "test-runs");
    if (!existsSync(dir)) return sendJson(res, 200, { runs: [] }), true;
    const runs = readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .map((id) => {
        const reportPath = join(dir, id, "report.json");
        let report: Record<string, unknown> | null = null;
        if (existsSync(reportPath)) {
          try {
            report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        return {
          id,
          path: join(dir, id),
          hasReport: report !== null,
          hasPdf: existsSync(join(dir, id, "report.pdf")),
          hasHtml: existsSync(join(dir, id, "report.html")),
          provider: (report?.crawl as Record<string, unknown> | undefined)?.provider ?? null,
          gameSlug: (report?.crawl as Record<string, unknown> | undefined)?.gameSlug ?? null,
        };
      })
      .filter((r) => r.hasReport || r.hasHtml || r.hasPdf)
      .sort((a, b) => b.id.localeCompare(a.id));
    return sendJson(res, 200, { runs }), true;
  }

  // GET /api/qa/runs/:id/report.{json,html,pdf}
  const runMatch = url.match(/^\/api\/qa\/runs\/([^/?]+)\/report\.(json|html|pdf)$/);
  if (runMatch && method === "GET") {
    const id = runMatch[1]!;
    const ext = runMatch[2]!;
    const file = join("fixtures", "test-runs", id, `report.${ext}`);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return true;
    }
    const data = readFileSync(file);
    const ct =
      ext === "json"
        ? "application/json; charset=utf-8"
        : ext === "html"
          ? "text/html; charset=utf-8"
          : "application/pdf";
    res.writeHead(200, {
      "content-type": ct,
      "content-length": data.length,
      "cache-control": "no-store",
    });
    res.end(data);
    return true;
  }

  return false;
}
