// QA user accounts — local username/password store. Backs the dashboard
// login system (multi-QA, parallel use). No external deps: passwords are
// hashed with Node's scrypt + a per-user random salt, compared in constant
// time. The store is a single JSON file (fixtures/auth/users.json) that is
// .gitignored — it holds password hashes, never plaintext.
//
// Roles: "admin" can manage other users; "qa" is a normal operator. The first
// admin is seeded from env (QA_ADMIN_USER / QA_ADMIN_PASSWORD) at startup —
// see ensureSeedAdmin().

import path from "node:path";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const scrypt = promisify(scryptCb);

// AUTH_DIR is resolved per-call so tests can override via QA_AUTH_DIR. In
// production the env var is unset and it stays fixtures/auth under cwd.
function authDir(): string {
  return process.env.QA_AUTH_DIR
    ? path.resolve(process.env.QA_AUTH_DIR)
    : path.resolve(process.cwd(), "fixtures", "auth");
}
function usersFile(): string {
  return path.join(authDir(), "users.json");
}

const SCRYPT_KEYLEN = 64;

export type UserRole = "admin" | "qa";

/** Stored shape — includes the password hash. Never send this to clients. */
export type StoredUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** scrypt(password, salt) as hex. */
  passwordHash: string;
  /** Per-user random salt as hex. */
  salt: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Client-safe projection — no hash/salt. */
export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
};

type UsersFile = { users: StoredUser[] };

export function toPublicUser(u: StoredUser): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
  };
}

async function loadFile(): Promise<UsersFile> {
  try {
    const raw = await readFile(usersFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    if (!parsed || !Array.isArray(parsed.users)) return { users: [] };
    return { users: parsed.users };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
    throw err;
  }
}

async function saveFile(data: UsersFile): Promise<void> {
  await mkdir(authDir(), { recursive: true });
  await writeFile(usersFile(), JSON.stringify(data, null, 2), "utf8");
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return derived.toString("hex");
}

/** Constant-time compare of a candidate password against a stored hash. */
async function verifyHash(password: string, salt: string, expectedHex: string): Promise<boolean> {
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function listUsers(): Promise<PublicUser[]> {
  const { users } = await loadFile();
  return users.map(toPublicUser);
}

export async function countUsers(): Promise<number> {
  const { users } = await loadFile();
  return users.length;
}

export async function findByUsername(username: string): Promise<StoredUser | null> {
  const { users } = await loadFile();
  const norm = normalizeUsername(username);
  return users.find((u) => u.username === norm) ?? null;
}

export async function findById(id: string): Promise<StoredUser | null> {
  const { users } = await loadFile();
  return users.find((u) => u.id === id) ?? null;
}

export type CreateUserInput = {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
};

/** Create a user. Throws on duplicate username or weak/empty input. */
export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (!username || !/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("username must be 3-32 chars: a-z 0-9 . _ -");
  }
  if (!input.password || input.password.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  const data = await loadFile();
  if (data.users.some((u) => u.username === username)) {
    throw new Error(`user "${username}" already exists`);
  }
  const salt = randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  const user: StoredUser = {
    id: randomBytes(12).toString("hex"),
    username,
    displayName: (input.displayName ?? input.username).trim() || username,
    role: input.role === "admin" ? "admin" : "qa",
    passwordHash: await hashPassword(input.password, salt),
    salt,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };
  data.users.push(user);
  await saveFile(data);
  return toPublicUser(user);
}

/** Verify credentials. Returns the user on success, null otherwise (no
 *  distinction between unknown-user and bad-password, by design). Disabled
 *  users never authenticate. */
export async function verifyCredentials(username: string, password: string): Promise<StoredUser | null> {
  const user = await findByUsername(username);
  if (!user || user.disabled) {
    // Still run a hash to keep timing roughly uniform for unknown users.
    if (!user) await hashPassword(password, "00000000000000000000000000000000");
    return null;
  }
  const ok = await verifyHash(password, user.salt, user.passwordHash);
  return ok ? user : null;
}

export async function setPassword(userId: string, newPassword: string): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  const data = await loadFile();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error("user not found");
  user.salt = randomBytes(16).toString("hex");
  user.passwordHash = await hashPassword(newPassword, user.salt);
  user.updatedAt = new Date().toISOString();
  await saveFile(data);
}

export async function setDisabled(userId: string, disabled: boolean): Promise<void> {
  const data = await loadFile();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error("user not found");
  user.disabled = disabled;
  user.updatedAt = new Date().toISOString();
  await saveFile(data);
}

/** Seed the first admin from env when the store is empty. Idempotent: does
 *  nothing once any user exists. Returns the created username (for logging)
 *  or null when nothing was seeded. */
export async function ensureSeedAdmin(): Promise<string | null> {
  if ((await countUsers()) > 0) return null;
  const username = process.env.QA_ADMIN_USER?.trim();
  const password = process.env.QA_ADMIN_PASSWORD;
  if (!username || !password) return null;
  await createUser({ username, password, displayName: username, role: "admin" });
  return normalizeUsername(username);
}
