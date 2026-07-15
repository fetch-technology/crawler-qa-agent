import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractJsonFromText } from "./claude.js";
import { catalogCall, chunkStubs, mergeExpandedBatches, mapLimit } from "./catalog-llm.js";
import type { GameSpec } from "./authoring.js";
import { extractStructuredFromConfig, structuredConfigToMarkdown } from "./config-extract.js";
import {
  validateCatalog,
  formatValidationReport,
  type ValidationReport,
} from "./catalog-validator.js";
import { evaluateCoverage } from "./catalog-coverage-rules.js";

const BEST_PRACTICES_PATH = "docs/test-case-best-practices.md";

/**
 * Load best practices doc as authoritative grounding cho LLM.
 * Doc này định nghĩa shape, categories, invariants, anti-patterns —
 * bắt buộc inject vào MỌI catalog gen để output consistent qua mọi game.
 */
function loadBestPractices(): string | null {
  for (const candidate of [BEST_PRACTICES_PATH, join(process.cwd(), BEST_PRACTICES_PATH)]) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {}
    }
  }
  return null;
}

export type TestCaseCategory =
  | "base_game"
  | "bet_variation"
  | "bet_level"
  | "bet_boundary"
  | "autoplay"
  | "buy_feature"
  | "special_bet"
  | "turbo_spin"
  | "free_spins"
  | "respin"
  | "history"
  | "options"
  | "max_win_cap"
  | "ui_consistency"
  | "rules_consistency"
  | "payout_correctness"
  | "wild_substitution"
  /** Spin response time SLO check (default <500ms p95). Universal — emit always. */
  | "performance"
  /** Game logic/config version capture (cver/sver fields). Universal. */
  | "meta"
  | "other";

export type TestCase = {
  id: string;                           // kebab-case, unique within catalog
  name: string;                         // display name 1 dòng
  description: string;                  // chi tiết test gì
  category: TestCaseCategory;
  severity: "critical" | "major" | "minor";

  setup_instructions: string;           // natural-language cho AI setup driver
  expected_bet?: number | null;         // sau setup, betAmount kỳ vọng
  expected_config?: Record<string, unknown>;

  spin_count: number;                   // số spin cần chạy
  expected_feature?: string | null;     // e.g. "free_spins_triggered"

  invariant_ids?: string[];             // GameSpec invariants áp dụng (default: all critical+major)
  custom_assertions?: Array<{
    id: string;
    description: string;
    check_code: string;                 // JS expr, `collector` and spin vars available
  }>;

  // Phase 8.4 — adaptive runner support
  /** Observed states (e.g., FREE_SPIN_TRIGGERED, BIG_WIN_POPUP) that may
   *  interrupt this case but should NOT cause failure. Runner dispatches
   *  matching interrupt handler, then resumes main flow. Default: all
   *  popup states (free spin, big win, paytable, etc.) allowed. */
  allowed_interruptions?: string[];

  /** What runner does when an allowed_interruption fires:
   *   - "handle_and_continue" (default): run handler, continue main scenario
   *   - "skip_and_rerun": mark INCONCLUSIVE, schedule rerun
   *   - "fail": treat interrupt as test failure */
  on_feature_triggered?: "handle_and_continue" | "skip_and_rerun" | "fail";

  /** Optional retry policy when case yields INCONCLUSIVE / FAIL_LOW. */
  retry_policy?: {
    maxRetries?: number;                 // Default 3
    retryWhen?: string[];                // Outcome values that trigger retry
  };

  /** Minimum evidence requirement — used by confidence scorer. */
  minimum_evidence?: {
    required?: string[];                 // signal names that MUST be present
    optional?: string[];                 // signals that boost confidence
    passConfidenceThreshold?: number;    // default 0.85
    failConfidenceThreshold?: number;    // default 0.85
  };
};

export type TestCaseCatalog = {
  game_slug: string;
  game_display_name: string;
  generated_at: string;
  total_cases: number;
  cases: TestCase[];
  coverage_notes: string[];
  /** Provenance: track inputs used to generate this catalog (for UI context view). */
  generation_meta?: {
    inputs_used: string[];                // e.g. ["rules_md", "structured_config", "raw_config", "options_json", "spin_samples", "paytable_pages"]
    rules_chars: number;
    config_keys_top: string[];
    paytable_symbols_count: number;
    bet_sizes_count: number;
    features_count: number;
    sample_spin_count: number;
    plan_categories: string[];
    elapsed_ms?: number;
  };
};

// Shared system preamble for BOTH PLAN and EXPAND so the cached prefix
// (preamble + sourceBlock) is byte-identical across all catalog calls →
// PLAN primes the cache, every EXPAND batch reads it. Task-specific framing
// (plan vs expand) lives in the user directive.
const SYSTEM_PREAMBLE =
  "You are a senior QA engineer specializing in slot games. You analyze rules, config, and observed behavior to design and expand comprehensive test cases with precise setup_instructions and runnable assertion expressions. Output ONLY valid JSON — no prose, no markdown fences.";

type CaseStub = {
  id: string;
  name: string;
  category: TestCaseCategory;
  severity: "critical" | "major" | "minor";
  description: string;
  spin_count: number;
  expected_feature?: string | null;
  rationale: string; // why this case matters for THIS game
};

type PlanResponse = {
  cases: CaseStub[];
  coverage_notes: string[];
};

function normalizeRngDependentAssertion(
  category: TestCaseCategory,
  expr: string,
): { normalized: string; changed: boolean } {
  const src = expr.trim();

  // Buy feature flow deterministically triggers FS when purchase succeeds.
  // Keep strong existence assertion for this category.
  if (category === "buy_feature") {
    return { normalized: src, changed: false };
  }

  // Anti-pattern: require rare event MUST happen in a finite organic watch.
  // Replace by shape/type invariant that is RNG-independent.
  const requireFsObserved =
    /collector\.spins\.some\(\s*s\s*=>\s*s\.isFreeSpin\s*===\s*true\s*\)/.test(src) ||
    /collector\.spins\.filter\([^)]*isFreeSpin[^)]*\)\.length\s*>\s*0/.test(src);
  if (requireFsObserved) {
    return {
      normalized:
        "collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)",
      changed: true,
    };
  }

  const requireAnyWinObserved =
    /collector\.spins\.some\([^)]*winAmount[^)]*>\s*0/.test(src) ||
    /collector\.spins\.filter\([^)]*winAmount[^)]*>\s*0[^)]*\)\.length\s*>\s*0/.test(src);
  if (requireAnyWinObserved) {
    return {
      normalized:
        "collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0 && typeof s.betAmount === 'number' && s.betAmount > 0)",
      changed: true,
    };
  }

  return { normalized: src, changed: false };
}

function normalizeAssertionsForRngIndependence(cases: TestCase[]): TestCase[] {
  let changedCount = 0;
  const out = cases.map((c) => {
    const assertions = (c.custom_assertions ?? []).map((a) => {
      const n = normalizeRngDependentAssertion(c.category, a.check_code);
      if (!n.changed) return a;
      changedCount++;
      return {
        ...a,
        description: `${a.description} (normalized to RNG-independent invariant)`,
        check_code: n.normalized,
      };
    });
    return { ...c, custom_assertions: assertions };
  });
  if (changedCount > 0) {
    console.warn(
      `[catalog] normalized ${changedCount} custom_assertion(s) to RNG-independent form`,
    );
  }
  return out;
}

