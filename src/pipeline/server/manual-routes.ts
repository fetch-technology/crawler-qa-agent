// HTTP routes for Phase 6.1 — Manual Verify dashboard. Mounted from
// src/server/index.ts. Routes prefixed with /api/qa/manual.

import type { IncomingMessage, ServerResponse } from "node:http";
import { manualSession, listRegisteredGames, updateGameUrl, deleteGame } from "./manual-session.js";

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
        const status = await manualSession.resume(body.gameSlug);
        return sendJson(res, 200, status), true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /already active/.test(msg) ? 409 : /No registry|No ui-registry/.test(msg) ? 404 : 500;
        return sendJson(res, code, { error: msg }), true;
      }
    }

    // POST /api/qa/manual/start { url, autoDiscover? }
    if (url === "/api/qa/manual/start" && method === "POST") {
      const body = await asJsonBody<{ url?: string; autoDiscover?: boolean }>(req);
      if (!body.url) return sendJson(res, 400, { error: "url required" }), true;
      try {
        const status = await manualSession.start(body.url, { autoDiscover: body.autoDiscover ?? true });
        return sendJson(res, 200, status), true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /already active/.test(msg) ? 409 : 500;
        return sendJson(res, code, { error: msg }), true;
      }
    }

    // GET /api/qa/manual/status
    if (url === "/api/qa/manual/status" && method === "GET") {
      return sendJson(res, 200, manualSession.status()), true;
    }

    // POST /api/qa/manual/click { uiKey } | { x, y }
    if (url === "/api/qa/manual/click" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (body.uiKey) {
        const r = await manualSession.clickElement(body.uiKey);
        return sendJson(res, r.ok ? 200 : 400, r), true;
      }
      if (typeof body.x === "number" && typeof body.y === "number") {
        const r = await manualSession.clickAt(body.x, body.y);
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
      await manualSession.confirm(body.uiKey);
      return sendJson(res, 200, manualSession.status()), true;
    }

    // POST /api/qa/manual/confirm-children { parentKey } — bulk verify ALL
    // descendants of a parent element.
    if (url === "/api/qa/manual/confirm-children" && method === "POST") {
      const body = await asJsonBody<{ parentKey?: string }>(req);
      if (!body.parentKey) {
        return sendJson(res, 400, { error: "parentKey required" }), true;
      }
      const r = await manualSession.confirmChildren(body.parentKey);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: manualSession.status() }), true;
    }

    // POST /api/qa/manual/update { uiKey, x, y }
    if (url === "/api/qa/manual/update" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (!body.uiKey || typeof body.x !== "number" || typeof body.y !== "number") {
        return sendJson(res, 400, { error: "uiKey, x, y required" }), true;
      }
      await manualSession.updateCoord(body.uiKey, body.x, body.y);
      return sendJson(res, 200, manualSession.status()), true;
    }

    // POST /api/qa/manual/add { uiKey, x, y }
    if (url === "/api/qa/manual/add" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; x?: number; y?: number }>(req);
      if (!body.uiKey || typeof body.x !== "number" || typeof body.y !== "number") {
        return sendJson(res, 400, { error: "uiKey, x, y required" }), true;
      }
      await manualSession.addElement(body.uiKey, body.x, body.y);
      return sendJson(res, 200, manualSession.status()), true;
    }

    // DELETE /api/qa/manual/element/:uiKey
    if (url.startsWith("/api/qa/manual/element/") && method === "DELETE") {
      const uiKey = decodeURIComponent(url.slice("/api/qa/manual/element/".length));
      await manualSession.removeElement(uiKey);
      return sendJson(res, 200, manualSession.status()), true;
    }

    // POST /api/qa/manual/discover-via { triggerKey, stateLabel }
    // One-click sub-state discovery: backend clicks trigger button, waits for
    // popup, AI detects elements, saves under namespace.
    if (url === "/api/qa/manual/discover-via" && method === "POST") {
      const body = await asJsonBody<{ triggerKey?: string; stateLabel?: string }>(req);
      if (!body.triggerKey || !body.stateLabel) {
        return sendJson(res, 400, { error: "triggerKey and stateLabel required" }), true;
      }
      const r = await manualSession.discoverVia(body.triggerKey, body.stateLabel);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: manualSession.status() }), true;
    }

    // POST /api/qa/manual/discover-state { stateLabel }
    // Multi-level discovery: AI detect all clickable elements in current
    // sub-screen (popup), namespace them as <stateLabel>__<key>.
    if (url === "/api/qa/manual/discover-state" && method === "POST") {
      const body = await asJsonBody<{ stateLabel?: string }>(req);
      if (!body.stateLabel) return sendJson(res, 400, { error: "stateLabel required" }), true;
      const r = await manualSession.discoverSubState(body.stateLabel);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: manualSession.status() }), true;
    }

    // POST /api/qa/manual/ai-recover { uiKey }
    if (url === "/api/qa/manual/ai-recover" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string }>(req);
      if (!body.uiKey) return sendJson(res, 400, { error: "uiKey required" }), true;
      const r = await manualSession.aiRecover(body.uiKey);
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: manualSession.status() }), true;
    }

    // GET /api/qa/manual/cases?game=<slug> — list test cases + translated actions from disk
    // Accepts ?game= query param to inspect any registered game without active session.
    if (url.startsWith("/api/qa/manual/cases") && method === "GET") {
      const slugMatch = url.match(/[?&]game=([^&]+)/);
      const slug = slugMatch ? decodeURIComponent(slugMatch[1]!) : undefined;
      const r = await manualSession.listCases(slug);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/retranslate-all { gameSlug?, mode?: "skipped" | "all" }
    if (url === "/api/qa/manual/retranslate-all" && method === "POST") {
      const body = await asJsonBody<{ gameSlug?: string; mode?: "skipped" | "all" }>(req);
      const r = await manualSession.retranslateAllSkipped({
        slugOverride: body.gameSlug,
        mode: body.mode,
      });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/retranslate-case { caseId, gameSlug? } — re-run AI translator for one case
    if (url === "/api/qa/manual/retranslate-case" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await manualSession.retranslateCase(body.caseId, body.gameSlug);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/case-actions?caseId=...&game=... — fetch cached
    // actions + available uiKeys for the dashboard QA editor.
    if (url?.startsWith("/api/qa/manual/case-actions") && method === "GET") {
      const u = new URL(req.url ?? "", "http://x");
      const caseId = u.searchParams.get("caseId");
      const game = u.searchParams.get("game") ?? undefined;
      if (!caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await manualSession.getCaseActions(caseId, game);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // PUT /api/qa/manual/case-actions { caseId, actions, gameSlug? } — save
    // QA-edited actions with validation (each click.uiKey must exist in
    // current registry).
    if (url === "/api/qa/manual/case-actions" && method === "PUT") {
      const body = await asJsonBody<{ caseId?: string; actions?: unknown[]; gameSlug?: string }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      if (!Array.isArray(body.actions)) return sendJson(res, 400, { error: "actions array required" }), true;
      const r = await manualSession.saveCaseActions(
        body.caseId,
        body.actions as import("../step7-testcase-gen/case-action-translator.js").CaseAction[],
        body.gameSlug,
      );
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/wait-for-stable — wait until game UI settles between cases
    if (url === "/api/qa/manual/wait-for-stable" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; minDelayMs?: number; maxMs?: number }>(req);
      const r = await manualSession.waitForStable(body);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ensure-main { probe?, autoRecover?, maxRecoverAttempts? }
    // Pre-flight before each case in a batch run: OCR + dark-overlay popup
    // detection (B), plus optional spinButton behavioral probe (C).
    if (url === "/api/qa/manual/ensure-main" && method === "POST") {
      const body = await asJsonBody<{ probe?: boolean; autoRecover?: boolean; maxRecoverAttempts?: number }>(req);
      const r = await manualSession.ensureMainScreen(body);
      return sendJson(res, 200, r), true;
    }

    // POST /api/qa/manual/wait-for-main { maxWaitMs?, pollMs? }
    // Smart inter-case wait — poll ensure-main every pollMs (default 2s),
    // auto-recover if popup. Returns as soon as on main, or after maxWaitMs
    // gives up. Replaces fixed-duration "60s gap between cases".
    if (url === "/api/qa/manual/wait-for-main" && method === "POST") {
      const body = await asJsonBody<{ maxWaitMs?: number; pollMs?: number }>(req);
      const r = await manualSession.waitForMainScreen(body);
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
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { dirForGame } = await import("../registry/paths.js");
      const safeName = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = path.join(dirForGame(slug), "case-evidence", `${safeName}.result.json`);
      try {
        const txt = await readFile(file, "utf8");
        const json = JSON.parse(txt);
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
        ? await manualSession.previewCaseAuto(body.caseId, { ensureMain: body.ensureMain })
        : await manualSession.previewCase(body.caseId, { ensureMain: body.ensureMain });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/review-failure { caseId, gameSlug?, dryRun? }
    // Phase 7.5 — AI Review on a failed case. Returns RootCauseClassification
    // + optional SuggestedPatch. Caller can then call /apply-patch.
    if (url === "/api/qa/manual/review-failure" && method === "POST") {
      const body = await asJsonBody<{ caseId?: string; gameSlug?: string; dryRun?: boolean; result?: unknown }>(req);
      if (!body.caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await manualSession.reviewFailure(
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
      const r = await manualSession.applyReviewPatch(body.caseId, body.gameSlug, body.patch as never, body.review as never);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // GET /api/qa/manual/case-stats?game=<slug>&caseId=<id>
    // Gap C — returns passRate + flakyScore + recent outcomes from history log.
    if (url.startsWith("/api/qa/manual/case-stats") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const slug = u.searchParams.get("game");
      const caseId = u.searchParams.get("caseId");
      if (!caseId) return sendJson(res, 400, { error: "caseId required" }), true;
      const r = await manualSession.caseStats(caseId, slug ?? undefined);
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
      const r = await manualSession.autoRerunWithPatches(body.caseId, body.gameSlug, body.patch as never, body.review as never);
      return sendJson(res, 200, r), true;
    }

    // POST /api/qa/manual/capture-click { uiKey, timeoutMs?, failIfExists? }
    // Click-thru: QA clicks the actual button in Playwright Chrome window.
    // failIfExists=true → reject if key already in registry (for ADD flow).
    if (url === "/api/qa/manual/capture-click" && method === "POST") {
      const body = await asJsonBody<{ uiKey?: string; timeoutMs?: number; failIfExists?: boolean }>(req);
      if (!body.uiKey) return sendJson(res, 400, { error: "uiKey required" }), true;
      const r = await manualSession.captureNextClick(body.uiKey, {
        timeoutMs: body.timeoutMs ?? 30000,
        failIfExists: body.failIfExists === true,
      });
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: manualSession.status() }), true;
    }

    // GET /api/qa/manual/screenshot (with optional ?t=cachebust query string)
    if (method === "GET") {
      try {
        const pathname = new URL(url, "http://localhost").pathname;
        if (pathname === "/api/qa/manual/screenshot") {
          const buf = await manualSession.screenshot();
          if (!buf) return sendJson(res, 400, { error: "no active session" }), true;
          return sendPng(res, buf), true;
        }
      } catch { /* malformed URL — fall through to other handlers */ }
    }

    // GET /api/qa/manual/ocr-regions — load current ocr-regions.json
    if (url === "/api/qa/manual/ocr-regions" && method === "GET") {
      const r = await manualSession.loadOcrRegions();
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
      const r = await manualSession.saveOcrRegion(
        body.key as typeof allowedKeys[number],
        { x: body.x, y: body.y, width: body.width, height: body.height },
      );
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
      const r = await manualSession.removeOcrRegion(key as typeof allowedKeys[number]);
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/ocr-regions/test { x, y, width, height } — dry-run OCR
    if (url === "/api/qa/manual/ocr-regions/test" && method === "POST") {
      const body = await asJsonBody<{ x?: number; y?: number; width?: number; height?: number }>(req);
      if (typeof body.x !== "number" || typeof body.y !== "number" || typeof body.width !== "number" || typeof body.height !== "number") {
        return sendJson(res, 400, { error: "x/y/width/height (number) required" }), true;
      }
      const r = await manualSession.testOcrRegion({ x: body.x, y: body.y, width: body.width, height: body.height });
      return sendJson(res, r.ok ? 200 : 400, r), true;
    }

    // POST /api/qa/manual/stop
    if (url === "/api/qa/manual/stop" && method === "POST") {
      await manualSession.stop();
      return sendJson(res, 200, { ok: true }), true;
    }

    // Unknown manual endpoint
    return sendJson(res, 404, { error: `unknown manual endpoint ${method} ${url}` }), true;
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }), true;
  }
}
