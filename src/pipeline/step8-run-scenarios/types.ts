import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";

export type SpinMode = "ui" | "api";

export type MassiveSpinOptions = {
  count: number;
  mode?: SpinMode;
  concurrency?: number;
  throttleMs?: number;
};

export type MassiveSpinResult = {
  mode: SpinMode;
  attempted: number;
  succeeded: number;
  spins: NormalizedSpinResult[];
  durationMs: number;
  /** Set when the runner deliberately skipped — e.g. no spin capture exists
   *  yet for the game and api-mode can't seed templates. Caller can surface
   *  this to QA so the run summary doesn't look like a silent zero-RTP. */
  skipReason?: string;
};