type OptionLike = {
  name?: string;
  category?: string;
  current_value?: unknown;
  possible_values?: unknown;
  description?: string | null;
};

function parseOptionsFromJson(optionsJson: string | null): OptionLike[] {
  if (!optionsJson) return [];
  try {
    const parsed = JSON.parse(optionsJson) as { options?: OptionLike[] };
    return Array.isArray(parsed?.options) ? parsed.options : [];
  } catch {
    return [];
  }
}

function parseNumericToken(s: string): number | null {
  const cleaned = s.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractSpecialBetAmounts(options: OptionLike[]): number[] {
  const out: number[] = [];
  for (const o of options) {
    const name = String(o.name ?? "");
    if (!/special\s*bet|ante|super\s*spin|double\s*chance/i.test(name)) continue;
    const desc = String(o.description ?? "");
    const m = desc.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/g) ?? [];
    for (const token of m) {
      const n = parseNumericToken(token);
      if (n != null && n > 0) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function extractBaseBetMax(options: OptionLike[]): number | null {
  for (const o of options) {
    const name = String(o.name ?? "");
    if (!/bet\s*size|bet$/i.test(name)) continue;
    if (!Array.isArray(o.possible_values)) continue;
    const vals = (o.possible_values as unknown[])
      .map((v) => (typeof v === "number" ? v : parseNumericToken(String(v))))
      .filter((n): n is number => n != null && n > 0);
    if (vals.length > 0) return Math.max(...vals);
  }
  return null;
}

function annotateSpecialBetSetupHints(cases: TestCase[], optionsJson: string | null): TestCase[] {
  const options = parseOptionsFromJson(optionsJson);
  const specialAmts = extractSpecialBetAmounts(options);
  const baseMax = extractBaseBetMax(options);
  if (specialAmts.length === 0 || baseMax == null) return cases;

  return cases.map((c) => {
    const expected = typeof c.expected_bet === "number" ? c.expected_bet : null;
    if (expected == null || expected <= baseMax) return c;
    const matchesSpecial = specialAmts.some((v) => Math.abs(v - expected) <= Math.max(0.06, expected * 0.005));
    if (!matchesSpecial) return c;

    const lower = `${c.setup_instructions ?? ""}`.toLowerCase();
    if (lower.includes("special bet") || lower.includes("ante") || lower.includes("super spin")) {
      return c;
    }
    const extra =
      ` Special-bet context: target ${expected} is above base bet max ${baseMax}. ` +
      `Open the Special Bets/Ante panel and choose the option priced ${expected}, then verify that special mode is active before spin.`;
    const setup = `${c.setup_instructions ?? ""}${extra}`.trim();
    const expectedConfig = {
      ...(c.expected_config ?? {}),
      requires_special_bet_mode: true,
      special_bet_target: expected,
      base_bet_max_observed: baseMax,
    } as Record<string, unknown>;
    return { ...c, setup_instructions: setup, expected_config: expectedConfig };
  });
}

export const ASSERTION_VARS_DOC = `Variables available in check_code expressions:

DATA (always bound):
- spin: current SpinResponse (or null for UI-only cases). Normalized fields ONLY: betAmount, winAmount, endingBalance, startingBalance, status, id, round, currency, isFreeSpin, isEndRound, matrix, state, freeSpinsRemaining.
  ⚠ freeSpinsRemaining DIRECTION IS PROVIDER-SPECIFIC: on Pragmatic it counts
  UP (it is the spin INDEX within the chain, 1→N), on others it counts DOWN
  (true remaining). NEVER assert one direction ("decreases monotonically" =
  guaranteed false-FAIL on PP). If you check counter sanity, accept EITHER
  consistent direction (all-non-decreasing OR all-non-increasing).
- previousSpin: null (placeholder, unused — use collector.spins[i-1] if you need previous).
- collector: { spins: SpinResponse[] } — ALL captured spins of this case (post cascade-dedup).
- spinIndex: number — collector.spins.length - 1 (last spin index).
- balanceBefore: number | null — wallet balance captured BEFORE the test's first spin.

HELPERS (always bound, pure):
- getRoundEndSpins(spins): filter spins to round-end frames only. Strategy:
  isEndRound=true → those; else group by round/roundId/id → last per group; else all.
- getCurrentBalance(collector): number | null — latest endingBalance from collector, or null.
- detectBuyFeatureDeduction(spins, startIndex, balanceBefore):
  returns { deduction, baseBet, ratio, spin } or null. Use for buy-feature cost checks.
  Example: \`(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()\`
- sumWinBreakdown(spin): Σ of the spin's per-combo wins (winBreakdown). Pair with
  s.serverTotalWin for payout-integrity. Example: \`Math.abs(sumWinBreakdown(spin) - spin.serverTotalWin) <= 0.01\`
- comboWellFormed(combo): true if a winBreakdown combo is structurally sound
  (finite win ≥ 0, ≥1 position, count ≤ positions). Mechanic-agnostic.
  Example: \`(spin.winBreakdown||[]).every(c => comboWellFormed(c))\`
- distinctReels(positions, gridHeight): # distinct reel columns the positions
  touch (column-major). For a WAYS combo this should equal combo.count.
  Example (ways): \`(spin.winBreakdown||[]).every(c => distinctReels(c.positions, gridHeight) === c.count)\`
- clusterConnected(positions, gridWidth, gridHeight): true if positions form ONE
  4-connected region — the defining property of a CLUSTER pay. (Uniform reel
  height; treat as a hint on Megaways.)
  Example (cluster): \`(spin.winBreakdown||[]).filter(c => c.type === 'cluster').every(c => clusterConnected(c.positions, gridWidth, gridHeight))\`
- gridWidth / gridHeight: reel grid dimensions for the captured spin (null if
  unknown — always null-guard before passing to the geometry helpers above).

UI / OCR (Phase 11.2 — bound for ALL categories, not just ui_consistency):
- screen: { balance: number|null, bet: number|null, last_win: number|null, total_win: number|null }.
  Each field can be null if OCR didn't read it for this case. ALWAYS null-guard before using.
  Example: \`screen.bet === null || Math.abs(screen.bet - 0.20) <= 0.01\`

ENGINE STATE (Phase 11.2 — observe runtime behavior):
- stateTimeline: Array<{ at: ISO, from?: string, to: string, via?: string }>.
  Each entry = state transition observed by the state-machine runner.
  Example "stayed on MAIN throughout": \`stateTimeline.every(t => t.to === 'MAIN')\`
  Example "free spin triggered + handled": \`stateTimeline.some(t => t.to === 'FREE_SPIN_TRIGGERED')\`
- warnings: string[] — non-fatal warnings emitted during the run (popup retries,
  spin-count mismatches, "no response within Xs" timeouts, debounced clicks).
  Example "no setup errors": \`warnings.filter(w => /error|fail/i.test(w)).length === 0\`
  Example "no lost spins": \`warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0\`
- interrupts: { count: number, handled: string[] }.
  count = how many allowed interruptions the runner dispatched.
  handled = ["MAIN→FREE_SPIN_TRIGGERED", ...] short transition labels.
  Example: \`interrupts.count === 0\` (assert NO interrupts during a strict-normal case)
- networkBalance: number | null — balance read from the network response field
  (alternative source vs spin.endingBalance for cross-check).

FORBIDDEN:
- _raw or provider-specific fields like "tw", "w", "c", "sa", "sb"
- Mutating any bound variable (read-only contract).

ASSERTION DESIGN PRINCIPLES (multi-aspect):
- Each assertion should check ONE specific aspect; aim for 3-5 assertions per case
  covering DIFFERENT aspects: server data + UI consistency + state transition +
  engine warnings + arithmetic. The runtime confidence engine attaches signals
  based on which vars your check_code references (api/ui_ocr/state/network/rule).
- Avoid redundancy: don't ship two assertions that both check \`spin.betAmount\`.
  Prefer one bet check + one balance check + one screen.bet check + one warnings
  check + one stateTimeline check.`;

function buildSourceBlock(args: {
  gameSpec: GameSpec;
  rulesMarkdown: string;
  optionsJson: string | null;
  configResponse: unknown | null;
  paytableMarkdown: string | null;
  sampleSpinResponses: unknown[];
  auxiliarySources?: {
    paytableMd: string | null;
    infoMd: string | null;
    buyOptionsMd: string | null;
    specialBetsMd: string | null;
    paytableJson: unknown | null;
    rulesJson: unknown | null;
  } | null;
  ocrCoverage?: {
    balanceArea: boolean;
    betArea: boolean;
    winArea: boolean;
    freeSpinCounter: boolean;
  } | null;
}): { block: string; meta: TestCaseCatalog["generation_meta"] } {
  const { gameSpec, rulesMarkdown, optionsJson, configResponse, paytableMarkdown, sampleSpinResponses, auxiliarySources, ocrCoverage } = args;

  const inputs_used: string[] = [];
  const parts: string[] = [];

  // --- Best Practices (AUTHORITATIVE — first so LLM treats as priority) ---
  const bestPractices = loadBestPractices();
  if (bestPractices) {
    parts.push("=== BEST PRACTICES (AUTHORITATIVE — MUST FOLLOW for every test case) ===");
    parts.push(bestPractices);
    parts.push("=== END BEST PRACTICES ===");
    inputs_used.push("best_practices_md");
  }

  // --- GameSpec ---
  parts.push("\n=== GAME SPEC (derived invariants, features, symbols) ===");
  parts.push(JSON.stringify(gameSpec, null, 2));
  inputs_used.push("game_spec");

  // --- Structured config (parsed) ---
  let structured: ReturnType<typeof extractStructuredFromConfig> | null = null;
  if (configResponse) {
    structured = extractStructuredFromConfig(configResponse);
    parts.push("\n=== STRUCTURED CONFIG (parsed from raw API response — TRUSTED SOURCE) ===");
    parts.push(structuredConfigToMarkdown(structured));
    inputs_used.push("structured_config");
  }

  // --- Raw config (truncated, for fields parser missed) ---
  // Trước đây dump full JSON (có khi >50KB) → CLI stdin/stdout pipe truncate
  // gây "JSON Parse error: Unterminated string". Giờ cap 20KB; structured
  // config trên đã có data quan trọng. Override qua QA_RAW_CONFIG_MAX_CHARS.
  if (configResponse) {
    const maxChars = Number(process.env.QA_RAW_CONFIG_MAX_CHARS ?? 20000);
    const fullRaw = JSON.stringify(configResponse, null, 2);
    const truncated = fullRaw.length > maxChars
      ? fullRaw.slice(0, maxChars) + `\n\n... [truncated ${fullRaw.length - maxChars} chars — raw config too large for prompt; rely on STRUCTURED CONFIG above for trusted data]`
      : fullRaw;
    parts.push("\n=== RAW CONFIG RESPONSE (capped " + maxChars + " chars) ===");
    parts.push(truncated);
    inputs_used.push("raw_config");
  }

  // --- Rules ---
  parts.push("\n=== TRANSCRIBED RULES ===");
  parts.push(rulesMarkdown);
  inputs_used.push("rules_md");

  // --- Deep-extracted INFO popup (in-game rules / RTP / mechanics — Vision +
  //     OCR from infoButton popup). TRUSTED — direct from game's official spec.
  if (auxiliarySources?.infoMd) {
    parts.push("\n=== IN-GAME INFO POPUP (Vision+OCR transcription — AUTHORITATIVE) ===");
    parts.push(auxiliarySources.infoMd);
    inputs_used.push("deep_info_md");
  }
  if (auxiliarySources?.rulesJson) {
    parts.push("\n=== IN-GAME RULES (structured JSON from info popup) ===");
    parts.push(JSON.stringify(auxiliarySources.rulesJson, null, 2));
    inputs_used.push("deep_rules_json");
  }

  // --- Paytable pages: prefer deep-extracted (in-game paytable popup) over
  //     legacy fallback paytableMarkdown. Auxiliary takes precedence.
  if (auxiliarySources?.paytableMd) {
    parts.push("\n=== PAYTABLE POPUP (Vision+OCR transcription — AUTHORITATIVE) ===");
    parts.push(auxiliarySources.paytableMd);
    inputs_used.push("deep_paytable_md");
  } else if (paytableMarkdown) {
    parts.push("\n=== PAYTABLE PAGES (transcribed from in-game info modal) ===");
    parts.push(paytableMarkdown);
    inputs_used.push("paytable_pages");
  }
  if (auxiliarySources?.paytableJson) {
    parts.push("\n=== PAYTABLE (structured JSON — symbol id → multiplier table) ===");
    parts.push(JSON.stringify(auxiliarySources.paytableJson, null, 2));
    inputs_used.push("deep_paytable_json");
  }

  // --- Buy bonus options (cost + effect per option) ---
  if (auxiliarySources?.buyOptionsMd) {
    parts.push("\n=== BUY FEATURE OPTIONS (Vision+OCR from buy popup — cost & effect per option) ===");
    parts.push(auxiliarySources.buyOptionsMd);
    inputs_used.push("deep_buy_options_md");
  }

  // --- Special bets (ante / double chance / etc.) ---
  if (auxiliarySources?.specialBetsMd) {
    parts.push("\n=== SPECIAL BETS (Vision+OCR — ante / double-chance / etc.) ===");
    parts.push(auxiliarySources.specialBetsMd);
    inputs_used.push("deep_special_bets_md");
  }

  // --- Options catalog ---
  if (optionsJson) {
    parts.push("\n=== OPTIONS CATALOG (UI controls extracted from play screen) ===");
    parts.push(optionsJson);
    inputs_used.push("options_json");
  }

  // --- OCR Coverage for this game (per-game runtime capability) ---
  // Tells AI which `screen.X` fields actually have OCR bbox configured.
  // Without this, AI defensively emits null-guarded `screen.X` assertions
  // for every UI consistency case; for unconfigured regions, these assertions
  // silent-pass at runtime (provide no real coverage). With this block, AI
  // can focus UI assertions on REAL coverage and skip the rest.
  if (ocrCoverage) {
    parts.push("\n" + renderOcrCoverageBlock(ocrCoverage));
    inputs_used.push("ocr_coverage");
  }

  // --- Spin samples (cap 30KB total) ---
  // Limit số sample để tránh bùng nổ kích thước. 3 sample đủ cho LLM hiểu
  // shape; thêm nữa chỉ tăng noise. Override qua QA_SPIN_SAMPLES_MAX.
  const maxSamples = Number(process.env.QA_SPIN_SAMPLES_MAX ?? 3);
  const limitedSamples = sampleSpinResponses.slice(0, maxSamples);
  parts.push("\n=== SAMPLE SPIN RESPONSES (normalized, " + limitedSamples.length + "/" + sampleSpinResponses.length + ") ===");
  parts.push(JSON.stringify(limitedSamples, null, 2));
  inputs_used.push("spin_samples");

  // --- Final size guard ---
  // Tổng source block PHẢI dưới ngưỡng để Claude CLI IPC pipe không truncate.
  // 200KB là conservative — thực tế CLI fail tại ~80KB của 1 message.
  // Override qua QA_SOURCE_BLOCK_MAX.
  let block = parts.join("\n");
  const maxBlock = Number(process.env.QA_SOURCE_BLOCK_MAX ?? 150000);
  if (block.length > maxBlock) {
    console.warn(
      `[catalog] source block ${block.length} chars exceeds cap ${maxBlock} — truncating tail. Consider raising QA_SOURCE_BLOCK_MAX or trimming raw_config / rules.`,
    );
    block =
      block.slice(0, maxBlock) +
      `\n\n... [SOURCE BLOCK TRUNCATED — ${block.length - maxBlock} chars dropped to fit CLI pipe limit. Earlier sections (best_practices, game_spec, structured_config) are intact.]`;
  }

  return {
    block,
    meta: {
      inputs_used,
      rules_chars: rulesMarkdown.length,
      config_keys_top: structured?.raw_keys_top ?? [],
      paytable_symbols_count: structured?.paytable.length ?? 0,
      bet_sizes_count: structured?.bet_table?.sizes?.length ?? 0,
      features_count: structured?.features.length ?? 0,
      sample_spin_count: sampleSpinResponses.length,
      plan_categories: [],
    },
  };
}

/**
 * Render per-game OCR coverage as a markdown block for the EXPAND prompt.
 * Exposed for invariant tests.
 *
 * The output tells AI which `screen.X` fields actually have OCR bbox saved
 * in registry/ocr-regions.json — so it doesn't generate `screen.bet`
 * assertions for a game without a betArea bbox (those would silent-pass at
 * runtime, polluting catalog with no-op assertions).
 */
export function renderOcrCoverageBlock(
  coverage: { balanceArea: boolean; betArea: boolean; winArea: boolean; freeSpinCounter: boolean },
): string {
  const map: Array<{ key: keyof typeof coverage; field: string; configured: boolean }> = [
    { key: "balanceArea", field: "screen.balance", configured: coverage.balanceArea },
    { key: "betArea", field: "screen.bet", configured: coverage.betArea },
    { key: "winArea", field: "screen.last_win", configured: coverage.winArea },
    { key: "freeSpinCounter", field: "screen.free_spins (informational)", configured: coverage.freeSpinCounter },
  ];
  const lines: string[] = [];
  lines.push("=== OCR COVERAGE FOR THIS GAME ===");
  lines.push("");
  lines.push("Tells you which `screen.X` runtime variables actually receive OCR data");
  lines.push("for this specific game. The list below reflects whether a bbox is");
  lines.push("currently saved in fixtures/registry/<slug>/ocr-regions.json.");
  lines.push("");
  for (const m of map) {
    const icon = m.configured ? "✓" : "✗";
    const note = m.configured
      ? "→ OCR runs at end of each spin; `${field}` will be a number"
      : "→ no bbox saved; `${field}` will ALWAYS be null at runtime";
    lines.push(`- ${icon} ${m.key} (binds ${m.field}): ${note.replace("${field}", m.field)}`);
  }
  const anyConfigured = map.some((m) => m.configured);
  const allConfigured = map.every((m) => m.configured);
  lines.push("");
  lines.push("CRITICAL RULES (apply to assertion generation):");
  if (!anyConfigured) {
    lines.push("1. NO OCR regions configured for this game. Do NOT generate any");
    lines.push("   `screen.X` assertions — they would silent-pass via null-guard");
    lines.push("   and provide zero coverage. Use server-data assertions only");
    lines.push("   (spin.betAmount, spin.endingBalance, etc.).");
    lines.push("2. Skip the `ui_consistency` category entirely for this game (no");
    lines.push("   OCR data available to verify UI display drift).");
  } else if (allConfigured) {
    lines.push("1. ALL key OCR regions configured. For `ui_consistency` cases AND");
    lines.push("   `bet_variation`/`bet_boundary`/`base_game` cases, INCLUDE at least");
    lines.push("   ONE `screen.X` assertion per case. The null-guard pattern is");
    lines.push("   still required (OCR may transiently fail), but the assertion");
    lines.push("   WILL credit ui_ocr signal at runtime → higher confidence.");
    lines.push("2. Spread across the 3 widgets: balance check (most cases), bet");
    lines.push("   check (bet_variation/bet_boundary), win check (cases where a");
    lines.push("   win is expected). Don't ship 3 screen.X assertions per case");
    lines.push("   — diminishing returns and bloats catalog.");
  } else {
    const configured = map.filter((m) => m.configured).map((m) => m.field).join(", ");
    const missing = map.filter((m) => !m.configured).map((m) => m.field).join(", ");
    lines.push(`1. PARTIAL coverage: ${configured} configured, ${missing} NOT.`);
    lines.push(`2. ONLY emit assertions referencing the CONFIGURED fields:`);
    lines.push(`   ${configured}.`);
    lines.push("3. NEVER reference the unconfigured fields in check_code — they");
    lines.push("   would silent-pass at runtime via null-guard and pollute the");
    lines.push("   catalog with no-op UI assertions.");
  }
  return lines.join("\n");
}

function runFullValidation(args: {
  cases: TestCase[];
  gameSpec: GameSpec;
  optionsJson: string | null;
  coverageNotes: string[];
}): ValidationReport {
  const tempCatalog: TestCaseCatalog = {
    game_slug: args.gameSpec.game_code,
    game_display_name: args.gameSpec.game_display_name,
    generated_at: new Date().toISOString(),
    total_cases: args.cases.length,
    cases: args.cases,
    coverage_notes: args.coverageNotes,
  };
  const report = validateCatalog(tempCatalog, args.gameSpec);
  const coverageIssues = evaluateCoverage({
    catalog: tempCatalog,
    spec: args.gameSpec,
    optionsJson: args.optionsJson,
  });
  for (const issue of coverageIssues) {
    if (issue.severity === "error") report.errors.push(issue);
    else report.warnings.push(issue);
  }
  report.ok = report.errors.length === 0;
  return report;
}

export async function generateTestCaseCatalog(args: {
  gameSpec: GameSpec;
  rulesMarkdown: string;
  optionsJson: string | null;
  sampleSpinResponses: unknown[];
  configResponse?: unknown | null;
  paytableMarkdown?: string | null;
  auxiliarySources?: {
    paytableMd: string | null;
    infoMd: string | null;
    buyOptionsMd: string | null;
    specialBetsMd: string | null;
    paytableJson: unknown | null;
    rulesJson: unknown | null;
  } | null;
  /** Per-game OCR coverage. When provided, EXPAND prompt gets a block listing
   *  which screen fields (balance/bet/last_win/freeSpinCounter) actually have
   *  bbox configured, so AI doesn't generate `screen.X` assertions for
   *  unconfigured fields (they would silent-pass at runtime). */
  ocrCoverage?: {
    balanceArea: boolean;
    betArea: boolean;
    winArea: boolean;
    freeSpinCounter: boolean;
  } | null;
}): Promise<TestCaseCatalog> {
  const { gameSpec } = args;
  const t0 = Date.now();

  const { block: sourceBlock, meta } = buildSourceBlock({
    gameSpec,
    rulesMarkdown: args.rulesMarkdown,
    optionsJson: args.optionsJson,
    configResponse: args.configResponse ?? null,
    paytableMarkdown: args.paytableMarkdown ?? null,
    sampleSpinResponses: args.sampleSpinResponses,
    auxiliarySources: args.auxiliarySources ?? null,
    ocrCoverage: args.ocrCoverage ?? null,
  });

  // ===== STEP 1: PLAN =====
  console.log(`[catalog] Step 1/2: planning test outline (${meta?.inputs_used.join("+")})...`);
  const planPrompt = `Design a comprehensive test PLAN for slot game "${gameSpec.game_display_name}" (code=${gameSpec.game_code}).

You will produce ONLY case stubs (id, name, category, severity, brief description, spin_count, expected_feature, rationale).
Setup instructions and assertion code will be expanded in a SECOND pass.

(Game sources — best practices, spec, config, paytable, options, OCR coverage, spin samples — are provided in the SYSTEM context above. Refer to them as "the sources".)

RECOMMENDED COVERAGE (skip a category only if game truly does not have that feature based on the sources):

CORE COVERAGE (universal):
1. **base_game**: 2-3 cases at default bet → balance conservation, response shape, multi-spin integrity
2. **bet_variation**: 4-6 cases at min / 25% / mid / 75% / max bet → betAmount reflects, derived from STRUCTURED CONFIG bet_table when available
3. **bet_level** (if bet_table.levels exists separately): 2 cases varying level
4. **bet_boundary**: 2 cases — try setting bet ABOVE max (must be rejected/clamped), try setting bet BELOW min (must be rejected). Cite spec.bet_mechanics range.
5. **autoplay**: 2-3 cases — small N (5-10), medium N (25), with stop-on-win condition if game offers one
6. **buy_feature** (if buy feature visible): 1 case per buy option (super, regular, ante, etc.) — verify deduction & free spin chain
7. **special_bet** (if ante/double chance/special bets visible): 1 per variant → higher trigger rate
8. **turbo_spin**: 1 case if turbo control visible
9. **history**: 1-2 cases — open history panel, verify rows match spins
10. **max_win_cap** (if cap exists in config): 1 case checking cap logic
11. **options / settings**: 1-2 cases for non-game UI (sound toggle, settings open)

ADVANCED VERIFICATION (Best Practices §18 — see doc for full pattern):
12. **rules_consistency**: 1-2 cases — assert spec.symbols ↔ paytable.symbols ↔ config.symbols match (id + code + type). Detects template mismatches (vd config.code='fortune-mouse-two' khi game là fortune-pig).
13. **payout_correctness**: 1-2 cases — for each observed winline, assert winAmount === baseBet × betSize × betLevel × payTable[symbolId].multiple[sameItem]. Use \`config.payTable\` (from /config response) + \`spin.result.winlines[]\`. **CRITICAL** — currently catalog only checks balance arithmetic, NOT payout correctness vs paytable.
14. **wild_substitution**: 1 case — when matrix contains WILD symbol (id=0 trong RG schema), and a winline includes that position, assert WILD substituted correctly (winAmount uses replaced symbol's multiplier, not WILD's own). Organic-watch nếu RNG không steerable.
15. **free_spins** SPLIT into 2:
    - **free-spins-trigger-watch**: organic 60-spin watch. Khi \`isFreeSpin=true\` first observed, assert TRIGGER condition: matrix tại spin trước đó có ≥3 SCATTER (id=1) symbol. Verify count khớp với rules.
    - **free-spins-result-shape**: với mỗi spin có \`isFreeSpin=true\`, assert \`betAmount=0\`, \`winAmount\` consistent với paytable, \`freeSpins\` counter giảm đúng.
16. **respin** (new category — split from old "other"):
    - **respin-trigger-watch**: organic watch. Khi \`multiplier > 1\` hoặc respin field xuất hiện (vd \`fortuneTigerMultiplier\` > 1), assert matrix có Wild stacked theo cơ chế game.
    - **respin-result-multiplier**: khi respin triggered, verify \`winAmount === base_win × multiplier\`.
17. **history** SPLIT into 2:
    - **history-normal-bet**: 5 base spin → mở history → mỗi row khớp bet, win, balance_after, time với samples.
    - **history-freespin-row**: sau free spin chain → mở history → row free spin có flag/tag riêng (FS), distinct với normal bet rows.

18. **ui_consistency**: 2-3 cases — verify on-screen DISPLAY matches API response. The harness has \`readScreenValues(page)\` (vision OCR of balance/bet/last_win) + \`assertScreenMatchesAPI(spin, screen)\`. Examples:
    - "balance-display-after-spin": after 1 normal spin, verify balance display = spin.endingBalance
    - "bet-display-reflects-config": after changing bet to a specific amount, verify UI bet text matches selected betAmount
    - "win-display-after-winning-spin": after a winning spin, verify last_win display = spin.winAmount (only if you can ENGINEER a winning spin — usually skip if game RNG can't be steered)
    - "balance-after-multi-spin": run N spins, verify final balance = initial - sum(bet) + sum(win)

Return ONLY JSON:
{
  "cases": [
    {
      "id": "kebab-case-unique",
      "name": "One-line display name",
      "category": "base_game" | "bet_variation" | "bet_level" | "autoplay" | "buy_feature" | "special_bet" | "turbo_spin" | "free_spins" | "history" | "options" | "max_win_cap" | "performance" | "meta" | "other",
      "severity": "critical" | "major" | "minor",
      "description": "1-2 sentences what this tests",
      "spin_count": number,
      "expected_feature": string | null,
      "rationale": "why this case matters for THIS specific game (cite specific config/rules evidence)"
    }
  ],
  "coverage_notes": [
    "what is INCLUDED",
    "what is INTENTIONALLY NOT covered (and why — game limitation, no feature)"
  ]
}

Rules:
- Total cases: at least 12, up to 40. Prefer breadth, then depth.
- **Each rationale MUST cite specific evidence with SOURCE FILE prefix**: \`spec:\` for spec.json, \`paytable:\`, \`options:\`, \`samples:\`, \`play-screen:\`. Example: "spec: bet_mechanics.bet_sizes shows [0.01, 0.02, 0.5, 1] — needs min/max/mid coverage". Vague rationales without prefix → REJECTED.
- Categories not relevant → OMIT entirely (NO placeholder content).
- Severity (per Best Practices §9): critical = money integrity, major = feature correctness, minor = UX.
- **Refer Best Practices §5 for category presence rules and §10 for minimum count per game variant**. Universal categories (base_game ≥3, ui_consistency ≥2) MUST be present.
- **Reject anti-patterns from Best Practices §15** — do NOT plan cases that:
  - assert config.code === game_slug (provider templates often differ)
  - require strict free_spins counts (organic watch only, expected_feature=null)
  - rely on paytable.json for payout values (use spec.symbols)
  - hardcode currency from UI text (use spec.currency)

**Required UNIVERSAL categories — emit for every game:**
- \`performance\` — 1 case "spin-response-time-slo": assert per-spin response < 500ms p95.
- \`meta\` — 1 case "logic-version-captured": assert response contains cver/sver/ver field for QA traceability.

NOTE on multi-currency / multi-environment:
Each task in this system represents ONE game URL = ONE currency = ONE environment. Do NOT plan per-currency or per-environment cases — multi-currency testing is done by creating multiple tasks (one per currency URL) or using \`npm run stats:currency-batch\`. Catalog stays single-environment.

Output ONLY the JSON.`;

  const planRes = await catalogCall({
    // sourceBlock cached → primes the prefix reused by every EXPAND batch.
    system: [{ text: SYSTEM_PREAMBLE }, { text: sourceBlock, cache: true }],
    user: [{ text: planPrompt }],
    maxTokens: Number(process.env.QA_CATALOG_PLAN_MAX_TOKENS ?? 16_384),
    label: "catalog/PLAN",
    timeoutMs: Number(process.env.QA_CATALOG_PLAN_TIMEOUT_MS ?? process.env.QA_CLAUDE_TIMEOUT_MS ?? 360_000),
  });
  const plan = extractJsonFromText<PlanResponse>(planRes.text);
  if (!plan || !Array.isArray(plan.cases) || plan.cases.length === 0) {
    throw new Error(`generateTestCaseCatalog: PLAN step parse failed. Raw:\n${planRes.text.slice(0, 500)}`);
  }
  console.log(`[catalog] Step 1/2 ✔ ${plan.cases.length} case stubs planned`);
  const planCategories = Array.from(new Set(plan.cases.map((c) => c.category)));
  if (meta) meta.plan_categories = planCategories;

  // ===== STEP 2: EXPAND (chunked + parallel) =====
  // Phase 11.3 — per-category assertion templates injected per batch (only the
  // categories present in that batch). Phase: chunked EXPAND — instead of one
  // call expanding all 30-40 stubs (attention dilution + truncation risk), nở
  // theo batch nhỏ song song. sourceBlock + static rules are cached
  // (catalog-llm cache_control) so re-sending per batch is cheap.
  const { buildTemplateBlockForPlan } = await import("./assertion-templates.js");
  const BATCH_SIZE = Math.max(1, Number(process.env.QA_CATALOG_BATCH_SIZE ?? 7));
  // Default 2: when caching is unavailable (OAuth-only → askClaude subprocess
  // fallback), high parallelism spawns many Claude Code subprocesses at once
  // and risks rate-limits. With a real ANTHROPIC_API_KEY you can raise this.
  const CONCURRENCY = Math.max(1, Number(process.env.QA_CATALOG_CONCURRENCY ?? 2));
  const EXPAND_MAX_TOKENS = Number(process.env.QA_CATALOG_EXPAND_MAX_TOKENS ?? 8_192);
  const EXPAND_TIMEOUT_MS = Number(process.env.QA_CATALOG_EXPAND_TIMEOUT_MS ?? process.env.QA_CLAUDE_TIMEOUT_MS ?? 300_000);

  // Static EXPAND rules — identical across all batches → cached breakpoint so
  // only the per-batch templates + stubs are fresh tokens.
  const expandRules = `Expand each stub in the PLAN (provided in the user message) into a full test case for "${gameSpec.game_display_name}". Game sources are in the SYSTEM context above.

For EACH stub, produce a full TestCase with this shape:
{
  "id": "<keep stub id>",
  "name": "<keep stub name>",
  "description": "<expand stub description into 2-3 sentences>",
  "category": "<keep stub category>",
  "severity": "<keep stub severity>",
  "setup_instructions": "Natural-language goal for the AI setup driver to configure the game UI BEFORE spinning. Be specific on TARGET VALUES (cite from STRUCTURED CONFIG when possible) but let AI figure out clicks.",
  "expected_bet": number | null,
  "expected_config": { "key": "value" } | null,
  "spin_count": <keep stub spin_count>,
  "expected_feature": <keep stub expected_feature>,
  "invariant_ids": [],
  "custom_assertions": [
    { "id": "kebab-id", "description": "what's checked", "check_code": "JS expression (no semicolons)" }
  ]
}

CRITICAL RULES for setup_instructions (DETAILED — output is read by AI driver AND reviewed by human QA):
- **MUST be a NUMBERED step list** in a single string, one step per sentence/line, format:
  "Step 1: <atomic action>. Step 2: <atomic action>. Step 3: <verification>."
- Each step MUST be ATOMIC (one click target, one observable outcome). NO "do X then Y" in one step.
- The LAST step MUST be a VERIFICATION step (e.g. "Step N: Verify the bet display shows '$0.20' or closest reachable value within 1 ladder step.").
- Cite EXPLICIT NUMERIC VALUES from spec.bet_mechanics — do NOT say "minimum bet", say "0.10 USD (baseBet 10 × coin 0.01 × level 1)".
- Cite UI element NAMES from options.json (e.g. "the '-' button labeled in options as 'Bet Decrease'").
- Include explicit TOLERANCE for stepper actions: "within ±1 ladder step" or "within ±10% of target".
- **MUST NOT include spinning** the main Spin button. Setup ends BEFORE the test loop starts spinning (spin_count handled separately).
- If target bet is ABOVE base-bet ladder max from options.json but matches a Special Bet price, setup MUST use Special Bets/Ante panel instead of base +/- controls.
- **EXCEPTION category="autoplay"**: include FULL configure+start flow ending with "Step N: Press the START button — verify reels begin spinning." Test runner uses waitForAutoplayRounds.
- **EXCEPTION category="buy_feature" / "free_spins-buy"**: include FULL purchase flow ending with "Step N: Click Confirm/Buy — verify purchase popup closes and reels start spinning." Runner uses waitForFeatureComplete.
- For pure observational cases (base_game default bet, organic feature watch), setup_instructions = "" (empty string) — the test runs at current state.

GOOD setup_instructions examples (copy this format):
  "Step 1: Locate the bet display in the bottom info bar (current value shown next to '$' or 'BET'). Step 2: Read current bet value — record as starting_bet. Step 3: Click the '-' bet decrease button repeatedly until bet display shows '0.10' (baseBet 10 × coin 0.01 × level 1). Step 4: Verify the bet display reads exactly '0.10' (within ±1 ladder step tolerance)."

  "Step 1: Click the Autoplay button (circular icon on bottom-right per options.json). Step 2: In the autoplay panel, select '10 rounds' option. Step 3: Click the START button at the bottom of the panel. Step 4: Verify the panel closes and reels visibly begin spinning automatically."

BAD setup_instructions:
  "Set bet to 2.00 and spin 20 times" — combines setup with spinning, vague target
  "Decrease bet" — no numeric target, no verification
  "Spin 5 times manually" — driver cannot spin manually

CRITICAL RULES for custom_assertions.check_code:
- Standalone JS expression (no semicolons, no statements). Use typeof / Math.abs / array methods.
${ASSERTION_VARS_DOC}
- RNG-INDEPENDENT ONLY: NEVER require a rare/organic event to MUST occur in fixed spins.
  - FORBIDDEN: 
    - \`collector.spins.some(s => s.isFreeSpin === true)\`
    - \`collector.spins.some(s => s.winAmount > 0)\`
    - any \`...length > 0\` assertion for bonus/free-spin/win events in organic watch cases.
  - REQUIRED STYLE: implication/shape invariants, e.g. "if event observed then structure is valid".
    - Example: \`collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)\`
    - Example: \`collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)\`
- For buy_feature deduction: use \`(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()\` — NEVER \`spin.betAmount > base_bet\` (betAmount is base bet, not buy price).
- For free spins watch cases: \`collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)\`
- For round chain: \`getRoundEndSpins(collector.spins).length >= 1\`
- **For numeric checks, ALWAYS guard against undefined/NaN first**: instead of \`spin.winAmount >= 0\`, write \`typeof spin.winAmount === 'number' && spin.winAmount >= 0\`. Same for betAmount, endingBalance, startingBalance. This makes failures debuggable when network mapping is wrong (otherwise you get useless "received: false" with no clue why).
- **For per-spin balance conservation checks, ALWAYS skip when startingBalance is null**: the first spin in any session has \`startingBalance === null\` (no previous spin). Write \`spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01\`. NEVER write \`spin.endingBalance === spin.startingBalance - spin.betAmount + spin.winAmount\` directly — it will FAIL on the first spin because \`null - number = NaN\` and \`NaN === number\` is false. This is the most common false-positive in catalog assertions.
- **For ui_consistency cases**, custom_assertions can reference \`screen\` (vision-OCR'd values). Examples:
  - \`screen.balance !== null && Math.abs(screen.balance - spin.endingBalance) <= 0.01\` (balance UI matches API)
  - \`screen.bet !== null && Math.abs(screen.bet - spin.betAmount) <= 0.01\` (bet UI matches)
  - \`screen.last_win === null || Math.abs(screen.last_win - spin.winAmount) <= 0.01\` (allow null, fail on mismatch)
  Always check \`!== null\` first because OCR may return null if UI doesn't display the field.
- **OCR coverage gate** (read the "OCR COVERAGE FOR THIS GAME" block in sources above, if present):
  - If a region is marked ✗ (not configured), DO NOT reference its bound \`screen.X\` field. The assertion would silent-pass at runtime via null-guard, providing zero coverage and polluting the catalog with no-op assertions.
  - If a region is marked ✓ (configured), feel free to include the assertion — it WILL run real OCR + compare against API, and the runtime confidence engine attaches a ui_ocr signal.
  - When OCR coverage is fully missing (all ✗), skip the entire ui_consistency category and DO NOT add \`screen.X\` assertions to any other category — focus on server-data assertions.
  - When the OCR COVERAGE block is ABSENT from sources, assume optimistic full coverage (legacy behavior) and emit defensive null-guarded assertions.
- **NEVER hallucinate matrix/reel grid dimensions.** Read the EXACT values from
  \`gameSpec.grid_dimensions\` (if present, source="observed") and use those
  literals. Common past bug: AI generated \`matrix[0].length === 4\` for a 5x5
  game → assertion permanent-fails. If gameSpec.grid_dimensions is missing or
  source="default", write the assertion as a shape invariant WITHOUT a specific
  row/col literal: \`collector.spins.filter(s => Array.isArray(s.matrix) && s.matrix.length > 0).every(s => s.matrix.every(reel => Array.isArray(reel) && reel.length > 0))\`.
- **NEVER guess bet-ladder step counts in setup_instructions math.** When the
  setup needs to navigate from default bet to a target (e.g. "step from 10 down
  to 0.50"), read \`gameSpec.bet_mechanics.bet_sizes\` (sorted ascending) and
  COUNT the actual ladder positions between default and target. If default=10
  is at ladder[N-1] and target=0.50 is at ladder[K], the click count is
  \`(N-1) - K\` for betMinus (or the reverse for betPlus). Cite the count
  explicitly in setup_instructions: "Step 3: Press betMinus N times (default
  10 is ladder[11], target 0.50 is ladder[3] → 11-3=8 betMinus clicks)". DO
  NOT eyeball — bet ladders are non-linear (e.g. 0.20, 0.40, 0.50, 1, 2, 5, 10).

CRITICAL RULES for invariant_ids:
- Empty array [] = use ALL critical+major invariants from gameSpec (default — preferred).
- Specific ids = override default with subset. ONLY use ids that exist in gameSpec.invariants.

CRITICAL RULES for "description":
- 2-3 sentences. MUST cite the SPECIFIC FEATURE/RULE being tested with source prefix (\`spec:\`, \`paytable:\`, \`options:\`).
- Bad: "Test that bet works correctly."
- Good: "Verify betAmount in spin response equals 0.10 USD when bet is configured to minimum (spec: bet_mechanics.bet_amount_formula = baseBet × betSize × betLevel; minimum = 10 × 0.01 × 1 = 0.10). Validates bet ladder lower bound and balance arithmetic on smallest stake."

CRITICAL RULES for "expected_bet" and "expected_config":
- Set expected_bet whenever category targets a specific bet (bet_variation, bet_level, autoplay, base_game with default). NULL only when bet is genuinely "whatever current state is".
- Set expected_config with concrete numeric values: \`{ "betSize": 0.01, "betLevel": 1 }\` — NOT \`{ "bet": "minimum" }\`.
- expected_bet MUST equal baseBet × betSize × betLevel from expected_config (consistency check).
- **CRITICAL: expected_bet MUST be NULL for menu-only / settings / paytable / history / info-popup cases.** These cases don't touch bet — adding expected_bet for them is "AI overreach" that causes a precheck failure when the previous case left bet at a different value. Cases that genuinely don't care about bet should set expected_bet=null AND avoid \`Math.abs(spin.betAmount - X) <= 0.01\` assertions against literal X. If you want to verify bet didn't change during the test, use \`collector.spins.every(s => s.betAmount === collector.spins[0].betAmount)\` (compares first vs rest) instead of pinning to a literal.
- Categories that should ALWAYS have expected_bet=null: \`options\`, \`settings\`, \`paytable\`, \`history\`, \`info\`, \`menu\`, \`turbo_spin\` (toggling turbo doesn't fix bet), any \`other\` case whose setup_instructions doesn't say "set bet to N".

Return ONLY JSON:
{
  "cases": [ /* one full TestCase per stub in the user message, SAME order */ ]
}

Output ONLY the JSON.`;

  // Expand an arbitrary set of stubs (one batch OR a repair set) → TestCase[].
  // sourceBlock + expandRules are cached; only per-batch templates + stubs are
  // fresh tokens. Parse failure returns [] (lose ≤1 batch, not the whole mẻ).
  // Never throws — a batch that errors (rate limit, timeout, parse) returns []
  // so one bad batch loses ≤BATCH_SIZE cases instead of the whole catalog.
  const expandStubs = async (stubs: CaseStub[], label: string): Promise<TestCase[]> => {
    if (stubs.length === 0) return [];
    const templates = buildTemplateBlockForPlan(stubs.map((c) => c.category));
    try {
      const res = await catalogCall({
        system: [{ text: SYSTEM_PREAMBLE }, { text: sourceBlock, cache: true }],
        user: [
          { text: expandRules, cache: true },
          { text: `${templates}\n\n=== PLAN (case stubs to expand) ===\n${JSON.stringify(stubs, null, 2)}` },
        ],
        maxTokens: EXPAND_MAX_TOKENS,
        label,
        timeoutMs: EXPAND_TIMEOUT_MS,
      });
      const parsed = extractJsonFromText<{ cases: TestCase[] }>(res.text);
      if (!parsed || !Array.isArray(parsed.cases)) {
        console.warn(`[${label}] parse failed (raw head: ${res.text.slice(0, 200)})`);
        return [];
      }
      return parsed.cases;
    } catch (err) {
      console.warn(`[${label}] expand failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  const batches = chunkStubs(plan.cases, BATCH_SIZE);
  console.log(`[catalog] Step 2/2: expanding ${plan.cases.length} stubs in ${batches.length} batch(es) of ≤${BATCH_SIZE} (concurrency ${CONCURRENCY})...`);
  const batchResults = await mapLimit(batches, CONCURRENCY, (batch, i) =>
    expandStubs(batch, `catalog/EXPAND[${i + 1}/${batches.length}]`),
  );
  let rawCases = mergeExpandedBatches(batchResults);

  // Completion pass: if any planned stub is missing from the merged result
  // (its batch failed), re-expand just the missing stubs once.
  const present = new Set(rawCases.map((c) => c.id));
  const missingStubs = plan.cases.filter((s) => !present.has(s.id));
  if (missingStubs.length > 0) {
    console.warn(`[catalog] ${missingStubs.length} stub(s) missing after batches — re-expanding once`);
    const recovered = await expandStubs(missingStubs, "catalog/EXPAND-complete");
    rawCases = mergeExpandedBatches([rawCases, recovered]);
  }

  if (rawCases.length === 0) {
    throw new Error(`generateTestCaseCatalog: EXPAND produced 0 cases across ${batches.length} batch(es)`);
  }
  console.log(`[catalog] Step 2/2 ✔ ${rawCases.length} cases expanded (from ${plan.cases.length} stubs)`);
  if (rawCases.length !== plan.cases.length) {
    console.warn(
      `[catalog] ⚠ EXPAND produced ${rawCases.length} cases but PLAN had ${plan.cases.length} (some batch may have failed/deduped).`,
    );
  }

  // ===== STEP 3: VALIDATE (with targeted repair of failing cases) =====
  let cases = annotateSpecialBetSetupHints(
    normalizeAssertionsForRngIndependence(rawCases),
    args.optionsJson,
  );
  let report = runFullValidation({
    cases,
    gameSpec,
    optionsJson: args.optionsJson,
    coverageNotes: plan.coverage_notes ?? [],
  });
  if (!report.ok) {
    // Targeted repair: re-expand ONLY the cases with failing assertions (errors
    // carrying a case_id) instead of regenerating the whole catalog. Cheaper +
    // doesn't regress the cases that already passed. Catalog-level errors
    // (case_id null, e.g. dup-id / missing universal category) originate from
    // PLAN and can't be fixed by re-EXPAND — they surface in the final throw.
    const failingIds = Array.from(
      new Set(report.errors.map((e) => e.case_id).filter((id): id is string => Boolean(id))),
    );
    const stubsToFix = plan.cases.filter((s) => failingIds.includes(s.id));
    if (stubsToFix.length > 0) {
      console.warn(
        `[catalog] Step 3 ⚠ ${report.errors.length} error(s) across ${failingIds.length} case(s) — re-expanding ONLY those (targeted repair)`,
      );
      const refixed = await expandStubs(stubsToFix, "catalog/EXPAND-repair");
      if (refixed.length > 0) {
        const fixedById = new Map(refixed.filter((c) => typeof c.id === "string").map((c) => [c.id, c]));
        rawCases = rawCases.map((c) => fixedById.get(c.id) ?? c);
        cases = annotateSpecialBetSetupHints(
          normalizeAssertionsForRngIndependence(rawCases),
          args.optionsJson,
        );
        report = runFullValidation({
          cases,
          gameSpec,
          optionsJson: args.optionsJson,
          coverageNotes: plan.coverage_notes ?? [],
        });
      }
    } else {
      console.warn(
        `[catalog] Step 3 ⚠ ${report.errors.length} catalog-level error(s) (no case_id) — cannot target-repair`,
      );
    }
  }
  console.log(`[catalog] Step 3/3 validation:\n${formatValidationReport(report)}`);

  // Graceful degrade: a single AI-generated assertion the repair retry can't
  // fix used to ABORT the entire catalog (all 30 cases discarded). Instead,
  // DROP only the offending assertion(s) — they're per-assertion, additive
  // checks — keep the case + the rest, log loudly, and re-validate. Abort only
  // if STRUCTURAL errors remain (catalog-level / category / dup-id) or dropping
  // didn't clear the errors. Assertion-scoped errors use rule `assertion-*` and
  // embed `assertion "<id>"` in the message.
  const droppedAssertions: string[] = [];
  if (!report.ok) {
    const aidOf = (msg: string): string | null => msg.match(/assertion "([^"]+)"/)?.[1] ?? null;
    const isDroppable = (e: typeof report.errors[number]) =>
      Boolean(e.case_id) && /^assertion-/.test(e.rule) && aidOf(e.message) != null;
    const fatal = report.errors.filter((e) => !isDroppable(e));
    const droppable = report.errors.filter(isDroppable);
    if (fatal.length === 0 && droppable.length > 0) {
      const dropByCase = new Map<string, Set<string>>();
      for (const e of droppable) {
        const aid = aidOf(e.message)!;
        if (!dropByCase.has(e.case_id!)) dropByCase.set(e.case_id!, new Set());
        dropByCase.get(e.case_id!)!.add(aid);
        console.warn(`[catalog] DROPPING invalid assertion ${e.case_id}/${aid} [${e.rule}]: ${e.message}`);
      }
      cases = cases.map((c) => {
        const drop = dropByCase.get(c.id);
        if (!drop) return c;
        return { ...c, custom_assertions: (c.custom_assertions ?? []).filter((a) => !drop.has(a.id)) };
      });
      for (const [cid, ids] of dropByCase) for (const aid of ids) droppedAssertions.push(`${cid}/${aid}`);
      report = runFullValidation({
        cases,
        gameSpec,
        optionsJson: args.optionsJson,
        coverageNotes: plan.coverage_notes ?? [],
      });
      console.log(`[catalog] dropped ${droppedAssertions.length} un-repairable assertion(s); re-validation:\n${formatValidationReport(report)}`);
    }
  }

  if (!report.ok) {
    throw new Error(
      `generateTestCaseCatalog: validation failed after retry${droppedAssertions.length ? " + assertion-drop" : ""} — ${report.errors.length} error(s):\n${formatValidationReport(report)}`,
    );
  }

  const elapsed = Date.now() - t0;
  if (meta) meta.elapsed_ms = elapsed;

  // Surface dropped assertions so QA knows which checks were removed (fail-loud,
  // not silent truncation).
  const coverageNotes = [
    ...(plan.coverage_notes ?? []),
    ...(droppedAssertions.length
      ? [`⚠ Dropped ${droppedAssertions.length} un-repairable AI assertion(s) during generation: ${droppedAssertions.join(", ")}`]
      : []),
  ];
  if (meta && droppedAssertions.length) {
    (meta as Record<string, unknown>).dropped_assertions = droppedAssertions;
  }

  return {
    game_slug: gameSpec.game_code,
    game_display_name: gameSpec.game_display_name,
    generated_at: new Date().toISOString(),
    total_cases: cases.length,
    cases,
    coverage_notes: coverageNotes,
    generation_meta: meta,
  };
}
