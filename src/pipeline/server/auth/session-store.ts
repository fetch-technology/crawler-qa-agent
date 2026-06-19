// Server-side auth sessions (login tokens). A successful login mints a random
// opaque token, set as the httpOnly `qa_session` cookie. The token maps to a
// userId here. Tokens are persisted to fixtures/auth/sessions.json so a server
// restart (pm2 restart qa) doesn't log everyone out.
//
// TTL is sliding: each validated request bumps `expiresAt`. Expired tokens are
// swept lazily on access and on save. This is intentionally simple (no JWT, no
// crypto signing) — the token is unguessable (32 random bytes) and never leaves
// the httpOnly cookie.

import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

function authDir(): string {
  return process.env.QA_AUTH_DIR
    ? path.resolve(process.env.QA_AUTH_DIR)
    : path.resolve(process.cwd(), "fixtures", "auth");
}
function sessionsFile(): string {
  return path.join(authDir(), "sessions.json");
}

export const SESSION_COOKIE = "qa_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding

type SessionRecord = {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
};

type SessionsFile = { sessions: SessionRecord[] };

// In-memory index, loaded once and kept in sync with the file. Writes are
// write-through so concurrent server instances aren't supported (matches the
// single-process pool model already in use).
let cache: Map<string, SessionRecord> | null = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const map = new Map<string, SessionRecord>();
      try {
        const raw = await readFile(sessionsFile(), "utf8");
        const parsed = JSON.parse(raw) as Partial<SessionsFile>;
        const now = Date.now();
        for (const s of parsed.sessions ?? []) {
          if (s.token && s.expiresAt > now) map.set(s.token, s);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      cache = map;
    })();
  }
  await loadPromise;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const now = Date.now();
  const sessions = [...cache.values()].filter((s) => s.expiresAt > now);
  await mkdir(authDir(), { recursive: true });
  await writeFile(sessionsFile(), JSON.stringify({ sessions }, null, 2), "utf8");
}

export async function createSession(userId: string): Promise<string> {
  await ensureLoaded();
  const now = Date.now();
  const token = randomBytes(32).toString("hex");
  cache!.set(token, { token, userId, createdAt: now, expiresAt: now + TTL_MS, lastSeen: now });
  await persist();
  return token;
}

/** Resolve a token to its userId, sliding the TTL forward. Returns null for
 *  unknown/expired tokens. Persists at most once per minute of lastSeen drift
 *  to avoid a disk write on every request. */
export async function resolveSession(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  await ensureLoaded();
  const rec = cache!.get(token);
  const now = Date.now();
  if (!rec || rec.expiresAt <= now) {
    if (rec) {
      cache!.delete(token);
      void persist();
    }
    return null;
  }
  rec.expiresAt = now + TTL_MS;
  // Throttle disk writes: only persist the slide if lastSeen is >60s stale.
  if (now - rec.lastSeen > 60_000) {
    rec.lastSeen = now;
    void persist();
  } else {
    rec.lastSeen = now;
  }
  return rec.userId;
}

export async function destroySession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await ensureLoaded();
  if (cache!.delete(token)) await persist();
}

/** Revoke every session for a user (e.g. on disable / password reset). */
export async function destroySessionsForUser(userId: string): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const [token, rec] of cache!) {
    if (rec.userId === userId) {
      cache!.delete(token);
      changed = true;
    }
  }
  if (changed) await persist();
}

/** Test-only: reset the in-memory cache so a fresh file is re-read. */
export function _resetCacheForTests(): void {
  cache = null;
  loadPromise = null;
}
