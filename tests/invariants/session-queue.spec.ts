// INVARIANT — active-session cap + FIFO start queue (Mac mini 7-core ceiling).
//
// Only MAX_ACTIVE games may hold a slot; further starts queue FIFO and are
// promoted when a slot frees. The queue must NOT start a game while full, must
// preserve order + positions, and must respect capacity on promotion.
//
// Uses lightweight fakes for ManualSessionManager (the real one needs a
// browser) — session-pool only calls occupiesSlot()/setQueued()/stop() on them.

import { test, expect } from "@playwright/test";
import {
  _resetForTest,
  set as setSession,
  admitOrQueueStart,
  promoteQueued,
  dequeueStart,
  queueLength,
  countOccupiedSlots,
  maxActiveSessions,
} from "../../src/pipeline/server/session-pool.ts";

function fakeManager(occupied = true) {
  const m: any = {
    _occupied: occupied,
    _queuedPos: null,
    _queuedTotal: 0,
    occupiesSlot() { return this._occupied; },
    setQueued(pos: number | null, total: number) { this._queuedPos = pos; this._queuedTotal = total; },
    reapableIdleMs() { return -1; },
    async stop() { this._occupied = false; },
  };
  return m;
}

function fillSlots(): any[] {
  const occupants: any[] = [];
  for (let i = 0; i < maxActiveSessions(); i++) {
    const m = fakeManager(true);
    occupants.push(m);
    setSession(`g${i}`, m);
  }
  return occupants;
}

test.beforeEach(() => _resetForTest());

test("admits immediately when under the cap", () => {
  let started = false;
  const r = admitOrQueueStart(fakeManager(false), () => { started = true; });
  expect(r.admitted).toBe(true);
  expect(started).toBe(true);
  expect(queueLength()).toBe(0);
});

test("queues (does not start) once the cap is reached", () => {
  fillSlots();
  expect(countOccupiedSlots()).toBe(maxActiveSessions());
  let started = false;
  const r = admitOrQueueStart(fakeManager(false), () => { started = true; });
  expect(r.admitted).toBe(false);
  expect(r.position).toBe(1);
  expect(started).toBe(false);
  expect(queueLength()).toBe(1);
});

test("preserves FIFO positions across multiple queued starts", () => {
  fillSlots();
  const a = fakeManager(false);
  const b = fakeManager(false);
  const ra = admitOrQueueStart(a, () => {});
  const rb = admitOrQueueStart(b, () => {});
  expect(ra.position).toBe(1);
  expect(rb.position).toBe(2);
  expect(a._queuedPos).toBe(1);
  expect(b._queuedPos).toBe(2);
  expect(a._queuedTotal).toBe(2);
});

test("promote starts a queued game only when a slot frees, respecting capacity", () => {
  const occupants = fillSlots();
  let started = 0;
  // Queue two. Mirror the route: the session is registered in the pool (under
  // a temp slug) BEFORE queuing, and start() flips it occupied (mimics
  // startInBackground setting startInProgress) so capacity is counted.
  const q1 = fakeManager(false); setSession("q1", q1);
  const q2 = fakeManager(false); setSession("q2", q2);
  admitOrQueueStart(q1, () => { started++; q1._occupied = true; });
  admitOrQueueStart(q2, () => { started++; q2._occupied = true; });

  promoteQueued();             // still full → nothing promoted
  expect(started).toBe(0);

  occupants[0]._occupied = false; // free ONE slot
  promoteQueued();
  expect(started).toBe(1);     // only one promoted (capacity respected)
  expect(queueLength()).toBe(1);
  expect(q1._queuedPos).toBe(null); // promoted → cleared
  expect(q2._queuedPos).toBe(1);    // re-numbered to head

  occupants[1]._occupied = false; // free another
  promoteQueued();
  expect(started).toBe(2);
  expect(queueLength()).toBe(0);
});

test("dequeue removes a still-waiting start", () => {
  fillSlots();
  const q = fakeManager(false);
  admitOrQueueStart(q, () => {});
  expect(queueLength()).toBe(1);
  expect(dequeueStart(q)).toBe(true);
  expect(queueLength()).toBe(0);
  expect(q._queuedPos).toBe(null);
});
