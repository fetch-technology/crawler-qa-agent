// Shared types for the pipeline/phases/ family — Session 1 of the dashboard
// ↔ CLI unification refactor.
//
// Each phase is a pure async function (page, gameSlug, opts) → result. No
// classes, no shared state — phases compose by passing their outputs as the
// next phase's inputs (via context object or explicit args). Both
// dashboard's ManualSessionManager and the CLI cold-start orchestrator
// import + chain these — eliminating the historical duplication where the
// same step (deep-extract, catalog gen, …) had a different implementation
// in each caller.

import type { Page } from "playwright";
import type { UiRegistry } from "../registry/types.js";

/** Shared input every phase needs. Callers fill in what they have; phases
 *  null-guard fields they don't need. The intent is small + stable so we
 *  can add new phases without changing every signature. */
export type PhaseContext = {
  /** The active Playwright page. Required for browser-bound phases
   *  (discover, deep-extract, calibrate, …); pure I/O phases (catalog gen,
   *  translate, persist-network) ignore it but it's still passed for
   *  consistency — they accept `null`. */
  page: Page | null;
  /** Game slug (folder name under fixtures/registry/). Always required. */
  gameSlug: string;
  /** UI registry snapshot. Phases that need elements (deep-extract, etc.)
   *  read this; phases that don't ignore. */
  uiMap?: UiRegistry | null;
};

/** Common result envelope. Every phase returns `{ ok, reason?, ... }` so
 *  callers can fan out / branch uniformly. Phase-specific fields go on the
 *  individual result types extending this. */
export type PhaseResult = {
  ok: boolean;
  reason?: string;
  /** Optional human-readable note (vd "skipped — already on disk"). */
  note?: string;
  /** Time taken to run (ms). Used by frontend to show per-phase timings. */
  durationMs?: number;
};
