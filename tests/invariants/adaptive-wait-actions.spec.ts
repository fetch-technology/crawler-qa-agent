// INVARIANT — adaptive wait action types (Gap D)
//
// Verifies the action type schema accepts wait_until_state, wait_until_network_idle,
// wait_until_pixel_stable with their expected fields. Pure type-shape tests.

import { test, expect } from "@playwright/test";
import type { CaseAction } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";

test("wait_until_state action shape", () => {
  const a: CaseAction = { kind: "wait_until_state", state: "MAIN", maxMs: 30000 };
  expect(a.kind).toBe("wait_until_state");
  if (a.kind === "wait_until_state") {
    expect(a.state).toBe("MAIN");
    expect(a.maxMs).toBe(30000);
  }
});

test("wait_until_state allows optional reason", () => {
  const a: CaseAction = { kind: "wait_until_state", state: "FREE_SPIN", reason: "wait for free spin trigger" };
  expect(a.kind).toBe("wait_until_state");
  if (a.kind === "wait_until_state") {
    expect(a.reason).toMatch(/free spin/);
  }
});

test("wait_until_network_idle action shape", () => {
  const a: CaseAction = { kind: "wait_until_network_idle", idleMs: 1500, maxMs: 15000 };
  expect(a.kind).toBe("wait_until_network_idle");
  if (a.kind === "wait_until_network_idle") {
    expect(a.idleMs).toBe(1500);
  }
});

test("wait_until_network_idle defaults work without idleMs/maxMs", () => {
  const a: CaseAction = { kind: "wait_until_network_idle" };
  expect(a.kind).toBe("wait_until_network_idle");
});

test("wait_until_pixel_stable with consecutiveStable", () => {
  const a: CaseAction = { kind: "wait_until_pixel_stable", consecutiveStable: 5, maxMs: 30000 };
  expect(a.kind).toBe("wait_until_pixel_stable");
  if (a.kind === "wait_until_pixel_stable") {
    expect(a.consecutiveStable).toBe(5);
  }
});

test("legacy wait_ms still in CaseAction union (backward compat)", () => {
  const a: CaseAction = { kind: "wait_ms", ms: 2500 };
  expect(a.kind).toBe("wait_ms");
});

test("CaseAction discriminated union — exhaustive kinds", () => {
  const allKinds: Array<CaseAction["kind"]> = [
    "click", "wait_ms", "spin", "set_bet_to_min", "set_bet_to_max",
    "dismiss", "reset",
    "wait_until_state", "wait_until_network_idle", "wait_until_pixel_stable",
  ];
  expect(allKinds.length).toBe(10);
});
