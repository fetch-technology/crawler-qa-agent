// #6 — Reusable test-case TEMPLATE SET.
//
// Problem: today every game gets a fresh AI-generated catalog (src/ai/
// test-catalog.ts). Testers asked for a hand-authored STANDARD set of cases
// that can be authored once and COPIED onto any game, instead of re-generating
// per game. A human can also add their own templates here (or in the override
// file) and have them applied + run on every game.
//
// Why this works without a hard "re-binding" problem:
//   - setup_instructions reference CANONICAL CONTROL NAMES + natural language
//     ("set the bet to the minimum", "open the paytable") — the existing AI
//     translator (case-action-translator.ts) already binds that NL to the
//     target game's real uiKeys/coordinates per game. So copying a template to
//     a new game + re-running the translator rebinds the actions for free.
//   - assertions use GAME-AGNOSTIC invariants (balance arithmetic, "FS rounds
//     don't deduct bet", "betAmount > 0") instead of hardcoded bet numbers, so
//     they hold on any game with no rebinding.
//   - the few cases that need a concrete min/max bet use {{betMin}} / {{betMax}}
//     / {{defaultBet}} tokens, resolved best-effort from the target game's
//     game-spec-override.json. When unresolved, the token case still runs via
//     its NL setup + a relative assertion.
//
// Applying a template set to a game: see applyTemplateSet() below. It filters
// templates by the game's detected features, substitutes tokens, writes the
// cases into the game's test-cases.json, and clears the stale actions cache so
// the next translate pass rebinds setup→actions against THIS game's registry.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TestCase,
  TestCaseCatalog,
  TestCaseCategory,
} from "../../ai/test-catalog.js";
import type { FeatureName } from "../step4-feature-discovery/types.js";
import { dirForGame } from "../registry/paths.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { gameSpecOverride } from "../registry/game-spec-override.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { loadRawCatalog, saveCatalog } from "./ai-catalog.js";

/** A game-agnostic test case. Same shape as a runnable TestCase, plus a
 *  feature gate. String fields may contain {{token}} placeholders resolved at
 *  apply time. `expected_bet` may be a token string OR a number OR null. */
export type CaseTemplate = Omit<TestCase, "expected_bet"> & {
  /** Feature(s) the target game MUST have for this case to apply. Omit for
   *  universal cases (base game, performance, meta). */
  requiresFeature?: FeatureName | FeatureName[];
  /** number | null as in TestCase, or a "{{token}}" string resolved at apply. */
  expected_bet?: number | string | null;
};

/** Tokens resolvable from the target game's pinned spec override. */
export type TemplateTokens = {
  betMin?: number;
  betMax?: number;
  defaultBet?: number;
  gameName?: string;
};

const FINANCIAL_INVARIANT =
  "collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)";

/**
 * Built-in standard template set. Authored to be game-agnostic. Testers can
 * override/extend this by dropping a `fixtures/case-templates/standard.json`
 * file (array of CaseTemplate) — see loadCaseTemplates().
 */
