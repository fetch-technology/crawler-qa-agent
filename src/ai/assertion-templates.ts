// Per-category assertion templates fed into the catalog EXPAND prompt.
//
// Phase 11.3 — replaces "general rules" with category-specific concrete
// examples so the AI generator produces multi-aspect assertions instead of
// 1-2 redundant variants of the same check.
//
// Templates are STATIC (no AI), versioned alongside the EXPAND prompt.
// Each template offers a concrete check_code pattern that runs against the
// runtime vocab (case-executor.ts evaluateAssertions). The EXPAND prompt
// embeds the templates that match each case's category so the AI sees
// "here's what STRONG looks like for THIS category" rather than improvising.

export type AssertionTemplate = {
  id: string;
  description: string;
  check_code: string;
};

/**
 * Templates indexed by TestCaseCategory string. Each list is a SUGGESTION
 * library — AI may pick a subset, swap field names, or compose new ones
 * inspired by the templates. Keys match TestCaseCategory enum from
 * src/ai/test-catalog.ts.
 */
export const ASSERTION_TEMPLATES_BY_CATEGORY: Record<string, AssertionTemplate[]> = {
  base_game: [
    {
      id: "base-bet-matches-default",
      description: "Server-side betAmount equals the catalog's expected_bet",
      check_code: "typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - expected_bet) <= 0.01",
    },
    {
      id: "base-win-non-negative",
      description: "winAmount is a finite non-negative number",
      check_code: "typeof spin.winAmount === 'number' && spin.winAmount >= 0",
    },
    {
      id: "base-balance-conservation",
      description: "endingBalance reflects bet/win arithmetic (skipped on first spin)",
      check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
    },
    {
      id: "base-no-setup-errors",
      description: "Setup phase produced no engine errors",
      check_code: "warnings.filter(w => /error|fail|threw/i.test(w)).length === 0",
    },
  ],

  bet_variation: [
    {
      id: "bet-amount-matches-target",
      description: "spin.betAmount equals catalog expected_bet",
      check_code: "typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - expected_bet) <= 0.01",
    },
    {
      id: "bet-ui-matches-api",
      description: "UI bet display (OCR) matches API bet — when OCR available",
      check_code: "screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01",
    },
    {
      id: "bet-balance-conservation",
      description: "Balance arithmetic holds for this bet level",
      check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01",
    },
    {
      id: "bet-no-state-disruption",
      description: "Engine remained on MAIN during bet selection (no error popup)",
      check_code: "stateTimeline.every(t => t.to === 'MAIN' || (interrupts.handled && interrupts.handled.length > 0))",
    },
  ],

  bet_boundary: [
    {
      id: "bet-clamped-at-target",
      description: "Server bet equals the floor/ceiling — undershoot/overshoot ignored",
      check_code: "typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - expected_bet) <= 0.01",
    },
    {
      id: "bet-ui-matches-clamp",
      description: "UI display reflects the clamped value (OCR cross-check)",
      check_code: "screen.bet === null || Math.abs(screen.bet - expected_bet) <= 0.01",
    },
    {
      id: "bet-clamp-no-network-errors",
      description: "Clamping happens silently — no error warnings from undershoot/overshoot attempts",
      check_code: "warnings.filter(w => /error|exception|bad request|400|500/i.test(w)).length === 0",
    },
    {
      id: "bet-clamp-balance-correct",
      description: "Balance arithmetic uses the clamped bet, not the attempted underflow value",
      check_code: "spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - expected_bet + spin.winAmount)) <= 0.01",
    },
  ],

  autoplay: [
    {
      id: "autoplay-round-count",
      description: "Captured round-end count matches the autoplay batch size",
      check_code: "getRoundEndSpins(collector.spins).length >= autoplay_n",
    },
    {
      id: "autoplay-all-ids-unique",
      description: "Every captured spin has a unique roundId",
      check_code: "new Set(collector.spins.map(s => s.id)).size === collector.spins.length",
    },
    {
      id: "autoplay-cumulative-balance",
      description: "Cumulative bet/win reconciles end-to-end",
      check_code: "(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()",
    },
    {
      id: "autoplay-no-debounced-clicks",
      description: "No spin clicks were dropped due to cascade-debounce or popup blocking",
      check_code: "warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0",
    },
  ],

  buy_feature: [
    {
      id: "buy-feature-cost-deducted",
      description: "Buy cost is a large multiple of base bet (ratio ≥ 50× typical)",
      check_code: "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()",
    },
    {
      id: "buy-feature-free-spins-triggered",
      description: "Free-spin frames observed after buy purchase",
      check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)",
    },
    {
      id: "buy-feature-state-transition",
      description: "State machine observed FREE_SPIN_TRIGGERED interrupt after purchase",
      check_code: "stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))",
    },
  ],

  free_spins: [
    {
      id: "free-spins-shape-invariant",
      description: "Every observed free spin has valid id + non-negative win",
      check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)",
    },
    {
      id: "free-spins-no-bet-deduction",
      description: "Free-spin rounds do NOT deduct bet from balance",
      check_code: "collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)",
    },
    {
      id: "free-spins-counter-monotonic",
      description: "freeSpinsRemaining counter decreases monotonically",
      check_code: "(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true && typeof s.freeSpinsRemaining === 'number'); for (let i = 1; i < fs.length; i++) { if (fs[i].freeSpinsRemaining > fs[i-1].freeSpinsRemaining) return false; } return true; })()",
    },
  ],

  ui_consistency: [
    {
      id: "ui-balance-matches-api",
      description: "OCR-read balance matches API endingBalance",
      check_code: "screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01",
    },
    {
      id: "ui-bet-matches-api",
      description: "OCR-read bet matches API betAmount",
      check_code: "screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01",
    },
    {
      id: "ui-win-matches-api",
      description: "OCR-read last win matches API winAmount",
      check_code: "screen.last_win === null || Math.abs(screen.last_win - spin.winAmount) <= 0.01",
    },
  ],

  performance: [
    {
      id: "performance-no-slow-spin-warnings",
      description: "No spin response exceeded the timeout (engine warnings clear)",
      check_code: "warnings.filter(w => /no spin.*response within|elapsed [0-9]+\\.[0-9]+s/i.test(w)).length === 0",
    },
  ],
};

