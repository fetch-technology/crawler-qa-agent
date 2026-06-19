// INVARIANT — QA auth: user store (scrypt creds) + session store (sliding
// tokens). These back the dashboard login system (multi-QA parallel use).
// Each test isolates the on-disk store via QA_AUTH_DIR → a fresh temp dir.

import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createUser,
  verifyCredentials,
  setPassword,
  setDisabled,
  listUsers,
  countUsers,
  ensureSeedAdmin,
  findByUsername,
} from "../../src/pipeline/server/auth/user-store.ts";
import {
  createSession,
  resolveSession,
  destroySession,
  destroySessionsForUser,
  _resetCacheForTests,
} from "../../src/pipeline/server/auth/session-store.ts";

function freshAuthDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-auth-"));
  process.env.QA_AUTH_DIR = dir;
  _resetCacheForTests();
  return dir;
}

test.afterEach(() => {
  const dir = process.env.QA_AUTH_DIR;
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  delete process.env.QA_AUTH_DIR;
  delete process.env.QA_ADMIN_USER;
  delete process.env.QA_ADMIN_PASSWORD;
  _resetCacheForTests();
});

test("create + verify credentials (correct vs wrong password)", async () => {
  freshAuthDir();
  const u = await createUser({ username: "Alice", password: "s3cret!", role: "qa" });
  expect(u.username).toBe("alice"); // normalized lowercase
  expect((u as any).passwordHash).toBeUndefined(); // public projection has no hash

  expect(await verifyCredentials("alice", "s3cret!")).not.toBeNull();
  expect(await verifyCredentials("ALICE", "s3cret!")).not.toBeNull(); // case-insensitive
  expect(await verifyCredentials("alice", "wrong")).toBeNull();
  expect(await verifyCredentials("ghost", "whatever")).toBeNull();
});

test("duplicate username and weak input are rejected", async () => {
  freshAuthDir();
  await createUser({ username: "bob", password: "abcdef" });
  await expect(createUser({ username: "BOB", password: "another" })).rejects.toThrow(/already exists/);
  await expect(createUser({ username: "x", password: "abcdef" })).rejects.toThrow(/3-32/);
  await expect(createUser({ username: "validname", password: "123" })).rejects.toThrow(/at least 6/);
});

test("setPassword rotates the hash; old password stops working", async () => {
  freshAuthDir();
  const u = await createUser({ username: "carol", password: "oldpass" });
  await setPassword(u.id, "newpass");
  expect(await verifyCredentials("carol", "oldpass")).toBeNull();
  expect(await verifyCredentials("carol", "newpass")).not.toBeNull();
});

test("disabled users cannot authenticate", async () => {
  freshAuthDir();
  const u = await createUser({ username: "dave", password: "abcdef" });
  await setDisabled(u.id, true);
  expect(await verifyCredentials("dave", "abcdef")).toBeNull();
  await setDisabled(u.id, false);
  expect(await verifyCredentials("dave", "abcdef")).not.toBeNull();
});

test("ensureSeedAdmin seeds once from env, then is a no-op", async () => {
  freshAuthDir();
  expect(await countUsers()).toBe(0);
  process.env.QA_ADMIN_USER = "root";
  process.env.QA_ADMIN_PASSWORD = "rootpass";
  const seeded = await ensureSeedAdmin();
  expect(seeded).toBe("root");
  const admin = await findByUsername("root");
  expect(admin?.role).toBe("admin");
  // idempotent — store no longer empty
  expect(await ensureSeedAdmin()).toBeNull();
  expect(await countUsers()).toBe(1);
});

test("ensureSeedAdmin without env vars seeds nothing", async () => {
  freshAuthDir();
  expect(await ensureSeedAdmin()).toBeNull();
  expect(await listUsers()).toEqual([]);
});

test("session token resolves to userId, survives, and is revocable", async () => {
  freshAuthDir();
  const token = await createSession("user-123");
  expect(await resolveSession(token)).toBe("user-123");
  expect(await resolveSession("bogus")).toBeNull();
  expect(await resolveSession(null)).toBeNull();
  await destroySession(token);
  expect(await resolveSession(token)).toBeNull();
});

test("destroySessionsForUser revokes every token for that user only", async () => {
  freshAuthDir();
  const a1 = await createSession("alice");
  const a2 = await createSession("alice");
  const b1 = await createSession("bob");
  await destroySessionsForUser("alice");
  expect(await resolveSession(a1)).toBeNull();
  expect(await resolveSession(a2)).toBeNull();
  expect(await resolveSession(b1)).toBe("bob");
});

test("sessions persist across a cache reset (simulated restart)", async () => {
  freshAuthDir();
  const token = await createSession("persist-me");
  _resetCacheForTests(); // forces a fresh read from sessions.json
  expect(await resolveSession(token)).toBe("persist-me");
});
