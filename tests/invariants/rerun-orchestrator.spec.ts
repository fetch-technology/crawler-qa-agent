// INVARIANT — auto-rerun orchestrator (Phase 8 item 3)
//
// Tests the loop's decision logic with mock callbacks. No real network,
// no AI calls — fully deterministic.

import { test, expect } from "@playwright/test";
import { rerunWithPatches, MAX_RERUN_ATTEMPTS } from "../../src/pipeline/step13-patch-apply/rerun-orchestrator.ts";
import type { SuggestedPatch, ReviewResult } from "../../src/pipeline/step12-failure-review/index.ts";

function fakePatch(file = "game-mechanics.json", diff: Record<string, unknown> = { betMultiplier: 20 }): SuggestedPatch {
  return { file, operation: "merge", diff };
}

function fakeReview(confidence = 0.9, patch?: SuggestedPatch): ReviewResult {
  return {
    classification: "wrong_bet_formula",
    confidence,
    reason: "test",
    suggestedPatch: patch ?? fakePatch(),
    meta: { durationMs: 100 },
  };
}

test("loop returns pass when first rerun passes", async () => {
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch(),
    initialReview: fakeReview(0.9),
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "pass", outcome: "PASS_HIGH" } }),
      reReview: async () => ({ ok: true, review: fakeReview(0.9) }),
    },
  });
  expect(result.status).toBe("pass");
  expect(result.attemptsUsed).toBe(1);
  expect(result.patchesApplied).toBe(1);
});

test("loop continues + applies new patch when rerun still fails", async () => {
  let attempt = 0;
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch("a.json", { x: 1 }),
    initialReview: fakeReview(0.9, fakePatch("a.json", { x: 1 })),
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => {
        attempt++;
        return attempt < 2
          ? { ok: true, result: { status: "fail", outcome: "FAIL_HIGH" } }
          : { ok: true, result: { status: "pass", outcome: "PASS_HIGH" } };
      },
      reReview: async () => ({ ok: true, review: fakeReview(0.9, fakePatch("b.json", { y: 2 })) }),
    },
  });
  expect(result.status).toBe("pass");
  expect(result.attemptsUsed).toBe(2);
  expect(result.patchesApplied).toBe(2);
});

test("escalates after MAX_RERUN_ATTEMPTS hit (each rerun produces new patch)", async () => {
  // Each iteration produces a DISTINCT patch (no loop detection trigger).
  // n starts at 1 (initialPatch) then 2, 3, … per re-review.
  let n = 1;
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch("a.json", { x: 1 }),
    initialReview: fakeReview(0.9, fakePatch("a.json", { x: 1 })),
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "fail", outcome: "FAIL_HIGH" } }),
      reReview: async () => {
        n++;
        return { ok: true, review: fakeReview(0.9, fakePatch("a.json", { x: n })) };
      },
    },
  });
  expect(result.status).toBe("escalated");
  expect(result.attemptsUsed).toBe(MAX_RERUN_ATTEMPTS);
});

test("loop detection: same patch suggested twice → escalate immediately", async () => {
  const samePatch = fakePatch("file.json", { z: 99 });
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: samePatch,
    initialReview: fakeReview(0.9, samePatch),
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "fail", outcome: "FAIL_HIGH" } }),
      reReview: async () => ({ ok: true, review: fakeReview(0.9, samePatch) }), // same patch back
    },
  });
  expect(result.status).toBe("escalated");
  expect(result.log.some((l) => /loop detected/.test(l))).toBe(true);
});

test("low confidence patch → escalates without applying", async () => {
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch(),
    initialReview: fakeReview(0.5),  // below 0.85 default
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "pass", outcome: "PASS_HIGH" } }),
      reReview: async () => ({ ok: true, review: fakeReview(0.5) }),
    },
  });
  expect(result.status).toBe("escalated");
  expect(result.patchesApplied).toBe(0);
});

test("custom autoApplyThreshold honored", async () => {
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch(),
    initialReview: fakeReview(0.6),
    autoApplyThreshold: 0.5,
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "pass", outcome: "PASS_HIGH" } }),
      reReview: async () => ({ ok: true, review: fakeReview(0.6) }),
    },
  });
  expect(result.status).toBe("pass");
});

test("applyPatch failure escalates loop", async () => {
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch(),
    initialReview: fakeReview(0.9),
    callbacks: {
      applyPatch: async () => ({ ok: false, reason: "validation failed" }),
      rerunCase: async () => ({ ok: true, result: { status: "pass", outcome: "PASS_HIGH" } }),
      reReview: async () => ({ ok: true, review: fakeReview(0.9) }),
    },
  });
  expect(result.status).toBe("escalated");
  expect(result.log.some((l) => /apply failed/.test(l))).toBe(true);
});

test("re-review without new patch → escalates", async () => {
  const result = await rerunWithPatches({
    caseId: "c1", gameSlug: "test",
    initialPatch: fakePatch(),
    initialReview: fakeReview(0.9),
    callbacks: {
      applyPatch: async () => ({ ok: true }),
      rerunCase: async () => ({ ok: true, result: { status: "fail", outcome: "FAIL_HIGH" } }),
      reReview: async () => ({ ok: true, review: { ...fakeReview(0.9), suggestedPatch: undefined } }),
    },
  });
  expect(result.status).toBe("escalated");
  expect(result.log.some((l) => /no patch to apply/.test(l))).toBe(true);
});
