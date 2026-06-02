// Built-in, deterministic test cases injected at catalog-load time so they
// survive catalog regeneration (Generate Cases) and don't depend on the AI
// translator. Currently: the payout-integrity case (verifies a reported win is
// backed by winning symbol combinations + paytable when calibrated).
//
// Gated to providers that itemize per-combo wins (PP `wlc_v`). For other
// providers the case is omitted (no data to verify against).

import type { TestCase, TestCaseCatalog } from "../../ai/test-catalog.js";
import type { CaseAction, CaseActionsCache } from "./case-action-translator.js";
import { parserCache } from "../registry/parser-cache.js";

export const PAYOUT_INTEGRITY_CASE_ID = "payout-integrity";

/** Number of spins the payout case runs to gather winning rounds to verify. */
const PAYOUT_SPIN_COUNT = 40;
const PAYOUT_SPIN_WAIT_MS = 2500;

/** True when the game's provider emits a per-combo win breakdown we can verify
 *  (PP `wlc_v`). Reads the registry parser cache. */
export async function gameSupportsWlcV(slug: string): Promise<boolean> {
  const pc = await parserCache.load(slug).catch(() => null);
  return pc?.parser === "PragmaticParser";
}

export function buildPayoutIntegrityCase(): TestCase {
  return {
    id: PAYOUT_INTEGRITY_CASE_ID,
    name: "Payout integrity — reported win matches winning symbol combos (+ paytable when calibrated)",
    description:
      "Spins at the base bet and checks, for every winning round, that the win the server reports is " +
      "backed by its own itemized winning-symbol combinations (wlc_v): Σ(combo wins) == total win, no " +
      "phantom win, and server total == balance-derived win (Layer 1, always on). When a trusted payout " +
      "model has been calibrated, each combo's win is also checked against the paytable rate (Layer 2).",
    category: "payout_correctness",
    severity: "critical",
    setup_instructions:
      "Set the bet to the minimum and spin repeatedly at the base bet. No special configuration required.",
    expected_bet: null,
    spin_count: PAYOUT_SPIN_COUNT,
    custom_assertions: [
      {
        id: "payout-l1-breakdown-sums-to-total",
        description: "Every winning round: Σ(itemized combo wins) equals the server's total win",
        check_code:
          "getRoundEndSpins(collector.spins).every(s => (typeof s.serverTotalWin !== 'number' || s.serverTotalWin <= 0) || Math.abs(sumWinBreakdown(s) - s.serverTotalWin) <= 0.01)",
      },
      {
        id: "payout-l1-no-phantom-win",
        description: "A positive win is always backed by at least one winning combo (no phantom win)",
        check_code:
          "getRoundEndSpins(collector.spins).every(s => !(typeof s.winAmount === 'number' && s.winAmount > 0) || (Array.isArray(s.winBreakdown) && s.winBreakdown.length > 0))",
      },
      {
        id: "payout-l1-server-total-matches-balance",
        description: "Server-reported total win matches the balance-derived win for the round",
        check_code:
          "getRoundEndSpins(collector.spins).every(s => typeof s.serverTotalWin !== 'number' || typeof s.winAmount !== 'number' || Math.abs(s.serverTotalWin - s.winAmount) <= 0.01)",
      },
      {
        id: "payout-l2-combos-match-paytable",
        description:
          "Each winning combo's win matches the calibrated paytable rate (no-op until a trusted payout model exists)",
        check_code: "getRoundEndSpins(collector.spins).every(s => payoutModelCheck(s).ok)",
      },
    ],
    // Free-spin / big-win interruptions are expected during a 40-spin run.
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP", "BONUS_POPUP"],
    on_feature_triggered: "handle_and_continue",
  };
}

export function buildPayoutIntegrityActions(): CaseAction[] {
  const actions: CaseAction[] = [
    { kind: "set_bet_to_min" },
    { kind: "wait_ms", ms: 800 },
  ];
  for (let i = 0; i < PAYOUT_SPIN_COUNT; i++) {
    actions.push({ kind: "spin" });
    actions.push({ kind: "wait_ms", ms: PAYOUT_SPIN_WAIT_MS });
  }
  return actions;
}

/** Append built-in cases to a loaded catalog (idempotent, PP-gated). Mutates &
 *  returns the catalog. No-op when the provider isn't supported. */
export async function appendBuiltinCases(
  catalog: TestCaseCatalog,
  slug: string,
): Promise<TestCaseCatalog> {
  if (!(await gameSupportsWlcV(slug))) return catalog;
  if (!catalog.cases.some((c) => c.id === PAYOUT_INTEGRITY_CASE_ID)) {
    catalog.cases.push(buildPayoutIntegrityCase());
    catalog.total_cases = catalog.cases.length;
  }
  return catalog;
}

/** Append built-in translated actions to a loaded actions cache (idempotent,
 *  PP-gated). Mutates & returns the cache. */
export async function appendBuiltinActions(
  cache: CaseActionsCache,
  slug: string,
): Promise<CaseActionsCache> {
  if (!(await gameSupportsWlcV(slug))) return cache;
  if (!cache.cases[PAYOUT_INTEGRITY_CASE_ID]) {
    cache.cases[PAYOUT_INTEGRITY_CASE_ID] = {
      caseId: PAYOUT_INTEGRITY_CASE_ID,
      actions: buildPayoutIntegrityActions(),
    };
  }
  return cache;
}
