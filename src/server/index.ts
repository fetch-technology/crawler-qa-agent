import { createServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { config as loadEnv } from "dotenv";
import { handleQaRoute } from "../pipeline/server/qa-routes.js";
import { handleManualRoute } from "../pipeline/server/manual-routes.js";

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

// URL aliases — legacy `/dashboard` and root now redirect to the pipeline UI.
// The old TaskQueue/TaskRunner dashboard (index.html / app.js / qa.html /
// qa.js) was removed; manual-verify.html is the single supported UI.
const URL_ALIASES: Record<string, string> = {
  "/": "/manual-verify.html",
  "/dashboard": "/manual-verify.html",
  "/dashboard/": "/manual-verify.html",
  "/dashboard_new": "/manual-verify.html",
  "/dashboard_new/": "/manual-verify.html",
};

function serveStatic(url: string, res: ServerResponse): boolean {
  const cleanUrl = url.split("?")[0]!;
  const aliased = URL_ALIASES[cleanUrl] ?? cleanUrl;
  const safePath = normalize(aliased).replace(/^\/+/, "");
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

  // --- Pipeline routes (/api/qa/*) — cold/warm start + task streaming + runs ---
  if (await handleQaRoute(req, res, url, method)) return;

  // --- Manual session routes (/api/qa/manual/*) — Phase 6.1+ live dashboard ---
  if (await handleManualRoute(req, res, url, method)) return;

  // --- Playwright HTML report (relative paths need static serving) ---
  const pathOnly = url.split("?")[0] ?? "/";
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

  // --- Static (HTML + JS + CSS from public/) ---
  if (method === "GET" && serveStatic(url, res)) return;

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  crawler-qa-agent dashboard`);
  console.log(`  http://localhost:${PORT}/dashboard_new`);
  console.log(`  (/ and /dashboard alias to /dashboard_new)\n`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
});
