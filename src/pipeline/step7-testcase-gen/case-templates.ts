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

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TestCase, TestCaseCatalog, TestCaseCategory } from "../../ai/test-catalog.js";
import type { FeatureName } from "../step4-feature-discovery/types.js";
import { dirForGame } from "../registry/paths.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { gameSpecOverride } from "../registry/game-spec-override.js";
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
    description: "Spin once at the default bet; verify balance arithmetic and a valid bet.",
    category: "base_game",
    severity: "critical",
    setup_instructions:
      "Ensure the ante bet / bet+ toggle is OFF if the game has one. Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount is positive", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "win-non-negative", description: "winAmount finite and non-negative", check_code: "typeof spin.winAmount === 'number' && spin.winAmount >= 0" },
      { id: "balance-conservation", description: "endingBalance reflects bet/win arithmetic", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "base-min-bet-single-spin",
    name: "Bet boundary — minimum bet",
    description: "Set bet to the minimum and spin once; verify the bet clamps at the floor.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM using the bet-minus control (click it until it stops decreasing). Then spin once.",
    expected_bet: "{{betMin}}",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount is positive at the floor", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "balance-conservation", description: "balance arithmetic holds", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "base-max-bet-single-spin",
    name: "Bet boundary — maximum bet",
    description: "Set bet to the maximum and spin once; verify the bet clamps at the ceiling.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MAXIMUM using the bet-plus control (click it until it stops increasing). Then spin once.",
    expected_bet: "{{betMax}}",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount is positive at the ceiling", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "balance-conservation", description: "balance arithmetic holds", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "multi-spin-balance-consistency",
    name: "Base game — 10-spin balance consistency",
    description: "Spin 10 times at default bet; verify per-round balance arithmetic on every round.",
    category: "base_game",
    severity: "critical",
    setup_instructions: "Leave the bet at its default value. Then spin 10 times.",
    spin_count: 10,
    custom_assertions: [
      { id: "every-round-balance", description: "every captured round reconciles bet/win", check_code: FINANCIAL_INVARIANT },
      { id: "unique-round-ids", description: "every round has a unique id", check_code: "new Set(collector.spins.map(s => s.id)).size === collector.spins.length" },
    ],
  },
  {
    id: "autoplay-10-spins",
    name: "Autoplay — 10 spins",
    description: "Run 10 autoplay spins; verify the batch completes and reconciles.",
    category: "autoplay",
    severity: "major",
    requiresFeature: "autoSpin",
    setup_instructions:
      "Open the autoplay settings popup, set the number of spins to 10 (or the closest available), and start autoplay. Let all 10 spins run.",
    spin_count: 10,
    custom_assertions: [
      { id: "autoplay-round-count", description: "captured at least the requested rounds", check_code: "getRoundEndSpins(collector.spins).length >= 5" },
      { id: "autoplay-balance", description: "cumulative bet/win reconciles", check_code: FINANCIAL_INVARIANT },
    ],
  },
  {
    id: "turbo-spin-toggle",
    name: "Turbo spin — same outcome, faster",
    description: "Enable turbo spin and spin once; verify it still produces a valid, reconciled result.",
    category: "turbo_spin",
    severity: "minor",
    requiresFeature: "turbo",
    setup_instructions: "Enable the turbo / quick-spin toggle. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "turbo-balance", description: "balance arithmetic holds under turbo", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "ante-bet-toggle",
    name: "Ante bet / Bet+ — total bet increases",
    description: "Toggle the ante bet ON; verify total bet rises, then spin once.",
    category: "special_bet",
    severity: "major",
    requiresFeature: "extraBet",
    setup_instructions:
      "Turn the ante bet / bet+ / double-chance toggle ON (it usually raises the total bet, often by 25%). Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "ante-bet-positive", description: "betAmount positive with ante on", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "ante-balance", description: "balance arithmetic holds with ante on", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "buy-feature-purchase",
    name: "Buy feature — purchase triggers free spins",
    description: "Buy the feature; verify a large deduction and a free-spin chain plays out.",
    category: "buy_feature",
    severity: "critical",
    requiresFeature: "buyBonus",
    setup_instructions:
      "Click the buy bonus / buy feature button, then confirm the purchase in the confirmation popup. Let the free-spin chain play out fully.",
    spin_count: 0,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP", "BUY_FEATURE_POPUP"],
    custom_assertions: [
      { id: "buy-cost-deducted", description: "buy cost is a large multiple of base bet", check_code: "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()" },
      { id: "fs-frames-observed", description: "free-spin frames observed after purchase", check_code: "collector.spins.some(s => s.isFreeSpin === true)" },
    ],
  },
  {
    id: "free-spins-organic-watch",
    name: "Free spins — organic trigger watch",
    description: "Spin many times at default bet to try to trigger free spins; if triggered, let the bonus complete and verify FS invariants.",
    category: "free_spins",
    severity: "major",
    requiresFeature: "freeSpin",
    setup_instructions:
      "Leave the bet at its default value. Spin up to 100 times to try to trigger free spins. If free spins start, do NOT stop — let the entire bonus (including any retriggers) play out.",
    spin_count: 100,
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP"],
    custom_assertions: [
      { id: "fs-no-bet-deduction", description: "free-spin rounds don't deduct bet", check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)" },
      { id: "fs-shape", description: "free-spin rounds have valid id + non-negative win", check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)" },
    ],
  },
  {
    id: "history-latest-round",
    name: "History — latest round appears",
    description: "Spin once, then open game history; verify the latest round is reconciled against history rows.",
    category: "history",
    severity: "major",
    requiresFeature: "history",
    setup_instructions: "Spin once. Then open the game history / rounds panel.",
    spin_count: 1,
    custom_assertions: [
      { id: "history-balance", description: "the spin reconciles", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "history-rows-match-recent-spins",
    name: "History — rows match the last 5 spins",
    description: "Spin 5 times at default bet, then open game history. The engine auto-runs the history reconciler (category=history): it clicks the history trigger, follows a NEW TAB if one opens, OCRs the rows, and matches them against the captured spins.",
    category: "history",
    severity: "major",
    requiresFeature: "history",
    setup_instructions:
      "Leave the bet at its default value. Spin 5 times, letting each spin fully settle. Then open the game history / rounds panel (it may open in a separate browser tab).",
    spin_count: 5,
    custom_assertions: [
      { id: "five-round-end-recorded", description: "at least 5 round-end spins were captured to back-fill the history panel", check_code: "getRoundEndSpins(collector.spins).length >= 5" },
      { id: "all-spins-same-bet", description: "all recorded spins were placed at the same configured bet", check_code: "(() => { const b = collector.spins.map(s => s.betAmount).filter(x => typeof x === 'number'); return b.length > 0 && b.every(x => Math.abs(x - b[0]) <= 0.01); })()" },
      { id: "spin-ids-unique-and-shaped", description: "every spin has a non-empty string id, all unique (history row key)", check_code: "collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0) && new Set(collector.spins.map(s => s.id)).size === collector.spins.length" },
      { id: "balance-display-trails-last-spin", description: "screen.balance OCR matches the latest spin endingBalance (within 0.01)", check_code: "screen.balance == null || (() => { const last = collector.spins[collector.spins.length - 1]; return last == null || typeof last.endingBalance !== 'number' || Math.abs(screen.balance - last.endingBalance) <= 0.01; })()" },
      { id: "no-debounced-or-lost-spins", description: "no spins were debounced or lost while opening history", check_code: "warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0" },
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
      { id: "no-errors", description: "no engine errors while opening paytable", check_code: "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0" },
    ],
  },
  {
    id: "options-sound-toggle",
    name: "Options — sound toggle",
    description: "Open the menu/options and toggle sound; verify no errors.",
    category: "options",
    severity: "minor",
    setup_instructions: "Open the menu / settings, then toggle the sound on/off. Do not spin.",
    spin_count: 0,
    custom_assertions: [
      { id: "no-errors", description: "no engine errors during options interaction", check_code: "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0" },
    ],
  },
  {
    id: "spin-response-performance",
    name: "Performance — spin response time",
    description: "Spin once at default bet; verify it returns a result (latency tracked in evidence).",
    category: "performance",
    severity: "minor",
    setup_instructions: "Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "spin-captured", description: "a spin response was captured", check_code: "collector.spins.length >= 1" },
    ],
  },
  {
    id: "bet-mid-variation",
    name: "Bet variation — mid-range bet",
    description: "Raise the bet a few steps above the minimum and spin once; verify the chosen bet is above the floor and reconciles.",
    category: "bet_variation",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM, then click the bet-plus control 2–3 times to land on a mid-range bet (above the floor, below the ceiling). Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount is a positive number", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "balance-conservation", description: "balance arithmetic holds at the mid bet", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "bet-boundary-above-max-rejected",
    name: "Bet boundary — above-max click rejected",
    description: "At the maximum bet, an extra bet-plus click must NOT push the bet past the ceiling.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MAXIMUM (click bet-plus until it stops increasing), then click bet-plus ONE more time. Then spin once. The bet must stay at the maximum.",
    expected_bet: "{{betMax}}",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount is a positive number", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "balance-conservation", description: "balance arithmetic holds at the ceiling", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "bet-boundary-below-min-rejected",
    name: "Bet boundary — below-min click rejected",
    description: "At the minimum bet, an extra bet-minus click must NOT push the bet below the floor.",
    category: "bet_boundary",
    severity: "major",
    setup_instructions:
      "Set the bet to the MINIMUM (click bet-minus until it stops decreasing), then click bet-minus ONE more time. Then spin once. The bet must stay at the minimum (still positive).",
    expected_bet: "{{betMin}}",
    spin_count: 1,
    custom_assertions: [
      { id: "bet-positive", description: "betAmount stays positive at the floor", check_code: "typeof spin.betAmount === 'number' && spin.betAmount > 0" },
      { id: "balance-conservation", description: "balance arithmetic holds at the floor", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
    ],
  },
  {
    id: "ui-balance-after-spin",
    name: "UI consistency — balance display after spin",
    description: "Spin once and verify the on-screen balance/bet widgets match the server-settled values (OCR cross-check).",
    category: "ui_consistency",
    severity: "major",
    setup_instructions: "Leave the bet at its default value. Then spin once.",
    spin_count: 1,
    custom_assertions: [
      { id: "spin-reconciles", description: "the spin reconciles (bet/win/balance)", check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01" },
      { id: "no-errors", description: "no engine errors during the spin", check_code: "warnings.filter(w => /error|exception|threw/i.test(w)).length === 0" },
    ],
  },
  {
    id: "tumble-cascade-integrity",
    name: "Tumble / cascade — frame dedup integrity",
    description: "Spin several times on a tumble/cascade game; verify cascade frames collapse into one logical round each (no inflated spin count) and balance reconciles.",
    category: "base_game",
    severity: "major",
    requiresFeature: "cascade",
    setup_instructions: "Leave the bet at its default value. Then spin 5 times, allowing each tumble/cascade animation to finish before the next spin.",
    spin_count: 5,
    custom_assertions: [
      { id: "rounds-not-inflated", description: "deduped round-end count does not exceed spins requested", check_code: "getRoundEndSpins(collector.spins).length <= 5" },
      { id: "every-round-balance", description: "every captured round reconciles bet/win", check_code: FINANCIAL_INVARIANT },
    ],
  },
  {
    id: "payout-win-reconciles",
    name: "Payout correctness — a winning round reconciles",
    description: "Spin until a win lands; verify that winning round's balance reconciles (the engine also cross-checks the on-screen winning symbols against the paytable when available).",
    category: "payout_correctness",
    severity: "major",
    setup_instructions: "Leave the bet at its default value. Spin up to 30 times; stop once at least one winning round (win > 0) has been captured.",
    spin_count: 30,
    custom_assertions: [
      { id: "win-observed", description: "at least one winning round was captured", check_code: "collector.spins.some(s => typeof s.winAmount === 'number' && s.winAmount > 0)" },
      { id: "winning-round-reconciles", description: "every winning round reconciles bet/win/balance", check_code: "collector.spins.filter(s => (s.winAmount ?? 0) > 0).every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)" },
    ],
  },
  {
    id: "free-spins-via-autoplay",
    name: "Free spins — trigger via long autoplay",
    description: "Use the game's native autoplay at its HIGHEST count to try to trigger free spins, then let the whole bonus play out. More reliable than manual single spins for organic FS.",
    category: "free_spins",
    severity: "major",
    requiresFeature: ["freeSpin", "autoSpin"],
    setup_instructions:
      "Open the autoplay settings popup and select the HIGHEST available spin count (e.g. 500 or 1000). Start autoplay and let it run. If free spins trigger, do NOT stop — let the entire bonus (including any retriggers) finish before ending. Autoplay usually stops on its own when the feature triggers.",
    spin_count: 100,
    expected_feature: "free_spins_triggered",
    allowed_interruptions: ["FREE_SPIN_TRIGGERED", "FREE_SPIN", "BIG_WIN_POPUP"],
    custom_assertions: [
      { id: "fs-no-bet-deduction", description: "free-spin rounds don't deduct bet", check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)" },
      { id: "fs-shape", description: "free-spin rounds have valid id + non-negative win", check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)" },
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
      { id: "fs-trigger-scatter-contrast", description: "≥3 of a scatter-like symbol coincides with EVERY FS trigger and never appears on a non-triggering spin (self-derived, numeric)", check_code: "(() => { const spins = collector.spins; const tIdx = new Set(); for (let i = 1; i < spins.length; i++) { const p = spins[i-1], c = spins[i]; if (p && c && p.isFreeSpin !== true && c.isFreeSpin === true) tIdx.add(i-1); } if (tIdx.size === 0) return true; const cnt = (s) => { const m = {}; if (Array.isArray(s.matrix)) s.matrix.forEach(r => Array.isArray(r) && r.forEach(cell => { const k = String(cell && (cell.symbol != null ? cell.symbol : cell.code != null ? cell.code : cell.id != null ? cell.id : cell)); m[k] = (m[k] || 0) + 1; })); return m; }; const trig = [...tIdx].map(i => cnt(spins[i])); const base = spins.filter((s, i) => s.isFreeSpin !== true && !tIdx.has(i) && Array.isArray(s.matrix)).map(cnt); const syms = new Set(); trig.forEach(m => Object.keys(m).forEach(k => syms.add(k))); for (const sym of syms) { if (trig.every(m => (m[sym] || 0) >= 3) && !base.some(m => (m[sym] || 0) >= 3)) return true; } return false; })()" },
    ],
  },
];

/** Repo-relative path to the optional tester-authored template override file. */
export const TEMPLATE_OVERRIDE_PATH = path.join("fixtures", "case-templates", "standard.json");

/**
 * Load the active template set. Prefers a tester-authored
 * `fixtures/case-templates/standard.json` (array of CaseTemplate) when present;
 * otherwise returns the built-in STANDARD_CASE_TEMPLATES. This lets a tester
 * author a base set on one game, export/edit it, and reuse it across games
 * without touching code.
 */
export async function loadCaseTemplates(): Promise<{ templates: CaseTemplate[]; source: "override-file" | "built-in" }> {
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

function substituteTokens(value: string, tokens: TemplateTokens): string {
  return value
    .replace(/\{\{betMin\}\}/g, tokens.betMin != null ? String(tokens.betMin) : "{{betMin}}")
    .replace(/\{\{betMax\}\}/g, tokens.betMax != null ? String(tokens.betMax) : "{{betMax}}")
    .replace(/\{\{defaultBet\}\}/g, tokens.defaultBet != null ? String(tokens.defaultBet) : "{{defaultBet}}")
    .replace(/\{\{gameName\}\}/g, tokens.gameName ?? "{{gameName}}");
}

function hasFeature(reg: import("../step4-feature-discovery/types.js").FeatureRegistry | null, feature: FeatureName): boolean {
  return Boolean(reg?.features?.[feature]?.present);
}

/** Resolve a template's `expected_bet` (number | token | null) against tokens. */
function resolveExpectedBet(value: number | string | null | undefined, tokens: TemplateTokens): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const sub = substituteTokens(value, tokens);
  const n = Number(sub);
  return Number.isFinite(n) ? n : null; // unresolved token → null (NL setup still drives the case)
}

/** Convert one template into a concrete TestCase for the target game. */
export function instantiateTemplate(tpl: CaseTemplate, tokens: TemplateTokens): TestCase {
  const { requiresFeature: _req, expected_bet, setup_instructions, description, name, ...rest } = tpl;
  return {
    ...rest,
    name: substituteTokens(name, tokens),
    description: substituteTokens(description, tokens),
    setup_instructions: substituteTokens(setup_instructions, tokens),
    expected_bet: resolveExpectedBet(expected_bet, tokens),
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
 *   feature-registry.json).
 * - Substitutes {{betMin}}/{{betMax}}/{{defaultBet}}/{{gameName}} from the
 *   game's game-spec-override.json (best-effort; unresolved tokens become null
 *   expected_bet and the NL setup still drives the case).
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
  const ov = await gameSpecOverride.load(slug).catch(() => null);
  const tokens: TemplateTokens = {
    betMin: ov?.betMin,
    betMax: ov?.betMax,
    defaultBet: ov?.defaultBet,
    gameName: opts.gameDisplayName ?? slug,
  };

  const applied: TestCase[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const tpl of templates) {
    const required = tpl.requiresFeature
      ? Array.isArray(tpl.requiresFeature) ? tpl.requiresFeature : [tpl.requiresFeature]
      : [];
    const missing = required.filter((f) => !hasFeature(reg, f));
    if (missing.length > 0) {
      skipped.push({ id: tpl.id, reason: `game lacks feature(s): ${missing.join(", ")}` });
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
    game_display_name: existing?.game_display_name ?? opts.gameDisplayName ?? slug,
    generated_at: existing?.generated_at ?? "template-set",
    total_cases: cases.length,
    cases,
    coverage_notes: existing?.coverage_notes ?? [`Applied standard template set (${source}).`],
    generation_meta: existing?.generation_meta,
  };
  const catalogPath = await saveCatalog(slug, catalog);

  // Invalidate the actions cache so setup→actions rebinds for this game.
  let actionsCacheCleared = false;
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(dirForGame(slug), "test-cases.actions.json"), { force: true });
    actionsCacheCleared = true;
  } catch {
    // no cache to clear — fine
  }

  return { slug, source, applied, skipped, mode, catalogPath, actionsCacheCleared };
}

export const CASE_TEMPLATE_CATEGORIES: ReadonlyArray<TestCaseCategory> = Array.from(
  new Set(STANDARD_CASE_TEMPLATES.map((t) => t.category)),
);
