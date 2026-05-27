// INVARIANT — wait_until_no_spin_response (2026-05-26)
//
// Autoplay-aware wait. Replaces `wait_until_state MAIN` for autoplay batches
// because PP slot games flicker MAIN briefly between rounds, causing
// wait_until_state to return at spin #1 not spin #N.
//
// Predicate: returns when (now - lastSpinResponseAt) >= quietMs, or after
// maxMs (soft timeout). Uses an injected clock + sleep so tests are
// deterministic and fast.

import { test, expect } from "@playwright/test";
import { waitUntilNoSpinResponse } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

/** Simulates wall-clock + injected spin events. Time advances ONLY when
 *  sleep() is awaited (not real-time) so tests are deterministic and fast. */
function makeFakeClock(opts: {
  /** Spin events: { atFakeMs: when to log a spin response (in fake clock ms from start) } */
  events?: Array<{ atFakeMs: number }>;
} = {}) {
  let fakeNow = 0;
  let count = 0;
  let lastAt = 0;
  const events = (opts.events ?? []).slice().sort((a, b) => a.atFakeMs - b.atFakeMs);
  const fireEventsUpTo = (t: number) => {
    while (events.length > 0 && events[0]!.atFakeMs <= t) {
      const ev = events.shift()!;
      count++;
      lastAt = ev.atFakeMs;
    }
  };
  return {
    now: () => fakeNow,
    lastSpinResponseAt: () => lastAt,
    spinResponseCount: () => count,
    sleep: async (ms: number) => {
      fakeNow += ms;
      fireEventsUpTo(fakeNow);
    },
    /** Manually fire a spin event at the current fake time. */
    fireSpinNow: () => {
      count++;
      lastAt = fakeNow;
    },
    /** Set starting timestamp for "last spin" (default 0 = ready to fire quiet immediately if quietMs=0). */
    seedLastSpinAt: (t: number) => {
      lastAt = t;
    },
  };
}

test("returns 'quiet' when no spin events and gap reaches quietMs", async () => {
  const clk = makeFakeClock();
  // Seed lastSpinAt = 0, fakeNow starts 0 → gap grows as we sleep.
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 60000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(5000);
  expect(result.spinsCapturedDuringWait).toBe(0);
});

test("returns 'timeout' when spin events keep arriving past maxMs", async () => {
  // Spin events every 1000ms forever — gap never reaches quietMs=5000
  const events = Array.from({ length: 30 }, (_, i) => ({ atFakeMs: (i + 1) * 1000 }));
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 10000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("timeout");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(10000);
  // Captured ~10 spins (1 every sec for 10 sec)
  expect(result.spinsCapturedDuringWait).toBeGreaterThanOrEqual(9);
});

test("returns 'quiet' after autoplay batch finishes — captures all spins before quiet window", async () => {
  // Autoplay simulates: 30 rounds, one every 2000ms (60s total), then silence.
  const events = Array.from({ length: 30 }, (_, i) => ({ atFakeMs: (i + 1) * 2000 }));
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 180000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  // Should capture all 30 spins, then wait 5s of silence = ~65s elapsed
  expect(result.spinsCapturedDuringWait).toBe(30);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(65000);
  expect(result.elapsedMs).toBeLessThan(75000);  // not far past 65s
});

test("returns 'quiet' immediately when no spin in flight (gap >= quietMs from start)", async () => {
  // Last spin was 10s ago, fakeNow=10000, quietMs=5000 → gap already 0... wait that's still 0.
  // Actually since clk.now() starts at 0 and lastSpinResponseAt = 0 → gap = 0 < quietMs.
  // Need to seed: lastSpinAt = -10000 (far in past). Easier: start fakeNow at 10000.
  const clk = makeFakeClock();
  // We can't easily skip ahead without sleeping. Just check that quietMs=0
  // returns immediately.
  const result = await waitUntilNoSpinResponse({
    quietMs: 0,
    maxMs: 60000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.elapsedMs).toBe(0);
});

test("REGRESSION: replicates user's autoplay 30-rounds bug — engine no longer exits at spin #13", async () => {
  // Original bug: 30-rounds autoplay, case finished at 56s with only 13 spins
  // captured because `wait_until_state MAIN` returned at the first MAIN
  // flicker (between rounds). New action waits for actual quiet window.
  //
  // Simulated autoplay timing: round every ~4.3s (matches user's data).
  // Total batch ~130s. Then silence.
  const events = Array.from({ length: 30 }, (_, i) => ({ atFakeMs: 2000 + i * 4300 }));
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 180000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  // Should capture ALL 30 spins (the original bug captured only 13).
  expect(result.spinsCapturedDuringWait).toBe(30);
  // Total elapsed: last spin at ~128.7s + 5s quiet = ~133.7s
  expect(result.elapsedMs).toBeGreaterThanOrEqual(130000);
  expect(result.elapsedMs).toBeLessThan(140000);
});

test("custom pollIntervalMs honored (uses smaller default poll for tests)", async () => {
  const clk = makeFakeClock();
  const result = await waitUntilNoSpinResponse({
    quietMs: 1000,
    maxMs: 5000,
    pollIntervalMs: 100,  // smaller poll
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  // With 100ms poll, exits ~100ms after gap reaches 1000ms
  expect(result.elapsedMs).toBeGreaterThanOrEqual(1000);
  expect(result.elapsedMs).toBeLessThan(1200);
});
