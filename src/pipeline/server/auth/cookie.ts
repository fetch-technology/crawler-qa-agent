// Tiny cookie helpers for the raw node:http server (no express/cookie dep).

import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_COOKIE } from "./session-store.js";

/** Parse a Cookie header into a flat map. */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers["cookie"];
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionToken(req: IncomingMessage): string | null {
  return parseCookies(req)[SESSION_COOKIE] ?? null;
}

/** Append a Set-Cookie for the session token (httpOnly, SameSite=Lax, path=/).
 *  maxAgeSec=0 expires the cookie (logout). Not marked Secure so it works on
 *  the LAN/localhost HTTP dashboard; tighten to Secure behind HTTPS via
 *  QA_COOKIE_SECURE=1. */
export function setSessionCookie(res: ServerResponse, token: string, maxAgeSec: number): void {
  const secure = process.env.QA_COOKIE_SECURE === "1" ? "; Secure" : "";
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
  appendSetCookie(res, cookie);
}

export function clearSessionCookie(res: ServerResponse): void {
  appendSetCookie(res, `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", cookie);
  else if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, cookie]);
  else res.setHeader("Set-Cookie", [String(existing), cookie]);
}
