// Auth HTTP routes — /api/qa/auth/*. Mounted from src/server/index.ts BEFORE
// the gate (login must be reachable while logged out). Returns true when it
// handled the request.
//
//   POST /api/qa/auth/login    { username, password }  -> set cookie, { user }
//   POST /api/qa/auth/logout                            -> clear cookie
//   GET  /api/qa/auth/me                                -> { user } | 401
//
// Admin-only (role=admin) user management:
//   GET  /api/qa/auth/users                             -> { users }
//   POST /api/qa/auth/users        { username, password, displayName?, role? }
//   POST /api/qa/auth/users/password   { userId, password }
//   POST /api/qa/auth/users/disable    { userId, disabled }

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createUser,
  listUsers,
  setDisabled,
  setPassword,
  toPublicUser,
  verifyCredentials,
  findById,
} from "./user-store.js";
import { createSession, destroySession, destroySessionsForUser } from "./session-store.js";
import { getSessionToken, setSessionCookie, clearSessionCookie } from "./cookie.js";
import { getCurrentUser } from "../../../server/request-context.js";

const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith("/api/qa/auth")) return false;
  const pathOnly = url.split("?")[0]!;

  try {
    // --- login (unauthenticated) ---
    if (pathOnly === "/api/qa/auth/login" && method === "POST") {
      const body = await readJson<{ username?: string; password?: string }>(req);
      if (!body.username || !body.password) {
        return sendJson(res, 400, { ok: false, error: "username and password required" }), true;
      }
      const user = await verifyCredentials(body.username, body.password);
      if (!user) return sendJson(res, 401, { ok: false, error: "invalid credentials" }), true;
      const token = await createSession(user.id);
      setSessionCookie(res, token, SESSION_MAX_AGE_SEC);
      return sendJson(res, 200, { ok: true, user: toPublicUser(user) }), true;
    }

    // --- logout ---
    if (pathOnly === "/api/qa/auth/logout" && method === "POST") {
      await destroySession(getSessionToken(req));
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true }), true;
    }

    // --- me (current user; relies on gate having resolved context) ---
    if (pathOnly === "/api/qa/auth/me" && method === "GET") {
      const me = getCurrentUser();
      if (!me) return sendJson(res, 401, { ok: false, error: "not authenticated" }), true;
      const full = await findById(me.id);
      if (!full) return sendJson(res, 401, { ok: false, error: "not authenticated" }), true;
      return sendJson(res, 200, { ok: true, user: toPublicUser(full) }), true;
    }

    // --- admin: user management ---
    const me = getCurrentUser();
    if (!me) return sendJson(res, 401, { ok: false, error: "not authenticated" }), true;
    if (me.role !== "admin") return sendJson(res, 403, { ok: false, error: "admin only" }), true;

    if (pathOnly === "/api/qa/auth/users" && method === "GET") {
      return sendJson(res, 200, { ok: true, users: await listUsers() }), true;
    }

    if (pathOnly === "/api/qa/auth/users" && method === "POST") {
      const body = await readJson<{ username?: string; password?: string; displayName?: string; role?: string }>(req);
      if (!body.username || !body.password) {
        return sendJson(res, 400, { ok: false, error: "username and password required" }), true;
      }
      try {
        const user = await createUser({
          username: body.username,
          password: body.password,
          displayName: body.displayName,
          role: body.role === "admin" ? "admin" : "qa",
        });
        return sendJson(res, 200, { ok: true, user }), true;
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }), true;
      }
    }

    if (pathOnly === "/api/qa/auth/users/password" && method === "POST") {
      const body = await readJson<{ userId?: string; password?: string }>(req);
      if (!body.userId || !body.password) {
        return sendJson(res, 400, { ok: false, error: "userId and password required" }), true;
      }
      try {
        await setPassword(body.userId, body.password);
        await destroySessionsForUser(body.userId); // force re-login with new password
        return sendJson(res, 200, { ok: true }), true;
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }), true;
      }
    }

    if (pathOnly === "/api/qa/auth/users/disable" && method === "POST") {
      const body = await readJson<{ userId?: string; disabled?: boolean }>(req);
      if (!body.userId || typeof body.disabled !== "boolean") {
        return sendJson(res, 400, { ok: false, error: "userId and disabled(boolean) required" }), true;
      }
      if (body.userId === me.id && body.disabled) {
        return sendJson(res, 400, { ok: false, error: "cannot disable your own account" }), true;
      }
      try {
        await setDisabled(body.userId, body.disabled);
        if (body.disabled) await destroySessionsForUser(body.userId);
        return sendJson(res, 200, { ok: true }), true;
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }), true;
      }
    }

    return sendJson(res, 404, { ok: false, error: "unknown auth route" }), true;
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
}
