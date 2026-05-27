// Preflight validator — runs ExecutionStrategy.field_validation +
// preflight_checks against captured spin samples. Reuses legacy
// `runExecutionPreflight` (src/ai/execution-preflight.ts) verbatim — that code
// is deterministic, well-tested, and not in the runtime AI path.
//
// Purpose: fail-fast on bad input. Catches:
//   - wallet snapshot mistaken as spin response (bet=0 across all samples)
//   - stale samples (no variance across spins)
//   - schema drift (required field missing)
//
// Output persisted to fixtures/registry/<slug>/preflight.json.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  runExecutionPreflight,
  formatPreflightResult,
  type PreflightResult,
} from "../../ai/execution-preflight.js";
import type { ExecutionStrategy } from "../../ai/authoring.js";
import { dirForGame } from "../registry/paths.js";
import type { NormalizedSpinResult } from "./normalized.js";

export async function runPreflight(
  gameSlug: string,
  strategy: ExecutionStrategy,
  spins: NormalizedSpinResult[],
): Promise<PreflightResult> {
  // Map normalized spins → legacy "sample" shape (the validator expects raw
  // field names; our normalized.raw still has them).
  const samples = spins.map((s) => {
    const base: Record<string, unknown> = {
      betAmount: s.bet,
      winAmount: s.win,
      startingBalance: s.balanceBefore,
      endingBalance: s.balanceAfter,
      balance: s.balanceAfter,
      roundId: s.roundId,
      matrix: s.reels.map((reel) => reel.join("")).join(""),
      isFreeSpin: s.isFreeSpin,
    };
    // Mix in raw so provider-specific fields are reachable too.
    return { ...s.raw, ...base };
  });

  const result = runExecutionPreflight(strategy, samples);

  const dir = dirForGame(gameSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "preflight.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );

  return result;
}

export { formatPreflightResult };
export type { PreflightResult };
