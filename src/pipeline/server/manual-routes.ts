// HTTP routes for Phase 6.1 — Manual Verify dashboard. Mounted from
// src/server/index.ts. Routes prefixed with /api/qa/manual.

import type { IncomingMessage, ServerResponse } from "node:http";
import { listRegisteredGames, updateGameUrl, deleteGame, ManualSessionManager } from "./manual-session.js";
import { getOrCreate, set as setSession, getDefaultOrThrow, listSessions } from "./session-pool.js";

/** Resolve which ManualSessionManager the request targets.
 *  Priority: explicit `gameSlug` (body / x-game-slug header / ?gameSlug=…)
 *  → fall back to LRU default (one-session pool) → fail when ambiguous. */
function resolveSession(req: IncomingMessage, body: Record<string, any> | null, urlStr: string): ManualSessionManager {
  let slug: string | null = null;
  if (body && typeof body.gameSlug === "string" && body.gameSlug) slug = body.gameSlug;
  if (!slug && typeof req.headers["x-game-slug"] === "string") slug = req.headers["x-game-slug"] as string;
  if (!slug) {
    try {
      const u = new URL(urlStr, "http://localhost");
      const q = u.searchParams.get("gameSlug");
      if (q) slug = q;
    } catch { /* ignore */ }
  }
  if (slug) return getOrCreate(slug);
  return getDefaultOrThrow();
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

function sendPng(res: ServerResponse, buf: Buffer): void {
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

async function asJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export async function handleManualRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith("/api/qa/manual")) return false;
  console.log(`[manual] ${method} ${url}`);

  try {
    // GET /api/qa/manual/games — list previously registered games
    if (url === "/api/qa/manual/games" && method === "GET") {
      const games = await listRegisteredGames();
      return sendJson(res, 200, { games }), true;
    }

    // POST /api/qa/manual/update-url { gameSlug, url } — change token/URL of a registered game without re-discovery
    if (url === "/api/qa/manual/update-url" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string; url?: string }>(req);
      if (!body.gameSlug || !body.url) return sendJson(res, 400, { error: "gameSlug and url required" }), true;
      const r = await updateGameUrl(body.gameSlug, body.url);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // DELETE /api/qa/manual/game/:slug — delete a game + ALL related fixtures
    if (url.startsWith("/api/qa/manual/game/") && method === "DELETE") {
      const slug = decodeURIComponent(url.slice("/api/qa/manual/game/".length));
      const r = await deleteGame(slug);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/resume { gameSlug } — open existing registry without re-discovery
    if (url === "/api/qa/manual/resume" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string }>(req);
      if (!body.gameSlug) return sendJson(res, 400, { error: "gameSlug required" }), true;
      try {
        const sess = getOrCreate(body.gameSlug);
        const status = await sess.resume(body.gameSlug);
        return sendJson(res, 200, status), true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /already active/.test(msg) ? 409 : /No registry|No ui-registry/.test(msg) ? 404 : 500;
        return sendJson(res, code, { error: msg }), true;
      }
    }

    // POST /api/qa/manual/start { url, autoDiscover? } — slug is derived
    // from the crawled URL during start(); a fresh transient manager runs
    // start, then registers itself in the pool under the resolved slug so
    // subsequent un-slugged routes can find it via LRU.
    if (url === "/api/qa/manual/start" && method === "POST") {
      const body = await asJsonBody<{ url?: string; autoDiscover?: boolean; gameSlug?: string }>(req);
      if (!body.url) return sendJson(res, 400, { error: "url required" }), true;
      try {
        // If client supplied gameSlug, reuse the existing manager so we
        // don't spin up a second browser for the same game; otherwise
        // build a transient and register after start() resolves the slug.
        const sess = body.gameSlug ? getOrCreate(body.gameSlug) : new ManualSessionManager();
        const status = await sess.start(body.url, { autoDiscover: body.autoDiscover ?? true });
        if (status.gameSlug) setSession(status.gameSlug, sess);
        return sendJson(res, 200, status), true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /already active/.test(msg) ? 409 : 500;
        return sendJson(res, code, { error: msg }), true;
      }
    }

    // GET /api/qa/manual/sessions — list all active per-game sessions in the
    // pool. Used by the dashboard to render a multi-game tab strip.
    if (url === "/api/qa/manual/sessions" && method === "GET") {
      return sendJson(res, 200, { sessions: listSessions() }), true;
    }

    // GET /api/qa/manual/status[?gameSlug=…]
    if ((url === "/api/qa/manual/status" || url.startsWith("/api/qa/manual/status?")) && method === "GET") {
      return sendJson(res, 200, resolveSession(req, null, url).status()), true;
    }

    // POST /api/qa/manual/click { uiKey } | { x, y }
    if (url === "/api/qa/manual/click" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (body.uiKey) {
        const r = await resolveSession(req, body as any, url).clickElement(body.uiKey);
        return sendJson(res, r.ok ? 200 : 400, r), true;
      }
      if (typeof body.x === "number" && typeof body.y === "number") {
        const r = await resolveSession(req, body as any, url).clickAt(body.x, body.y);
        return sendJson(res, r.ok ? 200 : 400, r), true;
      }
      return sendJson(res, 400, { error: "either uiKey or (x, y) required" }), true;
    }

    // POST /api/qa/manual/confirm { uiKey } — verify an element
    if (url === "/api/qa/manual/confirm" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string }>(req);
      if (!body.uiKey) {
        return sendJson(res, 400, { error: "uiKey required" }), true;
      }
      await resolveSession(req, body as any, url).confirm(body.uiKey);
      return sendJson(res, 200, resolveSession(req, body as any, url).status()), true;
    }

    // POST /api/qa/manual/confirm-children { parentKey } — bulk verify ALL
    // descendants of a parent element.
    if (url === "/api/qa/manual/confirm-children" && method === "POST") {
      const body = await asJsonBody<{ parentKey?: string }>(req);
      if (!body.parentKey) {
        return sendJson(res, 400, { error: "parentKey required" }), true;
      }
      const r = await resolveSession(req, body as any, url).confirmChildren(body.parentKey);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: resolveSession(req, body as any, url).status() }), true;
    }

    // POST /api/qa/manual/update { uiKey, x, y }
    if (url === "/api/qa/manual/update" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (!body.uiKey || typeof body.x !== "number" || typeof body.y !== "number") {
        return sendJson(res, 400, { error: "uiKey, x, y required" }), true;
      }
      await resolveSession(req, body as any, url).updateCoord(body.uiKey, body.x, body.y);
      return sendJson(res, 200, resolveSession(req, body as any, url).status()), true;
    }

    // POST /api/qa/manual/skip-main { uiKey, skipped? } — mark a main-screen
    // expected key as intentionally absent so pre-onboard gating won't block.
    if (url === "/api/qa/manual/skip-main" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; skipped?: boolean }>(req);
      if (!body.uiKey) {
        return sendJson(res, 400, { error: "uiKey required" }), true;
      }
      const sess = resolveSession(req, body as any, url);
      const r = await sess.setMainKeySkipped(body.uiKey, body.skipped !== false);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: sess.status() }), true;
    }

    // POST /api/qa/manual/add { uiKey, x, y }
    if (url === "/api/qa/manual/add" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (!body.uiKey || typeof body.x !== "number" || typeof body.y !== "number") {
        return sendJson(res, 400, { error: "uiKey, x, y required" }), true;
      }
      await resolveSession(req, body as any, url).addElement(body.uiKey, body.x, body.y);
      return sendJson(res, 200, resolveSession(req, body as any, url).status()), true;
    }

    // DELETE /api/qa/manual/element/:uiKey
    if (url.startsWith("/api/qa/manual/element/") && method === "DELETE") {
      const uiKey = decodeURIComponent(url.slice("/api/qa/manual/element/".length));
      await resolveSession(req, null, url).removeElement(uiKey);
      return sendJson(res, 200, resolveSession(req, null, url).status()), true;
    }

    // POST /api/qa/manual/discover-via { triggerKey, stateLabel }
    // One-click sub-state discovery: backend clicks trigger button, waits for
    // popup, AI detects elements, saves under namespace.
    if (url === "/api/qa/manual/discover-via" && method === "POST") {
      const body = await asJsonBody<{ triggerKey?: string; stateLabel?: string }>(req);
      if (!body.triggerKey || !body.stateLabel) {
        return sendJson(res, 400, { error: "triggerKey and stateLabel required" }), true;
      }
      const r = await resolveSession(req, body as any, url).discoverVia(body.triggerKey, body.stateLabel);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: resolveSession(req, body as any, url).status() }), true;
    }

    // POST /api/qa/manual/discover-state { stateLabel }
    // Multi-level discovery: AI detect all clickable elements in current
    // sub-screen (popup), namespace them as <stateLabel>__<key>.
    if (url === "/api/qa/manual/discover-state" && method === "POST") {
      const body = await asJsonBody<{ stateLabel?: string }>(req);
      if (!body.stateLabel) return sendJson(res, 400, { error: "stateLabel required" }), true;
      const r = await resolveSession(req, body as any, url).discoverSubState(body.stateLabel);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: resolveSession(req, body as any, url).status() }), true;
    }

    // POST /api/qa/manual/ai-recover { uiKey }
    if (url === "/api/qa/manual/ai-recover" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string }>(req);
      if (!body.uiKey) return sendJson(res, 400, { error: "uiKey required" }), true;
      const r = await resolveSession(req, body as any, url).aiRecover(body.uiKey);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: resolveSession(req, body as any, url).status() }), true;
    }

    // GET /api/qa/manual/cases?game=<slug> — list test cases + translated actions from disk
    // Accepts ?game= query param to inspect any registered game without active session.
    if (url.startsWith("/api/qa/manual/cases") && method === "GET") {
      const slugMatch = url.match(/[?&]game=([^&]+)/);
      const slug = slugMatch ? decodeURIComponent(slugMatch[1]!) : undefined;
      const r = await resolveSession(req, null, url).listCases(slug);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/retranslate-all { gameSlug?, mode?: "skipped" | "all" }
    if (url === "/api/qa/manual/retranslate-all" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string; mode?: "skipped" | "all" }>(req);
      const r = await resolveSession(req, body as any, url).retranslateAllSkipped({
        slugOverride: body.gameSlug,
        mode: body.mode,
      });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/case { case, gameSlug? }
    // Add a whole new test case to the catalog. Counterpart to the
    // assertion-add endpoint but at the case level. Validates id
    // uniqueness; fills sane defaults for omitted optional fields.
    if (url === "/api/qa/manual/case" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string; case?: Partial<import("../../ai/test-catalog.js").TestCase> }>(req);
      if (!body.case?.id || !body.case?.name || !body.case?.category) {
        return sendJson(res, 400, { error: "case.id + case.name + case.category required" }), true;
      }
      const r = await resolveSession(req, body as any, url).addCase(
        body.case as Parameters<typeof ManualSessionManager.prototype.addCase>[0],
        body.gameSlug,
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // DELETE /api/qa/manual/case?caseId=...&game=...
    // Remove case from catalog + drop cached translated actions. Persisted
    // run results stay (audit trail) but new runs will fail because the
    // case won't be in catalog anymore — dashboard hides those rows.
    if (url.startsWith("/api/qa/manual/case") && method === "DELETE" && !url.includes("case-assertion")) {
      const u = new URL(url, "http://localhost");
      const caseId = u.searchParams.get("caseId");
      const game = u.searchParams.get("game") ?? undefined;
      if (!caseId) return sendJson(res, 400, { error: "caseId query param required" }), true;
      const r = await resolveSession(req, null, url).deleteCase(caseId, game);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/case/generate { intent, gameSlug? }
    // AI-generate a full TestCase from QA's plain-language intent.
    // Returns the proposed case WITHOUT saving; UI previews then commits
    // via POST /case.
    if (url === "/api/qa/manual/case/generate" && method === "POST") {
      const body = await asJsonBody<{ intent?: string; gameSlug?: string }>(req);
      if (!body.intent?.trim()) return sendJson(res, 400, { error: "intent required" }), true;
      const r = await resolveSession(req, body as any, url).generateCaseWithAi({
        intent: body.intent,
        slugOverride: body.gameSlug,
      });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/case-assertion { caseId, assertion, gameSlug? }
    // Append a NEW custom assertion to a case. Add-only flow — QA design
    // says no in-place edit, only add + delete, so a bad assertion is
    // replaced via delete + add (clean audit trail in git history of
    // test-cases.json).
    if (url === "/api/qa/manual/case-assertion" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string; assertion?: { id?: string; description?: string; check_code?: string } }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      if (!body.assertion?.id || !body.assertion?.check_code) {
        return sendJson(res, 400, { error: "assertion.id + assertion.check_code required" }), true;
      }
      const r = await resolveSession(req, body as any, url).addCaseAssertion(
        body.caseId,
        {
          id: body.assertion.id,
          description: body.assertion.description ?? "",
          check_code: body.assertion.check_code,
        },
        body.gameSlug,
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // DELETE /api/qa/manual/case-assertion?caseId=...&assertionId=...&game=...
    if (url.startsWith("/api/qa/manual/case-assertion") && method === "DELETE") {
      const u = new URL(url, "http://localhost");
      const caseId = u.searchParams.get("caseId");
      const assertionId = u.searchParams.get("assertionId");
      const game = u.searchParams.get("game") ?? undefined;
      if (!caseId || !assertionId) {
        return sendJson(res, 400, { error: "caseId + assertionId query params required" }), true;
      }
      const r = await resolveSession(req, null, url).deleteCaseAssertion(caseId, assertionId, game);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/case-assertion/generate { caseId, intent, gameSlug? }
    // AI-generate a new assertion from QA's plain-language intent. Does
    // NOT save — returns proposed { id, description, check_code } so
    // the dashboard can preview before commit via POST /case-assertion.
    if (url === "/api/qa/manual/case-assertion/generate" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; intent?: string; gameSlug?: string }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      if (!body.intent?.trim()) return sendJson(res, 400, { error: "intent required (plain-language description)" }), true;
      const r = await resolveSession(req, body as any, url).generateAssertionWithAi({
        caseId: body.caseId,
        intent: body.intent,
        slugOverride: body.gameSlug,
      });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/retranslate-case { caseId, gameSlug? } — re-run AI translator for one case
    if (url === "/api/qa/manual/retranslate-case" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await resolveSession(req, body as any, url).retranslateCase(body.caseId, body.gameSlug);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/apply-templates { gameSlug?, mode?: "merge" | "replace" }
    // #6 — copy the reusable standard test-case template set onto a game and
    // rebind actions. merge keeps existing cases; replace swaps them.
    if (url === "/api/qa/manual/apply-templates" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string; mode?: "merge" | "replace" }>(req);
      const r = await resolveSession(req, body as any, url).applyTemplates(
        body.gameSlug,
        body.mode === "replace" ? "replace" : "merge",
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/case-actions?caseId=...&game=... — fetch cached
    // actions + available uiKeys for the dashboard QA editor.
    if (url?.startsWith("/api/qa/manual/case-actions") && method === "GET") {
      const u = new URL(req.url ?? "", "http://x");
      const caseId = u.searchParams.get("caseId");
      const game = u.searchParams.get("game") ?? undefined;
      if (!caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await resolveSession(req, null, url).getCaseActions(caseId, game);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // PUT /api/qa/manual/case-actions { caseId, actions, gameSlug? } — save
    // QA-edited actions with validation (each click.uiKey must exist in
    // current registry).
    if (url === "/api/qa/manual/case-actions" && method === "PUT") {
      const body = await asJsonBody<{ caseId?: string; actions?: unknown[]; gameSlug?: string }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      if (!Array.isArray(body.actions)) return sendJson(res, 400, { error: "actions array required" }), true;
      const r = await resolveSession(req, body as any, url).saveCaseActions(
        body.caseId,
        body.actions as import("../step7-testcase-gen/case-action-translator.js").CaseAction[],
        body.gameSlug,
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/wait-for-stable — wait until game UI settles between cases
    if (url === "/api/qa/manual/wait-for-stable" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; minDelayMs?: number; maxMs?: number }>(req);
      const r = await resolveSession(req, body as any, url).waitForStable(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ensure-main { probe?, autoRecover?, maxRecoverAttempts? }
    // Pre-flight before each case in a batch run: OCR + dark-overlay popup
    // detection (B), plus optional spinButton behavioral probe (C).
    if (url === "/api/qa/manual/ensure-main" && method === "POST") {
      const body = await asJsonBody<{ probe?: boolean; autoRecover?: boolean; maxRecoverAttempts?: number }>(req);
      const r = await resolveSession(req, body as any, url).ensureMainScreen(body);
      return sendJson(res, 200, r), true;
    }

    // POST /api/qa/manual/ensure-ante-off {}
    // Manual trigger for the runtime `ensure_ante_off` enforcement — runs the
    // SAME ensureAnteOff used in case-run preambles against the live session so
    // a QA can verify it actually lands ante OFF (watch the embedded Chrome).
    if (url === "/api/qa/manual/ensure-ante-off" && method === "POST") {
      const body = await asJsonBody<{}>(req);
      const r = await resolveSession(req, body as any, url).testEnsureAnteOff();
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/wait-for-main { maxWaitMs?, pollMs? }
    // Smart inter-case wait — poll ensure-main every pollMs (default 2s),
    // auto-recover if popup. Returns as soon as on main, or after maxWaitMs
    // gives up. Replaces fixed-duration "60s gap between cases".
    if (url === "/api/qa/manual/wait-for-main" && method === "POST") {
      const body = await asJsonBody<{ maxWaitMs?: number; pollMs?: number }>(req);
      const r = await resolveSession(req, body as any, url).waitForMainScreen(body);
      return sendJson(res, 200, r), true;
    }

    // GET /api/qa/manual/case-result?game=<slug>&caseId=<id>
    // Returns the full CaseResult JSON from the most recent run, persisted to
    // disk by case-executor. Dashboard uses this as the AUTHORITATIVE source
    // for "review last run" — survives localStorage clears + cross-device.
    if (url.startsWith("/api/qa/manual/case-result") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!slug || !caseId) return sendJson(res, 400, { error: "game and caseId required" }), true;
      const { readFile, stat } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.result.json`);
      try {
        const txt = await readFile(file, "utf8");
        const json = JSON.parse(txt);
        // ranAt is a frontend-only field stamped when the user ran the case
        // in THIS browser. Fresh browsers (different machine, cleared cache)
        // load the result from disk and have no ranAt → "Invalid Date" in
        // the dashboard's `new Date(r.ranAt)` render. Inject file mtime as
        // fallback so the timestamp at least reflects when the case was
        // last persisted server-side.
        if (!json.ranAt) {
          try {
            const s = await stat(file);
            json.ranAt = s.mtime.toISOString();
          } catch { /* mtime read failed — leave ranAt undefined */ }
        }
        return sendJson(res, 200, { ok: true, result: json }), true;
      } catch {
        return sendJson(res, 404, { error: `no persisted result for ${caseId}` }), true;
      }
    }

    // GET /api/qa/manual/case-ocr-crop?game=<slug>&caseId=<id>&region=balance|bet|last_win|free_spin_counter
    // Returns the cropped PNG of the OCR'd bbox at end-of-case. Lets the
    // dashboard render an inline thumbnail showing what Tesseract was
    // looking at — critical for debugging "parse failed" when the bbox was
    // covered by a "PLACE YOUR BETS!" prompt or a free-spin animation.
    if (url.startsWith("/api/qa/manual/case-ocr-crop") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      const region = u.searchParams.get("region");
      const allowedRegions = ["balance", "bet", "last_win", "free_spin_counter"] as const;
      if (!slug || !caseId || !region || !(allowedRegions as readonly string[]).includes(region)) {
        return sendJson(res, 400, { error: "game, caseId, and region (balance|bet|last_win|free_spin_counter) required" }), true;
      }
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.${region}.png`);
      try {
        const buf = await readFile(file);
        return sendPng(res, buf), true;
      } catch {
        return sendJson(res, 404, { error: `no OCR crop for ${caseId}/${region}` }), true;
      }
    }

    // GET /api/qa/manual/case-network?game=<slug>&caseId=<id>
    // Returns per-case network.jsonl as text/plain (newline-delimited JSON).
    // Dashboard fetches + parses for the "📡 Network Capture" panel.
    if (url.startsWith("/api/qa/manual/case-network") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!slug || !caseId) return sendJson(res, 400, { error: "game and caseId required" }), true;
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.network.jsonl`);
      try {
        const txt = await readFile(file, "utf8");
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-length": Buffer.byteLength(txt),
          "cache-control": "no-store",
        });
        res.end(txt);
        return true;
      } catch {
        return sendJson(res, 404, { error: `no network capture for ${caseId}` }), true;
      }
    }

    // GET /api/qa/manual/case-screenshot?game=<slug>&caseId=<id>
    // Serves the case screenshot saved by case-executor. New location:
    // fixtures/registry/<slug>/case-evidence/<caseId>.png (always captured).
    // Back-compat fallback: fixtures/registry/<slug>/case-failures/<caseId>.png
    // (legacy fail-only path before 2026-05-25 evidence-pkg update).
    if (url.startsWith("/api/qa/manual/case-screenshot") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!slug || !caseId) return sendJson(res, 400, { error: "game and caseId required" }), true;
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const newFile = path.join(dirForGame(slug), "case-evidence", `${safeName}.png`);
      const legacyFile = path.join(dirForGame(slug), "case-failures", `${safeName}.png`);
      try {
        const buf = await readFile(newFile);
        return sendPng(res, buf), true;
      } catch {
        try {
          const buf = await readFile(legacyFile);
          return sendPng(res, buf), true;
        } catch {
          return sendJson(res, 404, { error: `no screenshot for ${caseId}` }), true;
        }
      }
    }

    // GET /api/qa/manual/case-video?game=<slug>&caseId=<id>
    // Streams the per-case MP4 recording saved by case-executor when
    // QA_RECORD_VIDEO=1. Supports HTTP Range requests so the HTML5 <video>
    // element can seek without downloading the full file.
    if (url.startsWith("/api/qa/manual/case-video") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!slug || !caseId) return sendJson(res, 400, { error: "game and caseId required" }), true;
      const { createReadStream, statSync } = await import("node:fs");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.mp4`);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        return sendJson(res, 404, { error: `no video for ${caseId}` }), true;
      }
      const total = stat.size;
      const range = req.headers["range"];
      if (typeof range === "string") {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : total - 1;
          if (start >= total || end >= total || start > end) {
            res.writeHead(416, { "content-range": `bytes */${total}` });
            res.end();
            return true;
          }
          res.writeHead(206, {
            "content-type": "video/mp4",
            "content-length": end - start + 1,
            "content-range": `bytes ${start}-${end}/${total}`,
            "accept-ranges": "bytes",
            "cache-control": "no-store",
          });
          createReadStream(file, { start, end }).pipe(res);
          return true;
        }
      }
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": total,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(res);
      return true;
    }

    // GET /api/qa/manual/case-history-screenshot?game=<slug>&caseId=<id>&page=<n>
    // Serves the in-game history popup PNG saved by verifyHistory per-case.
    // Page param (default 1) maps to <caseId>.history.png (page 1) or
    // <caseId>.history-p<N>.png (page 2+). Matches naming convention in
    // history-verifier.ts pagination loop.
    if (url.startsWith("/api/qa/manual/case-history-screenshot") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      const pageN = Math.max(1, Number(u.searchParams.get("page") ?? "1") || 1);
      if (!slug || !caseId) return sendJson(res, 400, { error: "game and caseId required" }), true;
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const suffix = pageN === 1 ? "" : `-p${pageN}`;
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.history${suffix}.png`);
      try {
        const buf = await readFile(file);
        return sendPng(res, buf), true;
      } catch {
        return sendJson(res, 404, { error: `no history screenshot for ${caseId} page ${pageN}` }), true;
      }
    }

    // POST /api/qa/manual/preview-case { caseId, autoMode? }
    // autoMode (default false): when set + result is fail-low/inconclusive,
    // backend chains heuristic AI Review + auto-apply patch (if conf ≥ 0.85)
    // + auto-rerun (max 3). Cost cap enforced — see autoModeRun().
    if (url === "/api/qa/manual/preview-case" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; autoMode?: boolean; ensureMain?: boolean }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      // ensureMain defaults true (pre-flight return-to-main). Dashboard run-all
      // passes false because it already ran its own ensure-main pre-flight.
      const r = body.autoMode === true
        ? await resolveSession(req, body as any, url).previewCaseAuto(body.caseId, { ensureMain: body.ensureMain })
        : await resolveSession(req, body as any, url).previewCase(body.caseId, { ensureMain: body.ensureMain });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/calibrate-payout { spinsPerLevel? }
    // Spins live at >=2 bet levels, derives + self-validates the per-game payout
    // model (Layer 2 of payout verification), stores payout-model.json.
    if (url === "/api/qa/manual/calibrate-payout" && method === "POST") {
      const body = await asJsonBody<{ spinsPerLevel?: number }>(req);
      const r = await resolveSession(req, body as any, url).calibratePayoutModel({ spinsPerLevel: body.spinsPerLevel });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/probe-pending { onlyKeys?: string[] }
    // Runtime self-validation gate for AI-discovered UI elements (P1 of AI
    // auto-discover). Clicks each pending element + observes a signal; on pass
    // flips to verified + verifiedBy="probe". Replaces most QA Pick work.
    if (url === "/api/qa/manual/probe-pending" && method === "POST") {
      const body = await asJsonBody<{ onlyKeys?: string[] }>(req);
      const r = await resolveSession(req, body as any, url).probePendingElements({ onlyKeys: body.onlyKeys });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/deep-discover { maxDepth?, maxAiCalls?, maxStates? }
    // P2 of AI auto-discover — recursive DFS from main screen via exploreUiGraph
    // (safe-click whitelist, state-hash dedup, navigate-back). After explore,
    // auto-probes newly added probeable elements.
    if (url === "/api/qa/manual/deep-discover" && method === "POST") {
      const body = await asJsonBody<{ maxDepth?: number; maxAiCalls?: number; maxStates?: number }>(req);
      const r = await resolveSession(req, body as any, url).deepDiscover(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/auto-onboard { deepDiscover?, calibrationSpinsPerLevel? }
    // P3 — one-click chain: deep-discover (P2) + payout-model calibrate. Returns
    // combined summary so dashboard can show a single "game ready" verdict.
    if (url === "/api/qa/manual/auto-onboard" && method === "POST") {
      const body = await asJsonBody<{ deepDiscover?: { maxDepth?: number; maxAiCalls?: number; maxStates?: number }; calibrationSpinsPerLevel?: number; resume?: boolean }>(req);
      const r = await resolveSession(req, body as any, url).autoOnboard(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // PUT /api/qa/manual/game-spec { betMin?, betMax?, defaultBet?, betLadder?,
    //   coinValues?, lines?, defaultCoin?, betLevels?, note? }
    // Update QA overrides applied on top of the auto-captured GameSpec.
    // Body fields are MERGED with prior override (partial PATCH). Pass
    // `null` for the whole body (or { __clear: true }) to erase. The
    // effective spec flows into AI catalog gen + action translator so
    // assertions reference QA-corrected values.
    if (url === "/api/qa/manual/game-spec" && method === "PUT") {
      const body = await asJsonBody<{ __clear?: boolean } & Partial<import("./manual-session.js").ManualSessionManager>>(req);
      const session = resolveSession(req, body as any, url);
      const patch = body && (body as any).__clear === true ? null : (body as any);
      const r = await session.setGameSpecOverride(patch);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/usage?days=7
    // Aggregate AI usage for the current QA (identified by qaHash from
    // the X-Claude-Token header → request context). Returns null hash
    // and zero counts when no token in context — dashboard renders a
    // "set your token first" hint instead of a meaningless table.
    if (url.startsWith("/api/qa/manual/usage") && method === "GET") {
      const { getCurrentQaHash } = await import("../../server/request-context.js");
      const { aggregateUsage } = await import("../../server/usage-log.js");
      const qaHash = getCurrentQaHash();
      // Parse `days` from query (default 1 = today only, max 30 to keep
      // worst-case scan O(small) — JSONL parse for 30 days × ~100 rows = trivial).
      let days = 1;
      try {
        const u = new URL(url, "http://localhost");
        const raw = Number(u.searchParams.get("days") ?? "1");
        if (Number.isFinite(raw)) days = Math.min(30, Math.max(1, Math.floor(raw)));
      } catch { /* ignore */ }
      if (!qaHash) {
        return sendJson(res, 200, { qaHash: null, days, summary: null, hint: "Set your Claude token in the dashboard to see your usage." }), true;
      }
      const summary = await aggregateUsage(qaHash, days);
      return sendJson(res, 200, { qaHash, days, summary }), true;
    }

    // POST /api/qa/manual/game-error/clear — acknowledge + clear the
    // recorded game-engine error banner. QA calls this after reloading
    // the game URL so the dashboard banner goes away + Resume button
    // re-enables. Returns updated session status.
    if (url === "/api/qa/manual/game-error/clear" && method === "POST") {
      const sess = resolveSession(req, null, url);
      sess.clearGameError();
      return sendJson(res, 200, { ok: true, status: sess.status() }), true;
    }

    // POST /api/qa/manual/validate-token { token }
    // Stateless format check for Claude tokens. Returns { ok, format }.
    // No API ping — keep cheap so dashboard can verify on every modal
    // save without burning AI cost. Pairs with isValidClaudeTokenFormat
    // in src/ai/claude.ts (same regex). Doesn't touch session state or
    // persist anything; client decides whether to store.
    if (url === "/api/qa/manual/validate-token" && method === "POST") {
      const body = await asJsonBody<{ token?: string }>(req);
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      const { isValidClaudeTokenFormat } = await import("../../ai/claude.js");
      const ok = isValidClaudeTokenFormat(token);
      return sendJson(res, 200, {
        ok,
        format: ok ? "valid" : "invalid",
        reason: ok ? undefined : "Token must match sk-ant-(oat|api)##-... pattern with ≥32-char suffix",
      }), true;
    }

    // POST /api/qa/manual/auto-onboard/pause — request a cooperative
    // pause. Server marks the flag + responds immediately; the running
    // autoOnboard checks between phases and exits cleanly after the
    // current phase finishes. State is persisted via the normal endPhase
    // path — resume reuses the same _onboard-state.json flow as
    // crash-recovery. Use case: QA spots a registry gap mid-onboard,
    // wants to manually Discover an element before catalog gen.
    if (url === "/api/qa/manual/auto-onboard/pause" && method === "POST") {
      const r = resolveSession(req, null, url).pauseAutoOnboard();
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/generate-catalog { gameSlug? }
    // In-process AI catalog generation (Session-1 refactor). Reuses
    // whatever Auto-Onboard already persisted on disk: ui-registry,
    // network/network.jsonl (canonical rounds), auxiliary-sources/*.md,
    // provider-cache, features, parser.json. No browser re-launch, no
    // proxy timeout risk — typically ~30-90s.
    if (url === "/api/qa/manual/generate-catalog" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string }>(req);
      const session = resolveSession(req, body as any, url);
      const slug = (body?.gameSlug && typeof body.gameSlug === "string")
        ? body.gameSlug
        : session.status().gameSlug;
      if (!slug) return sendJson(res, 400, { ok: false, reason: "gameSlug required (no active session and no body.gameSlug)" }), true;
      // Wrapped with mutex + status tracking so the dashboard can detect
      // completion via polling /status (generateCatalogInProgress +
      // generateCatalogLastFinishedAt) when the HTTP response is cut by a
      // proxy 504 — typical for 30-90s catalog gen behind 60s frp/nginx.
      const wrapped = await session.withGenerateCatalogMutex(async () => {
        const { phaseGenerateCatalog } = await import("./../phases/phase-generate-catalog.js");
        const { phaseTranslateCases } = await import("./../phases/phase-translate-cases.js");
        const cat = await phaseGenerateCatalog({ gameSlug: slug });
        if (!cat.ok) return { catalog: cat, translate: null };
        const translate = await phaseTranslateCases({ gameSlug: slug }).catch((err) => ({
          ok: false as const, reason: err instanceof Error ? err.message : String(err),
        }));
        return { catalog: cat, translate };
      });
      if (!wrapped.ok) {
        // Mutex held (409) or work threw — surface to client. Client may
        // already be polling if HTTP times out; this just returns fast.
        return sendJson(res, 409, { ok: false, reason: wrapped.reason }), true;
      }
      const inner = wrapped.result!;
      if (!inner.catalog.ok) return sendJson(res, 400, inner.catalog), true;
      return sendJson(res, 200, { ok: true, catalog: inner.catalog, translate: inner.translate }), true;
    }

    // POST /api/qa/manual/verify-registry — manually trigger the registry
    // verify pass (prune legacy namespaces, re-discover missing children,
    // mirror partner-pair entries). Standalone hook so QA can re-run verify
    // without a full auto-onboard, e.g. after adjusting expected-children
    // rules per game.
    if (url === "/api/qa/manual/verify-registry" && method === "POST") {
      const r = await resolveSession(req, null, url).verifyRegistry();
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/run-all-testcases { continueOnFail?, mode? }
    // Iterate every case in the AI catalog via previewCase. Catalog must
    // exist (cold-started game). Returns per-case status + aggregate counts.
    if (url === "/api/qa/manual/run-all-testcases" && method === "POST") {
      const body = await asJsonBody<{ continueOnFail?: boolean; mode?: "all" | "unrun" | "failed" }>(req);
      const r = await resolveSession(req, body as any, url).runAllTestcases(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/discovery-snapshots?gameSlug=<slug>
    // List manifests for every AI-discovered state, newest first. Used by the
    // dashboard's visual-review panel.
    if (url.startsWith("/api/qa/manual/discovery-snapshots") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("gameSlug");
      if (!slug) return sendJson(res, 400, { error: "gameSlug required" }), true;
      const { listDiscoverySnapshots } = await import("../registry/discovery-snapshots.js");
      const manifests = await listDiscoverySnapshots(slug);
      return sendJson(res, 200, { ok: true, snapshots: manifests }), true;
    }

    // GET /api/qa/manual/discovery-snapshot-image?gameSlug=<slug>&stateId=<id>
    // Serves the raw PNG for a single state snapshot. Browser draws SVG
    // overlays on top using coords from the manifest.
    if (url.startsWith("/api/qa/manual/discovery-snapshot-image") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("gameSlug");
      const stateId = u.searchParams.get("stateId");
      if (!slug || !stateId) return sendJson(res, 400, { error: "gameSlug and stateId required" }), true;
      const { loadDiscoverySnapshotImage } = await import("../registry/discovery-snapshots.js");
      const buf = await loadDiscoverySnapshotImage(slug, stateId);
      if (!buf) return sendJson(res, 404, { error: `no snapshot for ${stateId}` }), true;
      return sendPng(res, buf), true;
    }

    // POST /api/qa/manual/review-failure { caseId, gameSlug?, dryRun? }
    // Phase 7.5 — AI Review on a failed case. Returns RootCauseClassification
    // + optional SuggestedPatch. Caller can then call /apply-patch.
    if (url === "/api/qa/manual/review-failure" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string; dryRun?: boolean; result?: unknown }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await resolveSession(req, body as any, url).reviewFailure(
        body.caseId,
        body.gameSlug,
        body.dryRun === true,
        body.result as never,
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/apply-patch { caseId, gameSlug?, patch, review }
    // Phase 7.6 — validate + apply an AI-suggested patch with audit log.
    if (url === "/api/qa/manual/apply-patch" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string; patch?: unknown; review?: unknown }>(req);
      if (!body.caseId || !body.patch || !body.review) {
        return sendJson(res, 400, { error: "caseId, patch, review required" }), true;
      }
      const r = await resolveSession(req, body as any, url).applyReviewPatch(body.caseId, body.gameSlug, body.patch as never, body.review as never);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/case-stats?game=<slug>&caseId=<id>
    // Gap C — returns passRate + flakyScore + recent outcomes from history log.
    if (url.startsWith("/api/qa/manual/case-stats") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await resolveSession(req, null, url).caseStats(caseId, slug ?? undefined);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/auto-rerun { caseId, gameSlug?, patch, review }
    // Phase 8 item 3 — auto-loop: apply patch → rerun → if fail, re-review →
    // re-apply → up to MAX_RERUN_ATTEMPTS=3 times. Returns RerunResult.
    if (url === "/api/qa/manual/auto-rerun" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string; patch?: unknown; review?: unknown }>(req);
      if (!body.caseId || !body.patch || !body.review) {
        return sendJson(res, 400, { error: "caseId, patch, review required" }), true;
      }
      const r = await resolveSession(req, body as any, url).autoRerunWithPatches(body.caseId, body.gameSlug, body.patch as never, body.review as never);
      return sendJson(res, 200, r), true;
    }

    // POST /api/qa/manual/capture-click { uiKey, timeoutMs?, failIfExists? }
    // Click-thru: QA clicks the actual button in Playwright Chrome window.
    // failIfExists=true → reject if key already in registry (for ADD flow).
    if (url === "/api/qa/manual/capture-click" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; timeoutMs?: number; failIfExists?: boolean }>(req);
      if (!body.uiKey) return sendJson(res, 400, { error: "uiKey required" }), true;
      const r = await resolveSession(req, body as any, url).captureNextClick(body.uiKey, {
        timeoutMs: body.timeoutMs ?? 30000,
        failIfExists: body.failIfExists === true,
      });
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: resolveSession(req, body as any, url).status() }), true;
    }

    // GET /api/qa/manual/screenshot (with optional ?t=cachebust query string)
    if (method === "GET") {
      try {
        const pathname = new URL(url, "http://localhost").pathname;
        if (pathname === "/api/qa/manual/screenshot") {
          const buf = await resolveSession(req, null, url).screenshot();
          if (!buf) return sendJson(res, 400, { error: "no active session" }), true;
          return sendPng(res, buf), true;
        }
      } catch { /* malformed URL — fall through to other handlers */ }
    }

    // GET /api/qa/manual/ocr-regions — load current ocr-regions.json
    if (url === "/api/qa/manual/ocr-regions" && method === "GET") {
      const r = await resolveSession(req, null, url).loadOcrRegions();
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ocr-regions/auto-detect { regions?, minConfidence? }
    // AI vision picks bboxes for Balance / Bet / Win / FS-counter widgets.
    // High-confidence picks are saved straight to ocr-regions.json; low-confidence
    // picks come back as `proposed` for QA to review before committing.
    if (url === "/api/qa/manual/ocr-regions/auto-detect" && method === "POST") {
      const body = await asJsonBody<{ regions?: Array<"balanceArea" | "betArea" | "winArea" | "freeSpinCounter">; minConfidence?: number }>(req);
      const r = await resolveSession(req, body as any, url).autoDetectOcrRegions(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ocr-regions { key, x, y, width, height } — save one region
    if (url === "/api/qa/manual/ocr-regions" && method === "POST") {
      const body = await asJsonBody<{ key?: string; x?: number; y?: number; width?: number; height?: number }>(req);
      const allowedKeys = ["balanceArea", "betArea", "winArea", "freeSpinCounter"] as const;
      if (!body.key || !(allowedKeys as readonly string[]).includes(body.key)) {
        return sendJson(res, 400, { error: `key must be one of ${allowedKeys.join("|")}` }), true;
      }
      if (typeof body.x !== "number" || typeof body.y !== "number" || typeof body.width !== "number" || typeof body.height !== "number") {
        return sendJson(res, 400, { error: "x/y/width/height (number) required" }), true;
      }
      const r = await resolveSession(req, body as any, url).saveOcrRegion(
        body.key as typeof allowedKeys[number],
        { x: body.x, y: body.y, width: body.width, height: body.height },
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // DELETE /api/qa/manual/ocr-regions/proposed?key=balanceArea
    // Reject a pending proposal — removes it from ocr-regions.proposed.json
    // without saving it. Used by the dashboard's "Reject" button on
    // pending review rows. Distinct from the DELETE-ocr-regions endpoint
    // below which removes a SAVED region.
    if (url.startsWith("/api/qa/manual/ocr-regions/proposed") && method === "DELETE") {
      const u = new URL(url, "http://localhost");
      const key = u.searchParams.get("key");
      const allowedKeys = ["balanceArea", "betArea", "winArea", "freeSpinCounter"] as const;
      if (!key || !(allowedKeys as readonly string[]).includes(key)) {
        return sendJson(res, 400, { error: `key must be one of ${allowedKeys.join("|")}` }), true;
      }
      const r = await resolveSession(req, null, url).rejectOcrProposal(key as typeof allowedKeys[number]);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // DELETE /api/qa/manual/ocr-regions?key=balanceArea — remove one region
    if (url.startsWith("/api/qa/manual/ocr-regions") && method === "DELETE") {
      const u = new URL(url, "http://localhost");
      const key = u.searchParams.get("key");
      const allowedKeys = ["balanceArea", "betArea", "winArea", "freeSpinCounter"] as const;
      if (!key || !(allowedKeys as readonly string[]).includes(key)) {
        return sendJson(res, 400, { error: `key must be one of ${allowedKeys.join("|")}` }), true;
      }
      const r = await resolveSession(req, null, url).removeOcrRegion(key as typeof allowedKeys[number]);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ocr-regions/test { x, y, width, height } — dry-run OCR
    if (url === "/api/qa/manual/ocr-regions/test" && method === "POST") {
      const body = await asJsonBody<{ x?: number; y?: number; width?: number; height?: number }>(req);
      if (typeof body.x !== "number" || typeof body.y !== "number" || typeof body.width !== "number" || typeof body.height !== "number") {
        return sendJson(res, 400, { error: "x/y/width/height (number) required" }), true;
      }
      const r = await resolveSession(req, body as any, url).testOcrRegion({ x: body.x, y: body.y, width: body.width, height: body.height });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/stop
    if (url === "/api/qa/manual/stop" && method === "POST") {
      await resolveSession(req, null, url).stop();
      return sendJson(res, 200, { ok: true }), true;
    }

    // Unknown manual endpoint
    return sendJson(res, 404, { error: `unknown manual endpoint ${method} ${url}` }), true;
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }), true;
  }
}
