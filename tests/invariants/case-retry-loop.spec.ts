// INVARIANT — per-case retry loop (Gap B)
//
// runWithRetry wraps executeFn callback. Tests:
//   - PASS_HIGH on first attempt → no retries
//   - INCONCLUSIVE → retries until PASS or maxRetries
//   - FAIL_HIGH → no retries (definitive)
//   - Custom retryWhen honored
//   - maxRetries cap enforced

import { test, expect } from "@playwright/test";
import { runWithRetry, DEFAULT_RETRY_OUTCOMES, DEFAULT_MAX_RETRIES } from "../../src/pipeline/step8-run-scenarios/case-retry-loop.ts";
import type { CaseResult } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

function fakeResult(outcome: string, status: "pass" | "fail" | "skip" = "fail"): CaseResult {
  return {
    caseId: "c1", name: "test", category: "base_game", severity: "major",
    status, actionsExecuted: 1, assertions: [], spin: null,
    durationMs: 100, outcome: outcome as never,
  };
}

test("PASS_HIGH on first attempt → no retries", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("PASS_HIGH", "pass");
  });
  expect(loop.attempts).toBe(1);
  expect(calls).toBe(1);
  expect(loop.finalResult.outcome).toBe("PASS_HIGH");
});

test("FAIL_HIGH on first attempt → no retries (definitive failure)", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("FAIL_HIGH", "fail");
  });
  expect(loop.attempts).toBe(1);
});

test("INCONCLUSIVE → retries up to maxRetries+1 attempts", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("INCONCLUSIVE", "skip");
  }, { maxRetries: 2 });
  expect(loop.attempts).toBe(3); // 1 initial + 2 retries
  expect(calls).toBe(3);
});

test("INCONCLUSIVE then PASS_HIGH → stops at PASS attempt", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return calls < 3
      ? fakeResult("INCONCLUSIVE", "skip")
      : fakeResult("PASS_HIGH", "pass");
  }, { maxRetries: 5 });
  expect(loop.attempts).toBe(3);
  expect(loop.finalResult.outcome).toBe("PASS_HIGH");
});

test("default retryWhen includes INCONCLUSIVE, FAIL_LOW, FLAKY", () => {
  expect(DEFAULT_RETRY_OUTCOMES).toContain("INCONCLUSIVE");
  expect(DEFAULT_RETRY_OUTCOMES).toContain("FAIL_LOW");
  expect(DEFAULT_RETRY_OUTCOMES).toContain("FLAKY");
});

test("default retryWhen does NOT include PASS_HIGH or FAIL_HIGH", () => {
  expect(DEFAULT_RETRY_OUTCOMES).not.toContain("PASS_HIGH");
  expect(DEFAULT_RETRY_OUTCOMES).not.toContain("PASS_LOW");
  expect(DEFAULT_RETRY_OUTCOMES).not.toContain("FAIL_HIGH");
});

test("FAIL_LOW → retried by default", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("FAIL_LOW", "fail");
  }, { maxRetries: 1 });
  expect(loop.attempts).toBe(2);
});

test("FLAKY → retried by default", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("FLAKY", "pass");
  }, { maxRetries: 1 });
  expect(loop.attempts).toBe(2);
});

test("custom retryWhen overrides default", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("FAIL_HIGH", "fail");
  }, { maxRetries: 2, retryWhen: ["FAIL_HIGH"] });
  expect(loop.attempts).toBe(3);
});

test("maxRetries=0 → only 1 attempt total", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("INCONCLUSIVE", "skip");
  }, { maxRetries: 0 });
  expect(loop.attempts).toBe(1);
});

test("attemptHistory records each iteration", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return calls < 3
      ? fakeResult("INCONCLUSIVE", "skip")
      : fakeResult("PASS_HIGH", "pass");
  }, { maxRetries: 5 });
  expect(loop.attemptHistory.length).toBe(3);
  expect(loop.attemptHistory[0]!.attempt).toBe(1);
  expect(loop.attemptHistory[0]!.outcome).toBe("INCONCLUSIVE");
  expect(loop.attemptHistory[2]!.outcome).toBe("PASS_HIGH");
});

test("DEFAULT_MAX_RETRIES is sensible (≥1, ≤5)", () => {
  expect(DEFAULT_MAX_RETRIES).toBeGreaterThanOrEqual(1);
  expect(DEFAULT_MAX_RETRIES).toBeLessThanOrEqual(5);
});

test("maxRetries clamped to [0, 10]", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("INCONCLUSIVE", "skip");
  }, { maxRetries: 999 });
  // 1 initial + 10 retries = 11 max
  expect(loop.attempts).toBeLessThanOrEqual(11);
});

