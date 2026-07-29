// INVARIANT — auto-onboard scheduler selection logic.
//
// selectNextAutoOnboard is the PURE core of the scheduler tick: given the
// marked-game queue + an isActive predicate + the attempts cap, it returns the
// next game to auto-onboard (or null), deterministically. This isolates the
// selection rules from disk/browser so they can be exhaustively tested.
//
// Rules under test: priority asc (tie → slug); skip done/running; skip
// attempts-exhausted; skip currently-active; skip still-ineligible "skipped"
// games (but re-pick them once eligibility flips ok).

import { test, expect } from "@playwright/test";
import { selectNextAutoOnboard, MAX_SCHED_ATTEMPTS, type SchedulableGame } from "../../src/pipeline/server/session-pool.ts";

function game(slug: string, over: Partial<SchedulableGame> = {}): SchedulableGame {
  return {
    gameSlug: slug,
    ready: true,
    priority: 5,
    schedStatus: "queued",
    schedAttempts: 0,
    eligibility: { ok: true },
    ...over,
  };
}

const noneActive = () => false;

test("picks the lowest priority number first", () => {
  const q = [game("b", { priority: 3 }), game("a", { priority: 1 }), game("c", { priority: 2 })];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("a");
});

test("breaks priority ties by slug (deterministic)", () => {
  const q = [game("z", { priority: 2 }), game("m", { priority: 2 }), game("a", { priority: 2 })];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("a");
});

test("skips done and running games", () => {
  const q = [
    game("done1", { priority: 1, schedStatus: "done" }),
    game("run1", { priority: 2, schedStatus: "running" }),
    game("go", { priority: 3, schedStatus: "queued" }),
  ];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("go");
});

test("skips games that exhausted the attempts cap", () => {
  const q = [
    game("exhausted", { priority: 1, schedStatus: "failed", schedAttempts: MAX_SCHED_ATTEMPTS }),
    game("fresh", { priority: 2, schedStatus: "failed", schedAttempts: MAX_SCHED_ATTEMPTS - 1 }),
  ];
  const next = selectNextAutoOnboard(q, noneActive, MAX_SCHED_ATTEMPTS);
  expect(next?.gameSlug).toBe("fresh");
});

test("skips games already active (running a batch manually)", () => {
  const q = [game("busy", { priority: 1 }), game("free", { priority: 2 })];
  const next = selectNextAutoOnboard(q, (slug) => slug === "busy", 2);
  expect(next?.gameSlug).toBe("free");
});

test("does NOT re-pick a skipped game while it is still ineligible", () => {
  const q = [game("blocked", { priority: 1, schedStatus: "skipped", eligibility: { ok: false, reason: "missing OCR" } })];
  expect(selectNextAutoOnboard(q, noneActive, 2)).toBeNull();
});

test("DOES re-pick a skipped game once eligibility flips ok", () => {
  const q = [game("recovered", { priority: 1, schedStatus: "skipped", eligibility: { ok: true } })];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("recovered");
});

test("returns an ineligible queued game (caller marks it skipped, not the selector)", () => {
  // A freshly-queued but ineligible game IS returned — the tick records the
  // skip reason. Only an ALREADY-skipped+ineligible game is filtered out.
  const q = [game("newIneligible", { priority: 1, schedStatus: "queued", eligibility: { ok: false, reason: "no OCR" } })];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("newIneligible");
});

test("returns null when nothing is runnable", () => {
  const q = [
    game("d", { schedStatus: "done" }),
    game("r", { schedStatus: "running" }),
  ];
  expect(selectNextAutoOnboard(q, noneActive, 2)).toBeNull();
  expect(selectNextAutoOnboard([], noneActive, 2)).toBeNull();
});

test("ignores games not marked ready", () => {
  const q = [game("notready", { priority: 1, ready: false }), game("ready", { priority: 2 })];
  expect(selectNextAutoOnboard(q, noneActive, 2)?.gameSlug).toBe("ready");
});
