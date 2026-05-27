// INVARIANT — interrupt handler dispatch (Phase 8.4)
//
// HANDLER_REGISTRY maps ObservedState → handler function. Dispatch must:
//   - Return handler for known states (BIG_WIN, FREE_SPIN_TRIGGERED, etc.)
//   - Return null for states without handlers (so caller can choose action)
//   - Each handler function is a callable (no missing imports / typos)

import { test, expect } from "@playwright/test";
import {
  getHandler,
  HANDLER_REGISTRY,
} from "../../src/pipeline/step8-run-scenarios/interrupt-handlers/index.ts";
import type { ObservedState } from "../../src/pipeline/step8-run-scenarios/state-observer.ts";

test("getHandler('BIG_WIN_POPUP') returns a function", () => {
  const h = getHandler("BIG_WIN_POPUP");
  expect(typeof h).toBe("function");
});

test("getHandler('FREE_SPIN_TRIGGERED') returns a function", () => {
  const h = getHandler("FREE_SPIN_TRIGGERED");
  expect(typeof h).toBe("function");
});

test("getHandler for substate popups returns dismiss handler", () => {
  expect(typeof getHandler("PAYTABLE_POPUP")).toBe("function");
  expect(typeof getHandler("AUTOPLAY_POPUP")).toBe("function");
  expect(typeof getHandler("HISTORY_POPUP")).toBe("function");
  expect(typeof getHandler("SETTINGS_POPUP")).toBe("function");
  expect(typeof getHandler("BUY_FEATURE_POPUP")).toBe("function");
});

test("getHandler('UNKNOWN') returns null (caller decides)", () => {
  expect(getHandler("UNKNOWN")).toBe(null);
});

test("getHandler('MAIN') returns null (no handler needed for main)", () => {
  expect(getHandler("MAIN")).toBe(null);
});

test("getHandler('DISCONNECT_POPUP') returns null (MVP — not yet implemented)", () => {
  // Future: add reconnect handler. For now, no handler.
  expect(getHandler("DISCONNECT_POPUP")).toBe(null);
});

test("HANDLER_REGISTRY contains expected MVP handlers", () => {
  const expectedHandlers: ObservedState[] = [
    "BIG_WIN_POPUP",
    "FREE_SPIN_TRIGGERED",
    "PAYTABLE_POPUP",
    "AUTOPLAY_POPUP",
    "HISTORY_POPUP",
    "SETTINGS_POPUP",
    "BUY_FEATURE_POPUP",
  ];
  for (const state of expectedHandlers) {
    expect(HANDLER_REGISTRY[state]).toBeTruthy();
  }
});

test("Each handler has expected length (handler accepts ctx param)", () => {
  // Each handler is `(ctx) => Promise<HandlerOutcome>` → fn.length === 1
  for (const [state, handler] of Object.entries(HANDLER_REGISTRY)) {
    if (!handler) continue;
    expect(handler.length).toBe(1);
    expect(typeof handler).toBe("function");
    void state;
  }
});
