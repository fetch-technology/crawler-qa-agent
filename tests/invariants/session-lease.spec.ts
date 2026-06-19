// INVARIANT — hard session lease. When one QA is driving a game's live browser
// session, another QA must not be able to grab control (hard block, no
// takeover). The lease lives on ManualSessionManager: claimOwner / getOwner /
// releaseOwner. These are pure (no browser needed).

import { test, expect } from "@playwright/test";
import { ManualSessionManager } from "../../src/pipeline/server/manual-session.ts";

const alice = { id: "u-alice", username: "alice" };
const bob = { id: "u-bob", username: "bob" };

test("unleased session has no owner", () => {
  const s = new ManualSessionManager();
  expect(s.getOwner()).toBeNull();
});

test("first claim sets the owner with a timestamp", () => {
  const s = new ManualSessionManager();
  s.claimOwner(alice);
  const owner = s.getOwner();
  expect(owner?.userId).toBe("u-alice");
  expect(owner?.username).toBe("alice");
  expect(typeof owner?.since).toBe("string");
});

test("same user re-claiming is a no-op (keeps the original since)", () => {
  const s = new ManualSessionManager();
  s.claimOwner(alice);
  const first = s.getOwner()!.since;
  s.claimOwner(alice);
  expect(s.getOwner()!.since).toBe(first);
});

test("a different user claiming a held session throws (hard block)", () => {
  const s = new ManualSessionManager();
  s.claimOwner(alice);
  expect(() => s.claimOwner(bob)).toThrow(/in use by "alice"/);
  // ownership unchanged
  expect(s.getOwner()?.userId).toBe("u-alice");
});

test("release frees the lease for the next user", () => {
  const s = new ManualSessionManager();
  s.claimOwner(alice);
  s.releaseOwner();
  expect(s.getOwner()).toBeNull();
  s.claimOwner(bob);
  expect(s.getOwner()?.username).toBe("bob");
});

test("getOwner returns a copy, not the internal reference", () => {
  const s = new ManualSessionManager();
  s.claimOwner(alice);
  const o = s.getOwner()!;
  o.username = "mutated";
  expect(s.getOwner()?.username).toBe("alice");
});
