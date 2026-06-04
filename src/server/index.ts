import { createServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { config as loadEnv } from "dotenv";
import { handleQaRoute } from "../pipeline/server/qa-routes.js";
import { handleManualRoute } from "../pipeline/server/manual-routes.js";
import { requestContext } from "./request-context.js";

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

// URL aliases — `/` and `/dashboard` go to the multi-game OVERVIEW
// (public/index.html); legacy aliases preserved. Per-game detail lives at
// `/game/<slug>` (rewritten to manual-verify.html with `?gameSlug=` so the
// detail page knows which session to scope its API calls to).
const URL_ALIASES: Record<string, string> = {
  "/": "/index.html",
  "/dashboard": "/index.html",
  "/dashboard/": "/index.html",
  "/dashboard_new": "/index.html",
  "/dashboard_new/": "/index.html",
};

/** Rewrite `/game/<slug>` → `/manual-verify.html?gameSlug=<slug>` so the
 *  detail page can read the slug from `location.search` and inject it into
 *  every API call. Returns the rewritten URL, or null when the input
 *  doesn't match. */
function rewriteGameDetail(url: string): string | null {
  const m = url.match(/^\/game\/([^\/?#]+)\/?(?:\?(.*))?$/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]!);
  const extra = m[2] ? `&${m[2]}` : "";
  return `/manual-verify.html?gameSlug=${encodeURIComponent(slug)}${extra}`;
}

function serveStatic(url: string, res: ServerResponse): boolean {
  const cleanUrl = url.split("?")[0]!;
  // Per-game detail rewrite: /game/<slug> → manual-verify.html?gameSlug=…
  const gameRewrite = rewriteGameDetail(url);
  if (gameRewrite) {
    res.writeHead(302, { Location: gameRewrite });
    res.end();
    return true;
  }
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

  // Per-request Claude token context. Reads X-Claude-Token header (sent
  // by dashboard JS from QA's localStorage). All async work inside this
  // handler — including AI calls in nested phase fns — sees the same
  // token via getCurrentClaudeToken(). When the header is absent (CLI,
  // testing, or QA hasn't set token yet), getCurrentClaudeToken returns
  // null and askClaude falls back to process.env CLAUDE_CODE_OAUTH_TOKEN.
  const rawHeader = req.headers["x-claude-token"];
  const claudeToken = (typeof rawHeader === "string" && rawHeader.trim())
    ? rawHeader.trim()
    : null;
  // Hash the token (first 8 chars of sha256) for usage attribution. Don't
  // log the raw token anywhere. Phase 5 surfaces this in usage logs.
  let qaHash: string | null = null;
  if (claudeToken) {
    const { createHash } = await import("node:crypto");
    qaHash = createHash("sha256").update(claudeToken).digest("hex").slice(0, 8);
  }
  await requestContext.run({ claudeToken, qaHash }, async () => {
    try {
      await routeRequest(req, res, url, method);
    } catch (err) {
      // Centralize token-error handling. MissingClaudeTokenError thrown
      // by askClaude when neither header nor master env has a token →
      // surface as 401 so the dashboard's api() helper detects it +
      // re-prompts QA to paste their token. Other errors fall through
      // to generic 500. Response written here only if route hasn't
      // already responded.
      const msg = err instanceof Error ? err.message : String(err);
      const isTokenError = /No Claude token available|MissingClaudeTokenError/i.test(msg);
      if (!res.headersSent) {
        res.writeHead(isTokenError ? 401 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: msg }));
      } else {
        console.error(`[server] unhandled error after headers sent: ${msg}`);
      }
    }
  });
});

async function routeRequest(req: import("node:http").IncomingMessage, res: ServerResponse, url: string, method: string): Promise<void> {
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
}

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