test("result without outcome → not retried (legacy compat)", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    const r = fakeResult("INCONCLUSIVE", "skip");
    delete r.outcome;
    return r;
  }, { maxRetries: 3 });
  expect(loop.attempts).toBe(1);
});

// === retryOnFailStatus — "re-run on fail, record fail only if persists" ===

test("retryOnFailStatus: fail → fail → fail (maxRetries 2) → 3 attempts, final fail", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("FAIL_HIGH", "fail");
  }, { maxRetries: 2, retryOnFailStatus: true });
  expect(loop.attempts).toBe(3); // 1 initial + 2 retries
  expect(calls).toBe(3);
  expect(loop.finalResult.status).toBe("fail");
});

test("retryOnFailStatus: fail → pass → recorded as PASS (2 attempts)", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return calls === 1 ? fakeResult("FAIL_HIGH", "fail") : fakeResult("PASS_HIGH", "pass");
  }, { maxRetries: 2, retryOnFailStatus: true });
  expect(loop.attempts).toBe(2);
  expect(loop.finalResult.status).toBe("pass");
  expect(loop.attemptHistory[0]!.status).toBe("fail");
  expect(loop.attemptHistory[1]!.status).toBe("pass");
});

test("retryOnFailStatus: pass on first → no retry", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return fakeResult("PASS_HIGH", "pass");
  }, { maxRetries: 2, retryOnFailStatus: true });
  expect(loop.attempts).toBe(1);
  expect(calls).toBe(1);
});

test("retryOnFailStatus retries FAIL_HIGH (which default outcome-retry does NOT)", async () => {
  // Without retryOnFailStatus, FAIL_HIGH is definitive (no retry).
  let a = 0;
  const noRetry = await runWithRetry(async () => { a++; return fakeResult("FAIL_HIGH", "fail"); }, { maxRetries: 2 });
  expect(noRetry.attempts).toBe(1);
  // With retryOnFailStatus, it retries.
  let b = 0;
  const withRetry = await runWithRetry(async () => { b++; return fakeResult("FAIL_HIGH", "fail"); }, { maxRetries: 2, retryOnFailStatus: true });
  expect(withRetry.attempts).toBe(3);
});

test("retryOnFailStatus + maxRetries 0 → single attempt (no retry)", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => { calls++; return fakeResult("FAIL_HIGH", "fail"); }, { maxRetries: 0, retryOnFailStatus: true });
  expect(loop.attempts).toBe(1);
  expect(calls).toBe(1);
});

test("retryOnFailStatus: skip status is NOT retried (only 'fail')", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => { calls++; return fakeResult("INCONCLUSIVE", "skip"); }, { maxRetries: 2, retryOnFailStatus: true, retryWhen: [] });
  expect(loop.attempts).toBe(1); // skip ≠ fail → no status-retry; retryWhen empty → no outcome-retry
});

// === DEFAULT previewCase policy (2026-05-27): "only a hard fail retries, at
// most once". Mirrors { maxRetries: 1, retryWhen: [], retryOnFailStatus: true }
// set in manual-session.ts. Locks the user-requested behavior. ===
const DEFAULT_POLICY = { maxRetries: 1, retryWhen: [], retryOnFailStatus: true } as const;

test("DEFAULT: fail → fail → 2 attempts max (one retry only), records fail", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => { calls++; return fakeResult("FAIL_HIGH", "fail"); }, DEFAULT_POLICY);
  expect(loop.attempts).toBe(2);
  expect(calls).toBe(2);
  expect(loop.finalResult.status).toBe("fail");
});

test("DEFAULT: fail → pass → recorded as PASS (2 attempts)", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => {
    calls++;
    return calls === 1 ? fakeResult("FAIL_HIGH", "fail") : fakeResult("PASS_HIGH", "pass");
  }, DEFAULT_POLICY);
  expect(loop.attempts).toBe(2);
  expect(loop.finalResult.status).toBe("pass");
});

test("DEFAULT: non-fail outcomes (FLAKY / INCONCLUSIVE / FAIL_LOW) are NOT retried", async () => {
  for (const outcome of ["FLAKY", "INCONCLUSIVE", "FAIL_LOW"]) {
    let calls = 0;
    // status not "fail" → must NOT retry under the new default (retryWhen empty).
    const loop = await runWithRetry(async () => { calls++; return fakeResult(outcome, "skip"); }, DEFAULT_POLICY);
    expect(loop.attempts).toBe(1);
    expect(calls).toBe(1);
  }
});

test("DEFAULT: pass on first → no retry", async () => {
  let calls = 0;
  const loop = await runWithRetry(async () => { calls++; return fakeResult("PASS_HIGH", "pass"); }, DEFAULT_POLICY);
  expect(loop.attempts).toBe(1);
});
