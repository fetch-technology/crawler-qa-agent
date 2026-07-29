// INVARIANT — concurrent-batch cap + FIFO batch queue.
//
// Only MAX_ACTIVE_BATCHES games may run one of the two gated batches
// (run-all-testcases / auto-onboard) at once; further batch triggers queue FIFO
// and are promoted when a running batch finishes. The queue must NOT start a
// batch while full, must preserve order + positions, must count one game as at
// most one slot, and must respect capacity on promotion.
//
// Separate from the start-queue (session-queue.spec.ts) — this caps token-heavy
// batches, not browser slots. Uses lightweight fakes; session-pool only calls
// occupiesBatchSlot()/setBatchQueued() on them.

import { test, expect } from "@playwright/test";
import {
  _resetForTest,
  set as setSession,
  admitOrQueueBatch,
  promoteQueuedBatch,
  dequeueBatch,
  batchQueueLength,
  countActiveBatches,
  maxActiveBatches,
  activeBatchSlugs,
} from "../../src/pipeline/server/session-pool.ts";

function fakeManager(batchActive = true) {
  const m: any = {
    _batchActive: batchActive,
    _batchQueuedPos: null,
    _batchQueuedTotal: 0,
    occupiesBatchSlot() { return this._batchActive; },
    setBatchQueued(pos: number | null, total: number) { this._batchQueuedPos = pos; this._batchQueuedTotal = total; },
  };
  return m;
}

/** Fill every batch slot with a distinct running game. */
function fillBatchSlots(): any[] {
  const occupants: any[] = [];
  for (let i = 0; i < maxActiveBatches(); i++) {
    const m = fakeManager(true);
    occupants.push(m);
    setSession(`b${i}`, m);
  }
  return occupants;
}

test.beforeEach(() => _resetForTest());

test("default cap is 2 (QA_MAX_ACTIVE_BATCHES)", () => {
  // Guards the product requirement: max 2 games run tests/onboard concurrently.
  expect(maxActiveBatches()).toBe(2);
});

test("admits immediately when under the cap", () => {
  let started = false;
  const r = admitOrQueueBatch(fakeManager(false), "run-all", () => { started = true; });
  expect(r.admitted).toBe(true);
  expect(started).toBe(true);
  expect(batchQueueLength()).toBe(0);
});

test("queues (does not start) once the cap is reached", () => {
  fillBatchSlots();
  expect(countActiveBatches()).toBe(maxActiveBatches());
  let started = false;
  const r = admitOrQueueBatch(fakeManager(false), "auto-onboard", () => { started = true; });
  expect(r.admitted).toBe(false);
  expect(r.position).toBe(1);
  expect(started).toBe(false);
  expect(batchQueueLength()).toBe(1);
});

test("a game already holding a batch slot is admitted immediately (one game = one slot, no self-block)", () => {
  // Fill both slots — one of them is game A, running auto-onboard.
  const a = fakeManager(true);
  setSession("A", a);
  setSession("B", fakeManager(true));
  expect(countActiveBatches()).toBe(2);
  // A triggers run-all while its onboard is active → same slot, admit now.
  let started = false;
  const r = admitOrQueueBatch(a, "run-all", () => { started = true; });
  expect(r.admitted).toBe(true);
  expect(started).toBe(true);
  expect(batchQueueLength()).toBe(0);
});

test("preserves FIFO positions across multiple queued batches", () => {
  fillBatchSlots();
  const a = fakeManager(false);
  const b = fakeManager(false);
  const ra = admitOrQueueBatch(a, "run-all", () => {});
  const rb = admitOrQueueBatch(b, "run-all", () => {});
  expect(ra.position).toBe(1);
  expect(rb.position).toBe(2);
  expect(a._batchQueuedPos).toBe(1);
  expect(b._batchQueuedPos).toBe(2);
  expect(a._batchQueuedTotal).toBe(2);
});

test("promote starts a queued batch only when a slot frees, respecting capacity", () => {
  const occupants = fillBatchSlots();
  let started = 0;
  // Mirror the route: start() flips the wrapper's batch marker SYNCHRONOUSLY
  // (mimics *InBackground setting *BatchActive) so capacity is counted.
  const q1 = fakeManager(false); setSession("q1", q1);
  const q2 = fakeManager(false); setSession("q2", q2);
  admitOrQueueBatch(q1, "run-all", () => { started++; q1._batchActive = true; });
  admitOrQueueBatch(q2, "auto-onboard", () => { started++; q2._batchActive = true; });

  promoteQueuedBatch();              // still full → nothing promoted
  expect(started).toBe(0);

  occupants[0]._batchActive = false; // free ONE slot
  promoteQueuedBatch();
  expect(started).toBe(1);           // only one promoted (capacity respected)
  expect(batchQueueLength()).toBe(1);
  expect(q1._batchQueuedPos).toBe(null); // promoted → cleared
  expect(q2._batchQueuedPos).toBe(1);    // re-numbered to head

  occupants[1]._batchActive = false; // free another
  promoteQueuedBatch();
  expect(started).toBe(2);
  expect(batchQueueLength()).toBe(0);
});

test("no over-admission when many batches are triggered in one synchronous tick", () => {
  // The over-admission hazard: the real InProgress flags flip only after awaits,
  // so admission must key on the synchronously-flipped batch marker. Here two
  // slots are free; four batches arrive in the same tick. Exactly two must
  // admit, the rest queue — even though the "started" thunks are async-shaped.
  const a = fakeManager(false); setSession("a", a);
  const b = fakeManager(false); setSession("b", b);
  const c = fakeManager(false); setSession("c", c);
  const d = fakeManager(false); setSession("d", d);
  const results = [a, b, c, d].map((m) =>
    admitOrQueueBatch(m, "run-all", () => { m._batchActive = true; }),
  );
  expect(results.filter((r) => r.admitted).length).toBe(2);
  expect(results.filter((r) => !r.admitted).length).toBe(2);
  expect(countActiveBatches()).toBe(2);
  expect(batchQueueLength()).toBe(2);
});

test("activeBatchSlugs reports which games hold slots", () => {
  const a = fakeManager(true); setSession("alpha", a);
  const b = fakeManager(true); setSession("beta", b);
  setSession("gamma", fakeManager(false));
  expect(activeBatchSlugs().sort()).toEqual(["alpha", "beta"]);
});

test("dequeue removes a still-waiting batch and renumbers", () => {
  fillBatchSlots();
  const q1 = fakeManager(false);
  const q2 = fakeManager(false);
  admitOrQueueBatch(q1, "run-all", () => {});
  admitOrQueueBatch(q2, "run-all", () => {});
  expect(batchQueueLength()).toBe(2);
  expect(dequeueBatch(q1)).toBe(true);
  expect(batchQueueLength()).toBe(1);
  expect(q1._batchQueuedPos).toBe(null);
  expect(q2._batchQueuedPos).toBe(1); // renumbered to head
  expect(dequeueBatch(fakeManager(false))).toBe(false); // not queued → no-op
});