/**
 * Render the templates for a given category as a markdown block suitable
 * for embedding in the EXPAND prompt. Returns empty string when the
 * category has no templates (AI falls back to general rules).
 */
export function renderTemplatesForCategory(category: string): string {
  const templates = ASSERTION_TEMPLATES_BY_CATEGORY[category];
  if (!templates || templates.length === 0) return "";
  const lines: string[] = [];
  lines.push(`### Strong-assertion templates for category="${category}"`);
  lines.push(
    "Use these as STARTING POINTS — adapt to the specific case. Aim for 3-5",
    "assertions per case covering MULTIPLE aspects (server data + UI + state +",
    "warnings + arithmetic). Avoid 2 assertions that check the same thing.",
    "",
  );
  for (const t of templates) {
    lines.push(`- id: "${t.id}"`);
    lines.push(`  description: "${t.description}"`);
    lines.push("  check_code: `" + t.check_code + "`");
  }
  return lines.join("\n");
}

/**
 * Build a combined template block for an entire PLAN (one block per
 * UNIQUE category appearing in the case stubs). Keeps prompt size
 * proportional to the variety of categories, not to total case count.
 */
export function buildTemplateBlockForPlan(categories: string[]): string {
  const unique = [...new Set(categories)];
  const blocks = unique
    .map((c) => renderTemplatesForCategory(c))
    .filter((b) => b.length > 0);
  if (blocks.length === 0) return "";
  return [
    "=== PER-CATEGORY ASSERTION TEMPLATES ===",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
