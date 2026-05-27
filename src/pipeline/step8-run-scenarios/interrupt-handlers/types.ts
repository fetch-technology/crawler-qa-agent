// Interrupt handler types (Phase 8.4).
//
// When the adaptive runner observes a state that is not the expected
// terminal state but IS in `allowedInterruptions`, it dispatches to a
// matching handler. Handlers may:
//   - Acknowledge & dismiss popups
//   - Play through free-spin / bonus chains until back to MAIN
//   - Reload on disconnect
//
// Handlers return an outcome marker that the runner combines into the
// case's final result + timeline.

import type { Page } from "playwright";
import type { NormalizedSpinResult } from "../../step6-build-model/normalized.js";
import type { UiRegistry } from "../../registry/types.js";
import type { ObservedState } from "../state-observer.js";

export type HandlerContext = {
  page: Page;
  uiMap: UiRegistry;
  gameSlug?: string;
  /** Latest captured spin used by handlers that verify chain completion. */
  lastSpin: NormalizedSpinResult | null;
  /** Resolved timing config (so handlers don't hardcode timeouts). */
  timing: {
    dismissPreWaitMs: number;
    dismissInterClickMs: number;
    hardCapMs: number;
  };
};

export type HandlerOutcome = {
  /** Handler name (for timeline log). */
  handler: string;
  /** Whether handler completed cleanly. */
  ok: boolean;
  /** Optional summary (e.g., "free spin chain 10 → 5000 win"). */
  summary?: string;
  /** Optional artifact paths captured during handling. */
  artifacts?: { screenshots?: string[] };
  /** State after handler — runner uses this to decide if main scenario can resume. */
  finalState: ObservedState;
  durationMs: number;
};

/** Each handler implementation must match this signature. */
export type InterruptHandler = (
  ctx: HandlerContext,
) => Promise<HandlerOutcome>;
