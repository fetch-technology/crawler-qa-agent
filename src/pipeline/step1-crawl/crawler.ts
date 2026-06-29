import type { Page } from "playwright";
import type { CrawlResult } from "./types.js";
import { detectProvider } from "./provider-detector.js";
import { waitForCanvasReady } from "../../runner/wait-ready.js";

export type CrawlOptions = {
  gameUrl: string;
  gameSlug?: string;
  timeout?: number;
};

export async function crawl(page: Page, opts: CrawlOptions): Promise<CrawlResult> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // Load-failure diagnostics — when a game STICKS partway (e.g. stuck at 80%)
  // in the automated browser but loads fine in a normal one, the cause is
  // almost always a specific request that fails / is blocked (geo 403, CORS,
  // net::ERR_*, a rejected gameService handshake). Capture those so the pm2
  // log pinpoints the offender instead of us guessing. Passive listeners — no
  // interception, no blocking.
  const failedRequests: string[] = [];
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "failed";
    failedRequests.push(`${why}  ${r.method()} ${r.url()}`);
  });
  const badResponses: string[] = [];
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 400) badResponses.push(`HTTP ${s}  ${r.request().method()} ${r.url()}`);
  });

  // A live slot game keeps streaming network traffic forever (WebSocket /
  // long-poll, balance + announcements + promo polling, audio/sprite streaming),
  // so "networkidle" NEVER settles → goto would burn the full timeout and throw
  // even though the game loaded fine. Playwright itself DISCOURAGES networkidle.
  // Wait for the DOM, then for the game CANVAS to actually render — a
  // deterministic readiness signal that doesn't depend on the network ever
  // going quiet. skipNetworkIdle avoids the helper's own 10s networkidle layer.
  const navTimeout = opts.timeout ?? 60000;
  await page.goto(opts.gameUrl, {
    waitUntil: "domcontentloaded",
    timeout: navTimeout,
  });
  await waitForCanvasReady(page, { skipNetworkIdle: true, timeoutMs: navTimeout })
    .catch(() => undefined); // non-fatal: popup-dismiss + AI discovery follow

  // Surface load-blocking failures captured during the load window. A game
  // that stalls partway almost always leaves a fingerprint here.
  if (failedRequests.length > 0) {
    console.warn(`[crawl] ${failedRequests.length} request(s) FAILED during load (likely cause of a stuck loader):\n  ${failedRequests.slice(0, 20).join("\n  ")}`);
  }
  if (badResponses.length > 0) {
    console.warn(`[crawl] ${badResponses.length} response(s) with status ≥400 during load:\n  ${badResponses.slice(0, 20).join("\n  ")}`);
  }
  if (errors.length > 0) {
    console.warn(`[crawl] ${errors.length} console error(s) during load:\n  ${errors.slice(0, 12).join("\n  ")}`);
  }

  const iframeCount = page.frames().length - 1;
  const canvasCount = await page.locator("canvas").count();

  const { provider, gameName, platform } = await detectProvider(page, opts.gameUrl);

  const slug = opts.gameSlug ?? deriveSlug(opts.gameUrl);

  return {
    gameUrl: opts.gameUrl,
    gameSlug: slug,
    loaded: true,
    iframeCount,
    canvasCount,
    consoleErrors: errors,
    initialScreenshot: "",
    provider,
    gameName,
    platform,
  };
}

export function deriveSlug(url: string): string {
  // Pragmatic-style slug (vs20olympx, …game…).
  const m = url.match(/\/(vs\d+\w+|[a-z0-9-]+game[a-z0-9-]*)/i);
  if (m && m[1]) return m[1].toLowerCase();
  // 3 Oaks: static bundle `…/api/v1/games/<game>/play/` or game-service
  // `…/gs/<game>/desktop/…`. Without this the first path segment "api" would
  // become the slug for EVERY 3 Oaks game (collision + wrong registry dir).
  const oaks = url.match(/\/(?:games|gs)\/([a-z0-9_]+)\/(?:play|desktop)/i);
  if (oaks && oaks[1]) return oaks[1].toLowerCase();
  // Playtech GPAS: the real game is in `?game=pt-gpas-<name>`, not the path
  // (which is just `gpasclient.html` — identical for EVERY Playtech game, so
  // the path fallback would collide them all under one slug).
  if (/playtech|gpasclient/i.test(url)) {
    const pt = url.match(/[?&]game=([a-z0-9_-]+)/i);
    if (pt && pt[1]) return pt[1].toLowerCase();
  }
  const u = new URL(url);
  const firstSegment = u.pathname.split("/").filter(Boolean)[0] ?? "unknown";
  // Sanitize the fallback: a loader page like "/gpasclient.html" must NOT yield
  // a slug containing a file extension / dots. An unsanitized ".html" slug
  // later becomes UNDELETABLE (deleteGame's path-traversal guard rejects it).
  // Strip the extension, then map any non-slug-safe char to "-".
  const slug = firstSegment
    .replace(/\.[a-z0-9]+$/i, "")        // drop file extension (.html, .php, …)
    .replace(/[^a-z0-9_-]+/gi, "-")      // any leftover unsafe char → "-"
    .replace(/^-+|-+$/g, "")             // trim leading/trailing dashes
    .toLowerCase();
  return slug || "unknown";
}
