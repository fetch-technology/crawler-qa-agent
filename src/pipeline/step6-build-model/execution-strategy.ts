// Derive an ExecutionStrategy from observed network samples + UI state.
// Cleaner than baking strategy logic into buildGameSpec — strategy can be
// reused for both preflight + scenario runner.

import type { ExecutionStrategy } from "../../ai/authoring.js";
import type { NormalizedSpinResult } from "./normalized.js";
import type { NetworkRound } from "../step3-capture-network/types.js";

export type StrategyInput = {
  spins: NormalizedSpinResult[];
  rounds: NetworkRound[];
  spinApiUrl: string | null;
  freeSpinDetected: boolean;
};

export function buildExecutionStrategy(input: StrategyInput): ExecutionStrategy {
  const cascade = input.spins.some((s) => s.cascadeFrames.length > 0);
  const wsObserved = input.rounds.some((r) => r.wsFrames.length > 0);
  const channel: ExecutionStrategy["channel"] = wsObserved
    ? input.rounds.some((r) => r.responses.length > 0)
      ? "hybrid"
      : "websocket"
    : "http";

  const completion_signal = cascade
    ? {
        method: "tumble_chain_end" as const,
        tumble_aware: true,
        free_spin_chains: input.freeSpinDetected,
      }
    : {
        method: "single_response" as const,
        tumble_aware: false,
        free_spin_chains: input.freeSpinDetected,
      };

  const field_validation = buildFieldValidation(input.spins);
  const preflight_checks = buildPreflightChecks(input.spins);

  return {
    channel,
    spin_endpoint_evidence: {
      pattern: input.spinApiUrl ?? null,
      evidence_in_samples:
        "Selected by step5-spin-api-detect scoring (win/balance/reel/roundId + POST method).",
      rejected_candidates: [],
    },
    completion_signal,
    field_validation,
    preflight_checks,
  };
}

function buildFieldValidation(spins: NormalizedSpinResult[]): ExecutionStrategy["field_validation"] {
  if (spins.length === 0) {
    return [
      { field: "winAmount", required: true, type: "number", min: 0, nullable: false },
      { field: "balanceAfter", required: true, type: "number", nullable: false },
    ];
  }

  const fv: ExecutionStrategy["field_validation"] = [
    {
      field: "betAmount",
      required: true,
      type: "number",
      min: 0,
      nullable: false,
    },
    {
      field: "winAmount",
      required: true,
      type: "number",
      min: 0,
      nullable: false,
    },
    {
      field: "endingBalance",
      required: true,
      type: "number",
      min: 0,
      nullable: false,
    },
    {
      field: "roundId",
      required: true,
      type: "string",
      nullable: false,
    },
  ];

  // matrix may not always be present (free spin transitions may have empty reels) — warn-only.
  const hasMatrix = spins.some((s) => s.reels.length > 0);
  if (hasMatrix) {
    fv.push({
      field: "matrix",
      required: false,
      type: "string",
      nullable: true,
    });
  }
  return fv;
}

function buildPreflightChecks(
  spins: NormalizedSpinResult[],
): ExecutionStrategy["preflight_checks"] {
  const checks: ExecutionStrategy["preflight_checks"] = [
    {
      id: "sample-count-min",
      description: "At least 1 spin sample available",
      rule: { kind: "sample_count_min", args: { count: 1 } },
    },
    {
      id: "bet-nonzero-across-samples",
      description: "betAmount > 0 across all samples (catches wallet-snapshot mistaken as spin)",
      rule: { kind: "all_samples_field_nonzero", args: { field: "betAmount" } },
    },
  ];

  if (spins.length >= 3) {
    checks.push({
      id: "balance-varies",
      description: "endingBalance varies across samples (catches stale/replayed data)",
      rule: { kind: "samples_field_varies", args: { field: "endingBalance" } },
    });
  }

  // If matrix is consistently present, require it to be non-empty.
  const hasMatrix = spins.some((s) => s.reels.length > 0);
  if (hasMatrix) {
    checks.push({
      id: "matrix-present",
      description: "matrix field has data when present",
      rule: { kind: "any_sample_field_present", args: { field: "matrix" } },
    });
  }

  return checks;
}
