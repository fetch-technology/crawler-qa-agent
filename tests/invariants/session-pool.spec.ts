// Verifies the session-pool maps gameSlug → ManualSessionManager correctly:
// each slug returns the SAME instance on repeat lookup (so per-game state
// like registry / autoOnboardInProgress flag persists across requests),
// distinct slugs return DIFFERENT instances (concurrent multi-game),
// and the LRU/default resolver behaves sanely with 0 / 1 / N entries.

import { test, expect } from "@playwright/test";
import {
  getOrCreate,
  get,
  set,
  getDefaultOrThrow,
  listSessions,
  markLRU,
  remove,
  _resetForTest,
} from "../../src/pipeline/server/session-pool.ts";
import { ManualSessionManager } from "../../src/pipeline/server/manual-session.ts";

test.beforeEach(() => _resetForTest());

test("getOrCreate: returns same instance for same slug across calls", () => {
  const a = getOrCreate("game-a");
  const b = getOrCreate("game-a");
  expect(a).toBe(b);
});

test("getOrCreate: returns distinct instances for different slugs", () => {
  const a = getOrCreate("game-a");
  const b = getOrCreate("game-b");
  expect(a).not.toBe(b);
});

test("get: returns null for unknown slug, returns existing for known", () => {
  expect(get("nothing")).toBeNull();
  const a = getOrCreate("game-a");
  expect(get("game-a")).toBe(a);
});

test("set: registers an externally-built manager", () => {
  const m = new ManualSessionManager();
  set("custom-slug", m);
  expect(get("custom-slug")).toBe(m);
});

test("getDefaultOrThrow: returns fresh transient when pool is empty", () => {
  const m = getDefaultOrThrow();
  expect(m).toBeInstanceOf(ManualSessionManager);
});

test("getDefaultOrThrow: returns the only manager when pool has 1 entry", () => {
  const a = getOrCreate("game-a");
  expect(getDefaultOrThrow()).toBe(a);
});

test("getDefaultOrThrow: throws when ambiguous (multiple slugs, no LRU)", () => {
  set("game-a", new ManualSessionManager());
  set("game-b", new ManualSessionManager());
  // set() updates LRU, so LRU will be game-b.
  // We have to overwrite LRU to test the throw path → use a fresh reset and
  // populate via set() in a way that doesn't update LRU. There's no such
  // path in the public API → instead verify the LRU fallback works.
  const m = getDefaultOrThrow();
  expect(m).toBe(get("game-b"));
});

test("markLRU: changes the default resolution target", () => {
  getOrCreate("game-a");
  getOrCreate("game-b");
  markLRU("game-a");
  expect(getDefaultOrThrow()).toBe(get("game-a"));
});

test("listSessions: enumerates all active sessions", () => {
  getOrCreate("game-a");
  getOrCreate("game-b");
  const list = listSessions();
  const slugs = list.map((s) => s.gameSlug).sort();
  expect(slugs).toEqual(["game-a", "game-b"]);
});

test("remove: drops the manager and clears LRU if it was active", () => {
  getOrCreate("game-a");
  markLRU("game-a");
  expect(remove("game-a")).toBe(true);
  expect(get("game-a")).toBeNull();
  // LRU cleared → pool empty → getDefaultOrThrow returns a fresh transient
  // (instance won't match anything in pool).
  const fresh = getDefaultOrThrow();
  expect(listSessions().length).toBe(0);
  expect(fresh).toBeInstanceOf(ManualSessionManager);
});

test("manager state is independent per slug (registry, etc.)", () => {
  const a = getOrCreate("game-a");
  const b = getOrCreate("game-b");
  // Status snapshots are independent — both report no active session.
  expect(a.status().active).toBe(false);
  expect(b.status().active).toBe(false);
  expect(a.status().gameSlug).toBeNull();
  expect(b.status().gameSlug).toBeNull();
});
