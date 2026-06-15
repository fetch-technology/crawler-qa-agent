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

test("returns 'quiet' when no spin events and gap reaches quietMs (idle-confirm: allowZeroSpins)", async () => {
  const clk = makeFakeClock();
  // Seed lastSpinAt = 0, fakeNow starts 0 → gap grows as we sleep.
  // Without allowZeroSpins a zero-spin wait runs to maxMs (guard against a
  // stale lastSpinResponseAt right after spin-triggering actions); idle-confirm
  // waits opt in via allowZeroSpins.
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 60000,
    allowZeroSpins: true,
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

test("FS-aware: does NOT exit 'quiet' while fsActive — waits until the FS chain ends", async () => {
  // 1 spin lands at t=100, then silence. Without FS-awareness this exits 'quiet'
  // at ~5s. fsActive stays true until t=20s (FS chain playing) → the wait must
  // defer the quiet exit past the celebration gap, then exit once the chain
  // clears. Guards #4 "AI stops before free spins end".
  const clk = makeFakeClock({ events: [{ atFakeMs: 100 }] });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 120000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
    fsActive: () => clk.now() < 20000, // FS chain active until 20s
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(20000); // did NOT cut off at 5s
});

test("FS-aware: fsActive never clears → 'timeout' at maxMs (no premature quiet)", async () => {
  const clk = makeFakeClock({ events: [{ atFakeMs: 100 }] });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 20000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
    fsActive: () => true,
  });
  expect(result.exitReason).toBe("timeout");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(20000);
});

test("no fsActive provided → unchanged quiet behavior (back-compat)", async () => {
  const clk = makeFakeClock({ events: [{ atFakeMs: 100 }] });
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
  expect(result.elapsedMs).toBeLessThan(8000);
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
    allowZeroSpins: true,
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
    allowZeroSpins: true,
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

test("WITHOUT allowZeroSpins: zero-spin wait runs to maxMs (stale-timestamp guard)", async () => {
  // A wait placed right after spin-triggering actions must NOT exit on a
  // stale lastSpinResponseAt before at least one new spin lands.
  const clk = makeFakeClock();
  const result = await waitUntilNoSpinResponse({
    quietMs: 1000,
    maxMs: 5000,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("timeout");
  expect(result.spinsCapturedDuringWait).toBe(0);
});

// COUNT-AWARE autoplay batch (2026-06-16) — vs10hottuna regression.
// A batch of N must NOT be declared "done" during a mid-round pause > quietMs
// (win celebration / slow autoplay cadence). Otherwise the wait returns at
// spin #4, then stop_autoplay_if_running observes the resuming spins and clicks
// the autoplay button — killing the batch (log: "1 stop click(s)"). minSpins
// gates the quiet exit until the target is captured, with a hardQuietMs escape
// hatch for genuine early stops.

test("count-aware: a mid-batch pause > quietMs does NOT end the wait before minSpins", async () => {
  // 4 spins, then a 6s pause (> quietMs 5000, < hardQuiet 15000), then 6 more.
  const events = [
    { atFakeMs: 1000 }, { atFakeMs: 2000 }, { atFakeMs: 3000 }, { atFakeMs: 4000 },
    // 6s gap here — OLD behavior would exit "quiet" at 4 captured.
    { atFakeMs: 10000 }, { atFakeMs: 11000 }, { atFakeMs: 12000 },
    { atFakeMs: 13000 }, { atFakeMs: 14000 }, { atFakeMs: 15000 },
  ];
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 300000,
    minSpins: 10,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.spinsCapturedDuringWait).toBe(10); // full batch, NOT truncated at 4
});

test("count-aware: exits 'quiet' once minSpins captured + quietMs of silence", async () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ atFakeMs: (i + 1) * 500 }));
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 300000,
    minSpins: 10,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.spinsCapturedDuringWait).toBe(10);
});

test("count-aware: genuine early stop (target never reached) exits at hardQuietMs, no hang to maxMs", async () => {
  // Only 4 spins ever arrive (autoplay stopped early game-side). Must conclude
  // at hardQuiet (default 15000), NOT run to maxMs.
  const events = [{ atFakeMs: 1000 }, { atFakeMs: 2000 }, { atFakeMs: 3000 }, { atFakeMs: 4000 }];
  const clk = makeFakeClock({ events });
  const result = await waitUntilNoSpinResponse({
    quietMs: 5000,
    maxMs: 300000,
    minSpins: 10,
    lastSpinResponseAt: clk.lastSpinResponseAt,
    spinResponseCount: clk.spinResponseCount,
    sleep: clk.sleep,
    now: clk.now,
  });
  expect(result.exitReason).toBe("quiet");
  expect(result.spinsCapturedDuringWait).toBe(4);
  expect(result.elapsedMs).toBeLessThan(300000);      // did NOT hang to maxMs
  expect(result.lastGapMs).toBeGreaterThanOrEqual(15000); // ended via hardQuiet
});