export const STANDARD_CASE_TEMPLATES: CaseTemplate[] = [
  {
    id: "base-default-bet-single-spin",
    name: "Base game — default bet, single spin",
    description:
      "Spin once at the default bet; verify balance arithmetic and a valid bet.",
    category: "base_game",
    severity: "critical",
    setup_instructions:
      "Ensure the ante bet / bet+ toggle is OFF if the game has one. Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount is positive",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "win-non-negative",
        description: "winAmount finite and non-negative",
        check_code: "typeof spin.winAmount === 'number' && spin.winAmount >= 0",
      },
      {
        id: "balance-conservation",
        description: "endingBalance reflects bet/win arithmetic",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "base-min-bet-single-spin",
    name: "Bet boundary — minimum bet",
    description:
      "Set bet to the minimum and spin once; verify the bet clamps at the floor.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM using the bet-minus control (click it until it stops decreasing). Then spin once.",
    expected_bet: "{{betMin}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount is positive at the floor",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "base-max-bet-single-spin",
    name: "Bet boundary — maximum bet",
    description:
      "Set bet to the maximum and spin once; verify the bet clamps at the ceiling.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MAXIMUM using the bet-plus control (click it until it stops increasing). Then spin once.",
    expected_bet: "{{betMax}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount is positive at the ceiling",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "launch-mid-spin-disconnect-recovery",
    name: "Game launching — mid-spin disconnect recovery",
    description:
      "Start a spin, force a reload while the round is still resolving, and verify the recovered session honors the round without duplicate debit or lost win.",
    category: "base_game",
    severity: "critical",
    setup_instructions:
      "Set the bet to the minimum. Start a spin, then force a page reload mid-animation as soon as the reels begin moving. Wait for the game to return to the main screen and settle.",
    spin_count: 1,
    allowed_interruptions: [
      "BIG_WIN_POPUP",
      "BONUS_POPUP",
      "FREE_SPIN_TRIGGERED",
    ],
    custom_assertions: [
      {
        id: "round-captured-after-reload",
        description: "at least one round result was captured around the reload",
        check_code: "collector.spins.length >= 1",
      },
      {
        id: "no-negative-balance",
        description: "recovered balance never goes negative",
        check_code:
          "collector.spins.every(s => typeof s.endingBalance !== 'number' || s.endingBalance >= -0.01)",
      },
      {
        id: "no-duplicate-round-id",
        description: "reload did not duplicate a settled round id",
        check_code:
          "new Set(collector.spins.map(s => s.id).filter(Boolean)).size === collector.spins.map(s => s.id).filter(Boolean).length",
      },
    ],
  },
  {
    id: "bet-minimum-matches-rule",
    name: "Bet settings — minimum bet matches rule",
    description:
      "Click bet-minus to the floor and verify the on-screen BET equals the configured minimum bet.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Click the bet-minus control until the bet reaches the floor. Do not spin; read the BET / Total Bet display.",
    expected_bet: "{{betMin}}",
    spin_count: 0,
    custom_assertions: [
      {
        id: "screen-bet-is-min",
        description: "BET display equals {{betMin}} when configured",
        check_code:
          "(() => { const expected = {{betMin}}; return expected == null || screen.bet == null || Math.abs(screen.bet - expected) <= 0.01; })()",
      },
    ],
  },
  {
    id: "bet-maximum-matches-rule",
    name: "Bet settings — maximum bet matches rule",
    description:
      "Click bet-plus to the ceiling and verify the on-screen BET equals the configured maximum bet.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Click the bet-plus control until the bet reaches the ceiling. Do not spin; read the BET / Total Bet display.",
    expected_bet: "{{betMax}}",
    spin_count: 0,
    custom_assertions: [
      {
        id: "screen-bet-is-max",
        description: "BET display equals {{betMax}} when configured",
        check_code:
          "(() => { const expected = {{betMax}}; return expected == null || screen.bet == null || Math.abs(screen.bet - expected) <= 0.01; })()",
      },
    ],
  },
  {
    id: "bet-persists-after-spin",
    name: "Bet settings — bet persists after spin",
    description:
      "Set a non-default bet, spin once, and verify the game keeps the same bet after the round settles.",
    category: "bet_variation",
    severity: "major",
    setup_instructions:
      "Set a non-default bet: use a mid-range bet if available, otherwise set the bet to the maximum. Spin once and wait until the round fully settles.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "post-spin-bet-display-matches-spin",
        description:
          "BET display after the spin matches the bet used by the captured round",
        check_code:
          "(() => { const last = collector.spins[collector.spins.length - 1]; return !last || screen.bet == null || typeof last.betAmount !== 'number' || Math.abs(screen.bet - last.betAmount) <= 0.01; })()",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds at the chosen bet",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "bet-locked-mid-spin",
    name: "Bet settings — bet controls locked mid-spin",
    description:
      "Try to change bet while a spin is resolving; verify the round is not disrupted and no extra spin is created.",
    category: "bet_variation",
    severity: "major",
    setup_instructions:
      "Set the bet to the minimum. Start a spin, then immediately try the bet-plus and bet-minus controls while the reels are still moving. Wait for the round to settle.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "single-round-only",
        description:
          "mid-spin bet-control clicks did not create extra spin rounds",
        check_code: "getRoundEndSpins(collector.spins).length === 1",
      },
      {
        id: "no-debounced-spin-warning",
        description: "runner did not detect swallowed/dropped spin clicks",
        check_code:
          "warnings.filter(w => /debounced|popup may have blocked|no spin.*response/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "spin-blocked-if-bet-exceeds-balance",
    name: "Bet settings — spin blocked if bet exceeds balance",
    description:
      "When the wallet cannot afford the selected bet, spin must be blocked with no negative balance.",
    category: "bet_boundary",
    severity: "critical",
    setup_instructions:
      "If the test wallet can be driven below the selected bet, set the bet above the available balance and attempt to spin. Otherwise run at maximum bet and verify balances remain non-negative.",
    expected_bet: "{{betMax}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "balance-never-negative",
        description: "no captured balance goes negative",
        check_code:
          "collector.spins.every(s => typeof s.endingBalance !== 'number' || s.endingBalance >= -0.01)",
      },
    ],
  },
  {
    id: "base-balance-never-negative",
    name: "Base game — balance never negative",
    description:
      "Drive the session toward a low balance and verify spins stop or reconcile without ever going below zero.",
    category: "base_game",
    severity: "critical",
    setup_instructions:
      "Set the bet to the maximum affordable value and spin repeatedly toward the wallet floor. Stop when the game blocks further spins or the configured spin budget is reached.",
    expected_bet: "{{betMax}}",
    spin_count: 20,
    custom_assertions: [
      {
        id: "balance-never-negative",
        description: "every captured ending balance is >= 0",
        check_code:
          "collector.spins.every(s => typeof s.endingBalance !== 'number' || s.endingBalance >= -0.01)",
      },
      {
        id: "rounds-reconcile",
        description: "all captured rounds reconcile",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "max-win-cap-enforced",
    name: "Max win cap — cap enforced when reached",
    description:
      "Run a long winning-round watch and verify any capped win obeys the game's maximum-win behavior when the cap is observable.",
    category: "max_win_cap",
    severity: "critical",
    setup_instructions:
      "Spin a long batch at a stable bet and watch for a max-win / capped-win condition. If the cap is reached, verify the round stops/pays according to the rules.",
    spin_count: 100,
    allowed_interruptions: [
      "BIG_WIN_POPUP",
      "BONUS_POPUP",
      "FREE_SPIN_TRIGGERED",
    ],
    custom_assertions: [
      {
        id: "no-negative-or-invalid-win",
        description: "all captured wins are finite and non-negative",
        check_code:
          "collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)",
      },
      {
        id: "rounds-reconcile",
        description: "all captured rounds reconcile while watching for cap",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "multi-spin-balance-consistency",
    name: "Base game — 10-spin balance consistency",
    description:
      "Spin 10 times at default bet; verify per-round balance arithmetic on every round.",
    category: "base_game",
    severity: "critical",
    setup_instructions:
      "Leave the bet at its default value. Then spin 10 times.",
    spin_count: 10,
    custom_assertions: [
      {
        id: "every-round-balance",
        description: "every captured round reconciles bet/win",
        check_code: FINANCIAL_INVARIANT,
      },
      {
        id: "unique-round-ids",
        description: "every round has a unique id",
        check_code:
          "new Set(collector.spins.map(s => s.id)).size === collector.spins.length",
      },
    ],
  },
  {
    id: "autoplay-10-spins",
    name: "Autoplay — 10 spins",
    description:
      "Run 10 autoplay spins; verify the batch completes and reconciles.",
    category: "autoplay",
    severity: "major",
    requiresFeature: "autoSpin",
    setup_instructions:
      "Open the autoplay settings popup, set the number of spins to 10 (or the closest available), and start autoplay. Let all 10 spins run.",
    spin_count: 10,
    custom_assertions: [
      {
        id: "autoplay-round-count",
        description: "captured at least the requested rounds",
        check_code: "getRoundEndSpins(collector.spins).length >= 5",
      },
      {
        id: "autoplay-balance",
        description: "cumulative bet/win reconciles",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "autoplay-50-min-bet",
    name: "Autoplay — 50 spins at minimum bet",
    description:
      "Run native autoplay at the minimum bet and verify balance integrity across the batch.",
    category: "autoplay",
    severity: "major",
    requiresFeature: "autoSpin",
    setup_instructions:
      "Set the bet to the minimum. Open the autoplay settings popup, select 50 spins (or the closest available preset), start autoplay, and let the batch finish.",
    expected_bet: "{{betMin}}",
    spin_count: 50,
    custom_assertions: [
      {
        id: "autoplay-captured",
        description: "autoplay captured at least one settled round",
        check_code: "getRoundEndSpins(collector.spins).length >= 1",
      },
      {
        id: "autoplay-balance",
        description: "cumulative bet/win reconciles",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "autoplay-50-max-bet",
    name: "Autoplay — 50 spins at maximum bet",
    description:
      "Run native autoplay at the maximum bet when funds allow and verify integrity or a clean stop when funds run out.",
    category: "autoplay",
    severity: "major",
    requiresFeature: "autoSpin",
    setup_instructions:
      "Set the bet to the maximum. Open the autoplay settings popup, select 50 spins (or the closest available preset), start autoplay, and let it run until the batch finishes or the game stops because funds are insufficient.",
    expected_bet: "{{betMax}}",
    spin_count: 50,
    custom_assertions: [
      {
        id: "autoplay-captured",
        description: "autoplay captured at least one settled round",
        check_code: "getRoundEndSpins(collector.spins).length >= 1",
      },
      {
        id: "autoplay-balance",
        description: "cumulative bet/win reconciles",
        check_code: FINANCIAL_INVARIANT,
      },
      {
        id: "balance-never-negative",
        description: "funds exhaustion does not make balance negative",
        check_code:
          "collector.spins.every(s => typeof s.endingBalance !== 'number' || s.endingBalance >= -0.01)",
      },
    ],
  },
  {
    id: "autoplay-turbo-50",
    name: "Autoplay — 50 spins with Turbo enabled",
    description:
      "Enable Turbo spin, run autoplay, and verify accuracy is unaffected.",
    category: "autoplay",
    severity: "major",
    requiresFeature: ["autoSpin", "turbo"],
    setup_instructions:
      "Enable the Turbo spin option. Open the autoplay settings popup, select 50 spins (or the closest available preset), start autoplay, and let the batch finish.",
    spin_count: 50,
    custom_assertions: [
      {
        id: "autoplay-turbo-balance",
        description: "cumulative bet/win reconciles with Turbo enabled",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "autoplay-quick-spin-50",
    name: "Autoplay — 50 spins with Quick Spin enabled",
    description:
      "Enable Quick Spin when available, run autoplay, and verify accuracy is unaffected.",
    category: "autoplay",
    severity: "major",
    requiresFeature: ["autoSpin", "turbo"],
    setup_instructions:
      "Enable the Quick Spin / Fast Spin option. Open the autoplay settings popup, select 50 spins (or the closest available preset), start autoplay, and let the batch finish.",
    spin_count: 50,
    custom_assertions: [
      {
        id: "autoplay-quick-balance",
        description: "cumulative bet/win reconciles with Quick Spin enabled",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "autoplay-manual-stop",
    name: "Autoplay — manual stop works",
    description:
      "Start a 50-spin autoplay batch, stop after several rounds, and verify it halts cleanly after the current round.",
    category: "autoplay",
    severity: "major",
    requiresFeature: "autoSpin",
    setup_instructions:
      "Open the autoplay settings popup, select 50 spins (or the closest available preset), start autoplay, let about 10 rounds run, then click Stop. Wait until the current round settles.",
    spin_count: 50,
    custom_assertions: [
      {
        id: "manual-stop-captured-some",
        description: "manual stop flow captured at least one round",
        check_code: "getRoundEndSpins(collector.spins).length >= 1",
      },
      {
        id: "manual-stop-reconciles",
        description: "captured rounds reconcile after manual stop",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "turbo-spin-toggle",
    name: "Turbo spin — same outcome, faster",
    description:
      "Enable turbo spin and spin once; verify it still produces a valid, reconciled result.",
    category: "turbo_spin",
    severity: "minor",
    requiresFeature: "turbo",
    setup_instructions: "Enable the turbo / quick-spin toggle. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "turbo-balance",
        description: "balance arithmetic holds under turbo",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "ante-bet-toggle",
    name: "Ante bet / Bet+ — total bet increases",
    description:
      "Toggle the ante bet ON; verify total bet rises, then spin once.",
    category: "special_bet",
    severity: "major",
    requiresFeature: "extraBet",
    setup_instructions:
      "Turn the ante bet / bet+ / double-chance toggle ON (it usually raises the total bet, often by 25%). Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "ante-bet-positive",
        description: "betAmount positive with ante on",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "ante-balance",
        description: "balance arithmetic holds with ante on",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "ante-toggle-changes-stake",
    name: "Ante bet — toggle changes stake",
    description:
      "Toggle Ante ON and verify the stake changes according to the special-bet behavior.",
    category: "special_bet",
    severity: "major",
    requiresFeature: "extraBet",
    setup_instructions:
      "Note the current BET / Total Bet. Toggle the Ante / Bet+ / Double Chance control ON. Spin once with Ante ON.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "ante-stake-positive",
        description: "Ante ON produces a valid positive stake",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "ante-stake-at-least-min",
        description: "Ante ON stake is not below configured minimum when known",
        check_code:
          "(() => { const min = {{betMin}}; return min == null || typeof spin.betAmount !== 'number' || spin.betAmount + 0.01 >= min; })()",
      },
      {
        id: "ante-balance",
        description: "balance arithmetic holds with Ante ON",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "ante-off-restores-stake",
    name: "Ante bet — OFF restores base stake",
    description:
      "Turn Ante ON, then OFF, and verify the base stake is restored.",
    category: "special_bet",
    severity: "major",
    requiresFeature: "extraBet",
    setup_instructions:
      "Set the bet to the minimum. Toggle Ante / Bet+ ON, then toggle it OFF again. Spin once with Ante OFF.",
    expected_bet: "{{betMin}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "ante-off-base-bet",
        description:
          "Ante OFF spin uses the configured base minimum bet when known",
        check_code:
          "(() => { const min = {{betMin}}; return min == null || typeof spin.betAmount !== 'number' || Math.abs(spin.betAmount - min) <= 0.01; })()",
      },
      {
        id: "ante-off-balance",
        description: "balance arithmetic holds after Ante OFF",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "ante-on-buy-feature-disabled",
    name: "Ante bet — Buy Feature disabled when Ante ON",
    description:
      "When a title disables Buy Feature under Ante ON, verify the buy control is unavailable or rejected without charge.",
    category: "special_bet",
    severity: "major",
    requiresFeature: ["extraBet", "buyBonus"],
    setup_instructions:
      "Toggle Ante / Bet+ ON. Inspect the Buy Feature button and try to open it only if it is visibly enabled. Do not confirm any purchase.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "no-buy-committed",
        description: "inspection did not trigger a buy spin",
        check_code: "collector.spins.length === 0",
      },
      {
        id: "no-errors",
        description: "no engine errors while checking Buy under Ante ON",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "buy-feature-purchase",
    name: "Buy feature — purchase triggers free spins",
    description:
      "Buy the feature; verify a large deduction and a free-spin chain plays out.",
    category: "buy_feature",
    severity: "critical",
    requiresFeature: "buyBonus",
    setup_instructions:
      "Click the buy bonus / buy feature button, then confirm the purchase in the confirmation popup. Let the free-spin chain play out fully.",
    spin_count: 0,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: [
      "FREE_SPIN_TRIGGERED",
      "BIG_WIN_POPUP",
      "BUY_FEATURE_POPUP",
    ],
    custom_assertions: [
      {
        id: "buy-cost-deducted",
        description: "buy cost is a large multiple of base bet",
        check_code:
          "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()",
      },
      {
        id: "fs-frames-observed",
        description: "free-spin frames observed after purchase",
        check_code: "collector.spins.some(s => s.isFreeSpin === true)",
      },
    ],
  },
  {
    id: "free-spins-no-bet-deducted",
    name: "Free spins — no bet deducted during free spins",
    description:
      "Enter free spins and verify free-spin rounds do not debit the bet; balance only rises by wins.",
    category: "free_spins",
    severity: "critical",
    requiresFeature: "freeSpin",
    setup_instructions:
      "Trigger free spins organically or via a safe available feature path. Once free spins begin, let the entire free-spin sequence play out.",
    spin_count: 100,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: [
      "FREE_SPIN_TRIGGERED",
      "BIG_WIN_POPUP",
      "BONUS_POPUP",
    ],
    custom_assertions: [
      {
        id: "fs-no-bet-deduction",
        description: "free-spin rounds do not deduct a bet",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)",
      },
      {
        id: "fs-rounds-shaped",
        description: "free-spin rounds are well formed",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)",
      },
    ],
  },
  {
    id: "buy-feature-trigger-spin-valid",
    name: "Buy feature — bought trigger spin valid",
    description:
      "Buy the feature and verify the trigger produces a valid bonus/free-spin entry.",
    category: "buy_feature",
    severity: "critical",
    requiresFeature: "buyBonus",
    setup_instructions:
      "Click Buy Feature, confirm the purchase, dismiss any congratulations / press-anywhere popup, and let the triggered feature begin.",
    spin_count: 0,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: [
      "FREE_SPIN_TRIGGERED",
      "BIG_WIN_POPUP",
      "BUY_FEATURE_POPUP",
    ],
    custom_assertions: [
      {
        id: "buy-deduction-observed",
        description: "buy trigger has a large purchase deduction",
        check_code:
          "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 20; })()",
      },
      {
        id: "feature-state-observed",
        description: "feature/free-spin frames are observed after purchase",
        check_code:
          "collector.spins.some(s => s.isFreeSpin === true || /FREE|BONUS/i.test(String(s.state || '')))",
      },
    ],
  },
  {
    id: "buy-feature-no-bet-deducted-during-feature",
    name: "Buy feature — no bet deducted during bought feature",
    description:
      "After buying a feature, verify feature/free-spin rounds do not charge an additional per-spin bet.",
    category: "buy_feature",
    severity: "critical",
    requiresFeature: "buyBonus",
    setup_instructions:
      "Buy the feature, confirm the purchase, dismiss any trigger popup, and let all bought feature/free-spin rounds finish.",
    spin_count: 0,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: [
      "FREE_SPIN_TRIGGERED",
      "BIG_WIN_POPUP",
      "BUY_FEATURE_POPUP",
    ],
    custom_assertions: [
      {
        id: "bought-fs-no-per-spin-deduction",
        description:
          "free-spin/bought-feature rounds do not deduct per-spin bet",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)",
      },
    ],
  },
  {
    id: "buy-feature-cancel-vs-confirm",
    name: "Buy feature — confirmation dialog cancel vs confirm",
    description:
      "Open the Buy Feature confirmation dialog, cancel it, and verify no charge or spin is triggered.",
    category: "buy_feature",
    severity: "major",
    requiresFeature: "buyBonus",
    setup_instructions:
      "Click Buy Feature to open the confirmation dialog. Click Cancel / Close, not Confirm. Verify the popup closes and no buy spin starts.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "cancel-no-spin",
        description: "canceling buy confirmation triggers no spin response",
        check_code: "collector.spins.length === 0",
      },
      {
        id: "cancel-no-errors",
        description: "canceling buy confirmation produces no engine errors",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "buy-feature-blocked-insufficient-funds",
    name: "Buy feature — blocked on insufficient funds",
    description:
      "When the wallet cannot afford the buy price, the purchase must be rejected without deduction.",
    category: "buy_feature",
    severity: "critical",
    requiresFeature: "buyBonus",
    setup_instructions:
      "If the test wallet can be driven below the Buy Feature cost, attempt to buy with insufficient funds. Otherwise open the Buy Feature dialog and cancel safely.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "insufficient-buy-no-feature-spin",
        description:
          "insufficient-funds buy attempt does not start a feature spin",
        check_code: "collector.spins.length === 0",
      },
      {
        id: "no-negative-balance",
        description: "no observed balance is negative",
        check_code:
          "collector.spins.every(s => typeof s.endingBalance !== 'number' || s.endingBalance >= -0.01)",
      },
    ],
  },
  {
    id: "buy-feature-disabled-when-ante-on",
    name: "Buy feature — disabled when Ante ON",
    description:
      "With Ante ON, verify Buy Feature is unavailable or rejected without charge when the game rules require it.",
    category: "buy_feature",
    severity: "major",
    requiresFeature: ["buyBonus", "extraBet"],
    setup_instructions:
      "Toggle Ante / Bet+ ON. Try to open Buy Feature only if it is visibly enabled; do not confirm a purchase. Verify no spin or charge occurs.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "ante-on-buy-no-spin",
        description: "Buy under Ante ON inspection does not trigger a spin",
        check_code: "collector.spins.length === 0",
      },
      {
        id: "ante-on-buy-no-errors",
        description: "Buy under Ante ON inspection produces no engine errors",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "free-spins-organic-watch",
    name: "Free spins — organic trigger watch",
    description:
      "Spin many times at default bet to try to trigger free spins; if triggered, let the bonus complete and verify FS invariants.",
    category: "free_spins",
    severity: "major",
    requiresFeature: "freeSpin",
    setup_instructions:
      "Leave the bet at its default value. Spin up to 100 times to try to trigger free spins. If free spins start, do NOT stop — let the entire bonus (including any retriggers) play out.",
    spin_count: 100,
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP"],
    custom_assertions: [
      {
        id: "fs-no-bet-deduction",
        description: "free-spin rounds don't deduct bet",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)",
      },
      {
        id: "fs-shape",
        description: "free-spin rounds have valid id + non-negative win",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)",
      },
    ],
  },
  {
    id: "history-latest-round",
    name: "History — latest round appears",
    description:
      "Spin once, then open game history; verify the latest round is reconciled against history rows.",
    category: "history",
    severity: "major",
    requiresFeature: "history",
    setup_instructions: "Spin once. Then open the game history / rounds panel.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "history-balance",
        description: "the spin reconciles",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "history-rows-match-recent-spins",
    name: "History — rows match the last 5 spins",
    description:
      "Spin 5 times at default bet, then open game history. The engine auto-runs the history reconciler (category=history): it clicks the history trigger, follows a NEW TAB if one opens, OCRs the rows, and matches them against the captured spins.",
    category: "history",
    severity: "major",
    requiresFeature: "history",
    setup_instructions:
      "Leave the bet at its default value. Spin 5 times, letting each spin fully settle. Then open the game history / rounds panel (it may open in a separate browser tab).",
    spin_count: 5,
    custom_assertions: [
      {
        id: "five-round-end-recorded",
        description:
          "at least 5 round-end spins were captured to back-fill the history panel",
        check_code: "getRoundEndSpins(collector.spins).length >= 5",
      },
      {
        id: "all-spins-same-bet",
        description:
          "all recorded spins were placed at the same configured bet",
        check_code:
          "(() => { const b = collector.spins.map(s => s.betAmount).filter(x => typeof x === 'number'); return b.length > 0 && b.every(x => Math.abs(x - b[0]) <= 0.01); })()",
      },
      {
        id: "spin-ids-unique-and-shaped",
        description:
          "every spin has a non-empty string id, all unique (history row key)",
        check_code:
          "collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0) && new Set(collector.spins.map(s => s.id)).size === collector.spins.length",
      },
      {
        id: "balance-display-trails-last-spin",
        description:
          "screen.balance OCR matches the latest spin endingBalance (within 0.01)",
        check_code:
          "screen.balance == null || (() => { const last = collector.spins[collector.spins.length - 1]; return last == null || typeof last.endingBalance !== 'number' || Math.abs(screen.balance - last.endingBalance) <= 0.01; })()",
      },
      {
        id: "no-debounced-or-lost-spins",
        description: "no spins were debounced or lost while opening history",
        check_code:
          "warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "history-free-spin-rows-distinguishable",
    name: "History — free-spin rows distinguishable from bet rows",
    description:
      "Autoplay enough rounds to organically trigger free spins, then the engine auto-opens game history (category=history) and matches rows to captured spins. Verifies the recorded rounds the history panel shows are FUNCTIONALLY distinct: free-spin rounds carry ZERO stake (and can still win), normal rounds carry a positive stake — that zero-vs-staked contrast is exactly what makes a free-spin row tell-apart-able from a bet row. INCONCLUSIVE (assertions vacuous-pass) on a run where free spins never trigger; autoplay at the highest tile maximises the chance.",
    category: "history",
    severity: "minor",
    requiresFeature: ["freeSpin", "history"],
    setup_instructions:
      "Leave the bet at its default value. Spin a large batch via autoplay (the engine converts this to the game's native autoplay at its highest preset) to try to trigger free spins; if they start, let the whole bonus play out. The engine then auto-opens the game history / rounds panel and reconciles the rows against the captured spins.",
    spin_count: 1000,
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP"],
    custom_assertions: [
      {
        id: "fs-rows-distinguishable",
        description:
          "free-spin rounds carry ZERO stake while normal rounds carry a positive stake (the contrast that makes FS rows distinguishable in history); vacuous-pass when no free spins triggered this run",
        check_code:
          "(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true); if (fs.length === 0) return true; const normal = collector.spins.filter(s => s.isFreeSpin !== true); return fs.every(s => (s.betAmount ?? 0) === 0) && normal.length > 0 && normal.every(s => (s.betAmount ?? 0) > 0); })()",
      },
      {
        id: "fs-rows-shaped-zero-stake",
        description:
          "every free-spin round is a well-formed history row: non-empty id, non-negative win, zero stake; vacuous-pass when no free spins triggered",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0 && (s.betAmount ?? 0) === 0)",
      },
    ],
  },
  {
    id: "paytable-opens",
    name: "Paytable — opens and shows payouts",
    description: "Open the paytable / info screen; verify it displays.",
    category: "rules_consistency",
    severity: "minor",
    requiresFeature: "paytable",
    setup_instructions: "Open the paytable / info screen. Do not spin.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "no-errors",
        description: "no engine errors while opening paytable",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "options-sound-toggle",
    name: "Options — sound toggle",
    description: "Open the menu/options and toggle sound; verify no errors.",
    category: "options",
    severity: "minor",
    setup_instructions:
      "Open the menu / settings, then toggle the sound on/off. Do not spin.",
    spin_count: 0,
    custom_assertions: [
      {
        id: "no-errors",
        description: "no engine errors during options interaction",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "spin-response-performance",
    name: "Performance — spin response time",
    description:
      "Spin once at default bet; verify it returns a result (latency tracked in evidence).",
    category: "performance",
    severity: "minor",
    setup_instructions: "Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "spin-captured",
        description: "a spin response was captured",
        check_code: "collector.spins.length >= 1",
      },
    ],
  },
  {
    id: "bet-mid-variation",
    name: "Bet variation — mid-range bet",
    description:
      "Raise the bet a few steps above the minimum and spin once; verify the chosen bet is above the floor and reconciles.",
    category: "bet_variation",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM, then click the bet-plus control 2–3 times to land on a mid-range bet (above the floor, below the ceiling). Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount is a positive number",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds at the mid bet",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "bet-boundary-above-max-rejected",
    name: "Bet boundary — above-max click rejected",
    description:
      "At the maximum bet, an extra bet-plus click must NOT push the bet past the ceiling.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MAXIMUM (click bet-plus until it stops increasing), then click bet-plus ONE more time. Then spin once. The bet must stay at the maximum.",
    expected_bet: "{{betMax}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount is a positive number",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds at the ceiling",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "bet-boundary-below-min-rejected",
    name: "Bet boundary — below-min click rejected",
    description:
      "At the minimum bet, an extra bet-minus click must NOT push the bet below the floor.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM (click bet-minus until it stops decreasing), then click bet-minus ONE more time. Then spin once. The bet must stay at the minimum (still positive).",
    expected_bet: "{{betMin}}",
    spin_count: 1,
    custom_assertions: [
      {
        id: "bet-positive",
        description: "betAmount stays positive at the floor",
        check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0",
      },
      {
        id: "balance-conservation",
        description: "balance arithmetic holds at the floor",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
    ],
  },
  {
    id: "ui-balance-after-spin",
    name: "UI consistency — balance display after spin",
    description:
      "Spin once and verify the on-screen balance/bet widgets match the server-settled values (OCR cross-check).",
    category: "ui_consistency",
    severity: "major",
    setup_instructions: "Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      {
        id: "spin-reconciles",
        description: "the spin reconciles (bet/win/balance)",
        check_code:
          "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
      },
      {
        id: "no-errors",
        description: "no engine errors during the spin",
        check_code:
          "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0",
      },
    ],
  },
  {
    id: "tumble-cascade-integrity",
    name: "Tumble / cascade — frame dedup integrity",
    description:
      "Spin several times on a tumble/cascade game; verify cascade frames collapse into one logical round each (no inflated spin count) and balance reconciles.",
    category: "base_game",
    severity: "major",
    requiresFeature: "cascade",
    setup_instructions:
      "Leave the bet at its default value. Then spin 5 times, allowing each tumble/cascade animation to finish before the next spin.",
    spin_count: 5,
    custom_assertions: [
      {
        id: "rounds-not-inflated",
        description: "deduped round-end count does not exceed spins requested",
        check_code: "getRoundEndSpins(collector.spins).length <= 5",
      },
      {
        id: "every-round-balance",
        description: "every captured round reconciles bet/win",
        check_code: FINANCIAL_INVARIANT,
      },
    ],
  },
  {
    id: "payout-win-reconciles",
    name: "Payout correctness — a winning round reconciles",
    description:
      "Spin until a win lands; verify that winning round's balance reconciles (the engine also cross-checks the on-screen winning symbols against the paytable when available).",
    category: "payout_correctness",
    severity: "major",
    setup_instructions:
      "Leave the bet at its default value. Spin up to 30 times; stop once at least one winning round (win > 0) has been captured.",
    spin_count: 30,
    custom_assertions: [
      {
        id: "win-observed",
        description: "at least one winning round was captured",
        check_code:
          "collector.spins.some(s => typeof s.winAmount === 'number' && s.winAmount > 0)",
      },
      {
        id: "winning-round-reconciles",
        description: "every winning round reconciles bet/win/balance",
        check_code:
          "collector.spins.filter(s => (s.winAmount ?? 0) > 0).every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)",
      },
    ],
  },
  {
    id: "free-spins-via-autoplay",
    name: "Free spins — trigger via long autoplay",
    description:
      "Use the game's native autoplay at its HIGHEST count to try to trigger free spins, then let the whole bonus play out. More reliable than manual single spins for organic FS.",
    category: "free_spins",
    severity: "major",
    requiresFeature: ["freeSpin", "autoSpin"],
    setup_instructions:
      "Open the autoplay settings popup and select the HIGHEST available spin count (e.g. 500 or 1000). Start autoplay and let it run. If free spins trigger, do NOT stop — let the entire bonus (including any retriggers) finish before ending. Autoplay usually stops on its own when the feature triggers.",
    spin_count: 100,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: [
      "FREE_SPIN_TRIGGERED",
      "FREE_SPIN",
      "BIG_WIN_POPUP",
    ],
    custom_assertions: [
      {
        id: "fs-no-bet-deduction",
        description: "free-spin rounds don't deduct bet",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)",
      },
      {
        id: "fs-shape",
        description: "free-spin rounds have valid id + non-negative win",
        check_code:
          "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)",
      },
      // Trigger-threshold check — game-agnostic + self-deriving via CONTRAST
      // (no symbol-name guessing, no per-game config, no paytable dependency).
      // Counts symbols by NUMERIC matrix code. The scatter is the symbol that
      // appears ≥3× on EVERY spin that triggers FS (isFreeSpin false→true) but
      // NEVER ≥3× on a non-triggering base spin — i.e. ≥3 of it ⟺ a trigger.
      // Regular high-frequency symbols (≥3 on ordinary spins too) are excluded
      // by the contrast, so a busy 30-cell grid can't false-pass. Needs some
      // non-trigger base spins for the contrast (long autoplay provides them).
      // Returns false if a base spin shows ≥3 of the scatter WITHOUT triggering
      // (a real rule violation). Vacuous-pass when no trigger observed.
      {
        id: "fs-trigger-scatter-contrast",
        description:
          "≥3 of a scatter-like symbol coincides with EVERY FS trigger and never appears on a non-triggering spin (self-derived, numeric)",
        check_code:
          "(() => { const spins = collector.spins; const tIdx = new Set(); for (let i = 1; i < spins.length; i++) { const p = spins[i-1], c = spins[i]; if (p && c && p.isFreeSpin !== true && c.isFreeSpin === true) tIdx.add(i-1); } if (tIdx.size === 0) return true; const cnt = (s) => { const m = {}; if (Array.isArray(s.matrix)) s.matrix.forEach(r => Array.isArray(r) && r.forEach(cell => { const k = String(cell && (cell.symbol != null ? cell.symbol : cell.code != null ? cell.code : cell.id != null ? cell.id : cell)); m[k] = (m[k] || 0) + 1; })); return m; }; const trig = [...tIdx].map(i => cnt(spins[i])); const base = spins.filter((s, i) => s.isFreeSpin !== true && !tIdx.has(i) && Array.isArray(s.matrix)).map(cnt); const syms = new Set(); trig.forEach(m => Object.keys(m).forEach(k => syms.add(k))); for (const sym of syms) { if (trig.every(m => (m[sym] || 0) >= 3) && !base.some(m => (m[sym] || 0) >= 3)) return true; } return false; })()",
      },
    ],
  },
  {
    id: "ante-bet-multi-spin-integrity",
    name: "Ante bet enabled across multiple spins maintains elevated stake",
    description:
      "Enables the ANTE BET toggle before spinning and then executes multiple spins to verify that the elevated ante stake is consistently applied on every round, balance deductions match the ante stake, and no spin silently reverts to the base stake. This guards against regressions where the ante flag is dropped mid-session or the stake calculation drifts across rounds.",
    category: "special_bet",
    severity: "major",
    setup_instructions:
      "From the default bet, click anteButton once to enable the ANTE BET mode (stake per spin should increase). Do not change bet size afterwards. Then execute the spins via spinButton.",
    spin_count: 10,
    custom_assertions: [
      {
        id: "all-spins-completed",
        description: "All 10 spins completed with a terminal status",
        check_code:
          "collector.spins.length === 10 && collector.spins.every(s => s.status === 'resolved'  s.state === 'normal'  s.state === 'free-spin')",
      },
      {
        id: "ante-stake-consistent",
        description: "Every spin uses the same (ante) bet amount",
        check_code:
          "(() => { const bets = collector.spins.map(s => s.betAmount); return bets.length > 0 && bets.every(b => b === bets[0]); })()",
      },
      {
        id: "balance-math-holds-per-spin",
        description:
          "Ending balance equals startingBalance - betAmount + winAmount for each spin",
        check_code:
          "collector.spins.every(s => s.startingBalance === null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) < 0.005)",
      },
      {
        id: "balance-continuity-across-spins",
        description:
          "Each spin's starting balance equals the previous spin's ending balance",
        check_code:
          "(() => { for (let i = 1; i < collector.spins.length; i++) { const prev = collector.spins[i-1].endingBalance; const cur = collector.spins[i].startingBalance; if (cur !== null && Math.abs(cur - prev) > 0.005) return false; } return true; })()",
      },
      {
        id: "balance-never-negative",
        description: "Balance is never negative on any spin",
        check_code:
          "collector.spins.every(s => s.endingBalance >= 0 && (s.startingBalance === null || s.startingBalance >= 0))",
      },
      {
        id: "no-unintended-free-spin-swap",
        description:
          "Base ante rounds are not misreported as free spins (freeSpinsRemaining not > 0 on base rounds)",
        check_code:
          "collector.spins.every(s => s.isFreeSpin === true  s.freeSpinsRemaining === null  s.freeSpinsRemaining === 0)",
      },
    ],
  },
];

/** Repo-relative path to the optional tester-authored template override file. */
export const TEMPLATE_OVERRIDE_PATH = path.join(
  "fixtures",
  "case-templates",
  "standard.json",
);

/**
 * Load the active template set. Prefers a tester-authored
 * `fixtures/case-templates/standard.json` (array of CaseTemplate) when present;
 * otherwise returns the built-in STANDARD_CASE_TEMPLATES. This lets a tester
 * author a base set on one game, export/edit it, and reuse it across games
 * without touching code.
 */
export async function loadCaseTemplates(): Promise<{
  templates: CaseTemplate[];
  source: "override-file" | "built-in";
}> {
  try {
    const raw = await readFile(TEMPLATE_OVERRIDE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { templates: parsed as CaseTemplate[], source: "override-file" };
    }
  } catch {
    // no override file — fall through to built-in
  }
  return { templates: STANDARD_CASE_TEMPLATES, source: "built-in" };
}

export function validateCaseTemplates(
  value: unknown,
): { ok: true; templates: CaseTemplate[] } | { ok: false; reason: string } {
  if (!Array.isArray(value))
    return { ok: false, reason: "template payload must be a JSON array" };
  if (value.length === 0)
    return { ok: false, reason: "template array must not be empty" };

  const ids = new Set<string>();
  for (const [idx, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `template[${idx}] must be an object` };
    }
    const tpl = item as Partial<CaseTemplate>;
    if (!tpl.id || typeof tpl.id !== "string")
      return { ok: false, reason: `template[${idx}].id is required` };
    if (ids.has(tpl.id))
      return { ok: false, reason: `duplicate template id "${tpl.id}"` };
    ids.add(tpl.id);
    if (!tpl.name || typeof tpl.name !== "string")
      return { ok: false, reason: `template "${tpl.id}" name is required` };
    if (!tpl.description || typeof tpl.description !== "string")
      return {
        ok: false,
        reason: `template "${tpl.id}" description is required`,
      };
    if (!tpl.category || typeof tpl.category !== "string")
      return { ok: false, reason: `template "${tpl.id}" category is required` };
    if (!tpl.severity || typeof tpl.severity !== "string")
      return { ok: false, reason: `template "${tpl.id}" severity is required` };
    if (!tpl.setup_instructions || typeof tpl.setup_instructions !== "string")
      return {
        ok: false,
        reason: `template "${tpl.id}" setup_instructions is required`,
      };
    if (
      tpl.spin_count != null &&
      (typeof tpl.spin_count !== "number" ||
        !Number.isFinite(tpl.spin_count) ||
        tpl.spin_count < 0)
    ) {
      return {
        ok: false,
        reason: `template "${tpl.id}" spin_count must be a non-negative number`,
      };
    }
    if (
      tpl.custom_assertions != null &&
      !Array.isArray(tpl.custom_assertions)
    ) {
      return {
        ok: false,
        reason: `template "${tpl.id}" custom_assertions must be an array when present`,
      };
    }
  }

  return { ok: true, templates: value as CaseTemplate[] };
}

export async function saveCaseTemplatesOverride(
  templates: CaseTemplate[],
): Promise<string> {
  const valid = validateCaseTemplates(templates);
  if (!valid.ok) throw new Error(valid.reason);
  await mkdir(path.dirname(TEMPLATE_OVERRIDE_PATH), { recursive: true });
  await writeFile(
    TEMPLATE_OVERRIDE_PATH,
    JSON.stringify(valid.templates, null, 2) + "\n",
    "utf8",
  );
  return TEMPLATE_OVERRIDE_PATH;
}

export async function resetCaseTemplatesOverride(): Promise<string> {
  await rm(TEMPLATE_OVERRIDE_PATH, { force: true });
  return TEMPLATE_OVERRIDE_PATH;
}

function substituteTokens(value: string, tokens: TemplateTokens): string {
  return value
    .replace(
      /\{\{betMin\}\}/g,
      tokens.betMin != null ? String(tokens.betMin) : "{{betMin}}",
    )
    .replace(
      /\{\{betMax\}\}/g,
      tokens.betMax != null ? String(tokens.betMax) : "{{betMax}}",
    )
    .replace(
      /\{\{defaultBet\}\}/g,
      tokens.defaultBet != null ? String(tokens.defaultBet) : "{{defaultBet}}",
    )
    .replace(/\{\{gameName\}\}/g, tokens.gameName ?? "{{gameName}}");
}

function substituteCodeTokens(value: string, tokens: TemplateTokens): string {
  return value
    .replace(
      /\{\{betMin\}\}/g,
      tokens.betMin != null ? String(tokens.betMin) : "null",
    )
    .replace(
      /\{\{betMax\}\}/g,
      tokens.betMax != null ? String(tokens.betMax) : "null",
    )
    .replace(
      /\{\{defaultBet\}\}/g,
      tokens.defaultBet != null ? String(tokens.defaultBet) : "null",
    )
    .replace(/\{\{gameName\}\}/g, JSON.stringify(tokens.gameName ?? ""));
}

function registryKeys(
  uiMap: import("../registry/types.js").UiRegistry | null,
): string[] {
  return Object.keys(uiMap ?? {});
}

function hasAnyKey(keys: string[], patterns: RegExp[]): boolean {
  return keys.some((k) => patterns.some((p) => p.test(k)));
}

function inferFeatureFromRegistry(
  uiMap: import("../registry/types.js").UiRegistry | null,
  feature: FeatureName,
): boolean {
  const keys = registryKeys(uiMap);
  switch (feature) {
    case "autoSpin":
      return hasAnyKey(keys, [
        /^autoButton(?:__|$)/i,
        /autoplay/i,
        /auto(?:Count|Spin)/i,
        /numberOfSpins/i,
        /__startAutoplayButton$/i,
      ]);
    case "buyBonus":
      return hasAnyKey(keys, [
        /^buy(?:Bonus|Feature)?Button(?:__|$)/i,
        /buy.*bonus/i,
        /buy.*feature/i,
      ]);
    case "extraBet":
      return hasAnyKey(keys, [
        /^anteButton(?:__|$)/i,
        /ante/i,
        /double.?chance/i,
        /extra.?bet/i,
        /bet.?boost/i,
      ]);
    case "turbo":
      return hasAnyKey(keys, [
        /^turboButton(?:__|$)/i,
        /turbo/i,
        /quick.?spin/i,
        /fast.?spin/i,
      ]);
    case "history":
      return hasAnyKey(keys, [
        /^historyButton(?:__|$)/i,
        /history/i,
        /rounds/i,
      ]);
    case "paytable":
      return hasAnyKey(keys, [
        /^paytableButton(?:__|$)/i,
        /paytable/i,
        /rules/i,
        /info/i,
      ]);
    default:
      return false;
  }
}

function hasFeature(
  reg: import("../step4-feature-discovery/types.js").FeatureRegistry | null,
  uiMap: import("../registry/types.js").UiRegistry | null,
  feature: FeatureName,
): boolean {
  return (
    Boolean(reg?.features?.[feature]?.present) ||
    inferFeatureFromRegistry(uiMap, feature)
  );
}

function extractNumericSuffix(key: string): number | null {
  const m = key.match(
    /(?:totalBet|betAmount|bet|chip|stake)-([0-9]+(?:[.,][0-9]+)?)/i,
  );
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deriveBetTokensFromRegistry(
  uiMap: import("../registry/types.js").UiRegistry | null,
): Pick<TemplateTokens, "betMin" | "betMax" | "defaultBet"> {
  const values = Array.from(
    new Set(
      registryKeys(uiMap)
        .map(extractNumericSuffix)
        .filter((n): n is number => n != null),
    ),
  ).sort((a, b) => a - b);
  if (values.length === 0) return {};
  return {
    betMin: values[0],
    betMax: values[values.length - 1],
    defaultBet: values[0],
  };
}

/** Resolve a template's `expected_bet` (number | token | null) against tokens. */
function resolveExpectedBet(
  value: number | string | null | undefined,
  tokens: TemplateTokens,
): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const sub = substituteTokens(value, tokens);
  const n = Number(sub);
  return Number.isFinite(n) ? n : null; // unresolved token → null (NL setup still drives the case)
}

/** Convert one template into a concrete TestCase for the target game. */
export function instantiateTemplate(
  tpl: CaseTemplate,
  tokens: TemplateTokens,
): TestCase {
  const {
    requiresFeature: _req,
    expected_bet,
    setup_instructions,
    description,
    name,
    ...rest
  } = tpl;
  return {
    ...rest,
    name: substituteTokens(name, tokens),
    description: substituteTokens(description, tokens),
    setup_instructions: substituteTokens(setup_instructions, tokens),
    expected_bet: resolveExpectedBet(expected_bet, tokens),
    custom_assertions: tpl.custom_assertions?.map((a) => ({
      ...a,
      description: substituteTokens(a.description, tokens),
      check_code: substituteCodeTokens(a.check_code, tokens),
    })),
  };
}

export type ApplyTemplateSetResult = {
  slug: string;
  source: "override-file" | "built-in";
  applied: TestCase[];
  skipped: Array<{ id: string; reason: string }>;
  mode: "merge" | "replace";
  catalogPath: string;
  actionsCacheCleared: boolean;
};

/**
 * Copy the standard template set onto a game.
 *
 * - Filters out templates whose `requiresFeature` the game lacks (per its
 *   feature-registry.json), with a registry-key fallback for UI-obvious
 *   controls like Playtech's hold-to-autoplay panel.
 * - Substitutes {{betMin}}/{{betMax}}/{{defaultBet}}/{{gameName}} from the
 *   game's game-spec-override.json, falling back to numeric bet rows/chips in
 *   ui-registry.json (best-effort; unresolved tokens become null expected_bet
 *   and the NL setup still drives the case).
 * - Writes the resulting cases into the game's test-cases.json. In "merge" mode
 *   (default) existing cases with the SAME id are NOT overwritten (so manual /
 *   AI cases survive); new template cases are appended. In "replace" mode the
 *   catalog's cases are replaced wholesale.
 * - Clears the stale actions cache (test-cases.actions.json) so the next
 *   translate pass rebinds setup→actions against THIS game's ui-registry.
 *
 * After this, run the translator (translateAllCases) to bind actions, then run
 * the cases as usual.
 */
export async function applyTemplateSet(
  slug: string,
  opts: { mode?: "merge" | "replace"; gameDisplayName?: string } = {},
): Promise<ApplyTemplateSetResult> {
  const mode = opts.mode ?? "merge";
  const { templates, source } = await loadCaseTemplates();
  const reg = await featureRegistry.load(slug).catch(() => null);
  const uiMap = await uiRegistry.load(slug).catch(() => null);
  const ov = await gameSpecOverride.load(slug).catch(() => null);
  const registryBetTokens = deriveBetTokensFromRegistry(uiMap);
  const tokens: TemplateTokens = {
    betMin: ov?.betMin ?? registryBetTokens.betMin,
    betMax: ov?.betMax ?? registryBetTokens.betMax,
    defaultBet: ov?.defaultBet ?? registryBetTokens.defaultBet,
    gameName: opts.gameDisplayName ?? slug,
  };

  const applied: TestCase[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const tpl of templates) {
    const required = tpl.requiresFeature
      ? Array.isArray(tpl.requiresFeature)
        ? tpl.requiresFeature
        : [tpl.requiresFeature]
      : [];
    const missing = required.filter((f) => !hasFeature(reg, uiMap, f));
    if (missing.length > 0) {
      skipped.push({
        id: tpl.id,
        reason: `game lacks feature(s): ${missing.join(", ")}`,
      });
      continue;
    }
    applied.push(instantiateTemplate(tpl, tokens));
  }

  const existing = await loadRawCatalog(slug);
  let cases: TestCase[];
  if (mode === "replace" || !existing) {
    cases = applied;
  } else {
    const existingIds = new Set(existing.cases.map((c) => c.id));
    const fresh = applied.filter((c) => !existingIds.has(c.id));
    cases = [...existing.cases, ...fresh];
  }

  const catalog: TestCaseCatalog = {
    game_slug: slug,
    game_display_name:
      existing?.game_display_name ?? opts.gameDisplayName ?? slug,
    generated_at: existing?.generated_at ?? "template-set",
    total_cases: cases.length,
    cases,
    coverage_notes: existing?.coverage_notes ?? [
      `Applied standard template set (${source}).`,
    ],
    generation_meta: existing?.generation_meta,
  };
  const catalogPath = await saveCatalog(slug, catalog);

  // Invalidate the actions cache so setup→actions rebinds for this game.
  let actionsCacheCleared = false;
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(dirForGame(slug), "test-cases.actions.json"), {
      force: true,
    });
    actionsCacheCleared = true;
  } catch {
    // no cache to clear — fine
  }

  return {
    slug,
    source,
    applied,
    skipped,
    mode,
    catalogPath,
    actionsCacheCleared,
  };
}

export const CASE_TEMPLATE_CATEGORIES: ReadonlyArray<TestCaseCategory> =
  Array.from(new Set(STANDARD_CASE_TEMPLATES.map((t) => t.category)));
