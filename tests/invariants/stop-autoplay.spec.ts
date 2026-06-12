// INVARIANT — stop_autoplay_if_running (deterministic autoplay stop).
//
// Waiting out a long batch is unreliable (celebration pauses fake "quiet",
// 100-spin batches outlive wait caps) — so we OBSERVE spin activity and click
// autoButton (the STOP control while running) only when spins are actually
// arriving. Click cap prevents a stray click from OPENING the panel on an
// already-idle game; failure is loud.

import { test, expect } from "@playwright/test";
import { stopAutoplayIfRunning } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

/** Fake clock + spin feed. Spins arrive every `cadenceMs` while `running`;
 *  a stop click ends the feed after one trailing in-flight round. */
function harness(opts: { running: boolean; cadenceMs?: number; stopsAfterClicks?: number; fsUntilSpin?: number }) {
  const cadence = opts.cadenceMs ?? 5000;
  let now = 0;
  let count = 0;
  let running = opts.running;
  let clicks = 0;
  let escapes = 0;
  let lastSpinAt = 0;
  return {
    now: () => now,
    spinResponseCount: () => count,
    fsActive: () => (opts.fsUntilSpin != null ? count < opts.fsUntilSpin : false),
    clickAutoButton: async () => {
      clicks++;
      if (opts.stopsAfterClicks != null && clicks >= opts.stopsAfterClicks) running = false;
    },
    pressEscape: async () => { escapes++; },
    sleep: async (ms: number) => {
      const end = now + ms;
      while (running && lastSpinAt + cadence <= end) {
        lastSpinAt += cadence;
        count++;
      }
      now = end;
    },
    stats: () => ({ clicks, escapes, count }),
  };
}

test("already idle → stopped immediately, 0 clicks, no Escape", async () => {
  const h = harness({ running: false });
  const r = await stopAutoplayIfRunning({ ...h, observeMs: 9000, maxMs: 60000 });
  expect(r.stopped).toBe(true);
  expect(r.clicks).toBe(0);
  expect(h.stats().escapes).toBe(0);
});

test("running autoplay → 1 stop click → idle (Escape pressed to close accidental panel)", async () => {
  const h = harness({ running: true, stopsAfterClicks: 1 });
  const r = await stopAutoplayIfRunning({ ...h, observeMs: 9000, maxMs: 120000 });
  expect(r.stopped).toBe(true);
  expect(r.clicks).toBe(1);
  expect(h.stats().escapes).toBe(1);
});

test("FS chain active → NO clicks while it plays out, stop click only after", async () => {
  // FS until 4 spins captured, then the (still running) batch is stoppable.
  const h = harness({ running: true, stopsAfterClicks: 1, fsUntilSpin: 4 });
  const r = await stopAutoplayIfRunning({ ...h, observeMs: 9000, maxMs: 300000 });
  expect(r.stopped).toBe(true);
  expect(r.clicks).toBe(1); // none during FS
});

test("stop clicks have no effect → FAIL LOUD after click cap (never hammers the button)", async () => {
  const h = harness({ running: true }); // never stops
  const r = await stopAutoplayIfRunning({ ...h, observeMs: 9000, maxMs: 120000 });
  expect(r.stopped).toBe(false);
  expect(r.clicks).toBe(2); // capped
  expect(r.reason).toMatch(/still spinning/);
});

test("maxClicks=0 (no autoButton) → observe-only, reports not-stopped without clicking", async () => {
  const h = harness({ running: true });
  const r = await stopAutoplayIfRunning({ ...h, observeMs: 9000, maxMs: 30000, maxClicks: 0 });
  expect(r.stopped).toBe(false);
  expect(r.clicks).toBe(0);
});
