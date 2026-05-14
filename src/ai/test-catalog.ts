import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { askClaude, extractJsonFromText } from "./claude.js";
import type { GameSpec } from "./authoring.js";
import { extractStructuredFromConfig, structuredConfigToMarkdown } from "./config-extract.js";
import {
  validateCatalog,
  formatValidationReport,
  buildValidationFeedback,
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

const SYSTEM_PLAN =
  "You are a senior QA engineer specializing in slot games. You design comprehensive test plans by analyzing rules, config, and observed behavior. Output ONLY valid JSON.";

const SYSTEM_EXPAND =
  "You are a senior QA engineer specializing in slot games. You expand test plan stubs into fully detailed test cases with precise setup_instructions and runnable assertion expressions. Output ONLY valid JSON.";

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

const ASSERTION_VARS_DOC = `Variables available in check_code expressions:
- spin (current SpinResponse): normalized fields ONLY: betAmount, winAmount, endingBalance, startingBalance, updatedBalance, status, id, round, currency, totalBet, isFreeSpin, isEndRound, matrix, result.
- collector (SpinCollector): { spins: SpinResponse[] }
- spinIndex (number): 0-based loop index
- balanceBefore (number): wallet balance captured BEFORE the test's first spin (for buy-feature deduction checks)
- detectBuyFeatureDeduction(spins, startIndex, balanceBefore): helper returning {ratio, costPaid} or null
- getRoundEndSpins(spins): helper returning only spins where isEndRound=true
- getCurrentBalance(collector): convenience to read latest balance
- screen (ScreenValues, ONLY inside ui_consistency cases): { balance, bet, last_win, total_win, currency, free_spins_remaining, multiplier } — vision-OCR'd values from play screen.
- DO NOT reference _raw or provider-specific fields like "tw", "w", "c", "sa", "sb"`;

function buildSourceBlock(args: {
  gameSpec: GameSpec;
  rulesMarkdown: string;
  optionsJson: string | null;
  configResponse: unknown | null;
  paytableMarkdown: string | null;
  sampleSpinResponses: unknown[];
}): { block: string; meta: TestCaseCatalog["generation_meta"] } {
  const { gameSpec, rulesMarkdown, optionsJson, configResponse, paytableMarkdown, sampleSpinResponses } = args;

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

  // --- Paytable pages (in-session vision capture) ---
  if (paytableMarkdown) {
    parts.push("\n=== PAYTABLE PAGES (transcribed from in-game info modal) ===");
    parts.push(paytableMarkdown);
    inputs_used.push("paytable_pages");
  }

  // --- Options catalog ---
  if (optionsJson) {
    parts.push("\n=== OPTIONS CATALOG (UI controls extracted from play screen) ===");
    parts.push(optionsJson);
    inputs_used.push("options_json");
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
  });

  // ===== STEP 1: PLAN =====
  console.log(`[catalog] Step 1/2: planning test outline (${meta?.inputs_used.join("+")})...`);
  const planPrompt = `Design a comprehensive test PLAN for slot game "${gameSpec.game_display_name}" (code=${gameSpec.game_code}).

You will produce ONLY case stubs (id, name, category, severity, brief description, spin_count, expected_feature, rationale).
Setup instructions and assertion code will be expanded in a SECOND pass.

${sourceBlock}

RECOMMENDED COVERAGE (skip a category only if game truly does not have that feature based on sources above):

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
      "category": "base_game" | "bet_variation" | "bet_level" | "autoplay" | "buy_feature" | "special_bet" | "turbo_spin" | "free_spins" | "history" | "options" | "max_win_cap" | "other",
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

Output ONLY the JSON.`;

  const planRaw = await askClaude({
    content: [{ type: "text", text: planPrompt }],
    system: SYSTEM_PLAN,
    maxTurns: 1,
    label: "catalog/PLAN",
  });
  const plan = extractJsonFromText<PlanResponse>(planRaw);
  if (!plan || !Array.isArray(plan.cases) || plan.cases.length === 0) {
    throw new Error(`generateTestCaseCatalog: PLAN step parse failed. Raw:\n${planRaw.slice(0, 500)}`);
  }
  console.log(`[catalog] Step 1/2 ✔ ${plan.cases.length} case stubs planned`);
  const planCategories = Array.from(new Set(plan.cases.map((c) => c.category)));
  if (meta) meta.plan_categories = planCategories;

  // ===== STEP 2: EXPAND =====
  console.log(`[catalog] Step 2/2: expanding stubs into full cases with setup_instructions + assertions...`);
  const expandPrompt = `Expand the following test PLAN into full test cases for "${gameSpec.game_display_name}".

${sourceBlock}

=== PLAN (case stubs to expand) ===
${JSON.stringify(plan.cases, null, 2)}

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
- For buy_feature deduction: use \`(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()\` — NEVER \`spin.betAmount > base_bet\` (betAmount is base bet, not buy price).
- For free spins triggered: \`collector.spins.some(s => s.isFreeSpin === true)\`
- For round chain: \`getRoundEndSpins(collector.spins).length >= 1\`
- **For numeric checks, ALWAYS guard against undefined/NaN first**: instead of \`spin.winAmount >= 0\`, write \`typeof spin.winAmount === 'number' && spin.winAmount >= 0\`. Same for betAmount, endingBalance, startingBalance. This makes failures debuggable when network mapping is wrong (otherwise you get useless "received: false" with no clue why).
- **For ui_consistency cases**, custom_assertions can reference \`screen\` (vision-OCR'd values). Examples:
  - \`screen.balance !== null && Math.abs(screen.balance - spin.endingBalance) <= 0.01\` (balance UI matches API)
  - \`screen.bet !== null && Math.abs(screen.bet - spin.betAmount) <= 0.01\` (bet UI matches)
  - \`screen.last_win === null || Math.abs(screen.last_win - spin.winAmount) <= 0.01\` (allow null, fail on mismatch)
  Always check \`!== null\` first because OCR may return null if UI doesn't display the field.

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

Return ONLY JSON:
{
  "cases": [ /* one full TestCase per stub, SAME order */ ]
}

Output ONLY the JSON.`;

  const expandRaw = await askClaude({
    content: [{ type: "text", text: expandPrompt }],
    system: SYSTEM_EXPAND,
    maxTurns: 1,
    label: "catalog/EXPAND",
  });
  const expanded = extractJsonFromText<{ cases: TestCase[] }>(expandRaw);
  if (!expanded || !Array.isArray(expanded.cases)) {
    throw new Error(`generateTestCaseCatalog: EXPAND step parse failed. Raw:\n${expandRaw.slice(0, 500)}`);
  }
  console.log(`[catalog] Step 2/2 ✔ ${expanded.cases.length} cases expanded`);

  // Sanity: stub count vs expanded count
  if (expanded.cases.length !== plan.cases.length) {
    console.warn(
      `[catalog] ⚠ EXPAND returned ${expanded.cases.length} cases but PLAN had ${plan.cases.length}. Continuing anyway.`,
    );
  }

  // ===== STEP 3: VALIDATE (with 1 retry on errors) =====
  let cases = expanded.cases;
  let report = runFullValidation({
    cases,
    gameSpec,
    optionsJson: args.optionsJson,
    coverageNotes: plan.coverage_notes ?? [],
  });
  if (!report.ok) {
    console.warn(
      `[catalog] Step 3 ⚠ ${report.errors.length} validation error(s) — retrying EXPAND once with feedback`,
    );
    const feedback = buildValidationFeedback(report);
    const fixPrompt = `${expandPrompt}

═══ VALIDATION FAILURES FROM PREVIOUS ATTEMPT ═══
The previous expansion failed validation. Issues found:
${feedback}

Re-emit the FULL JSON with ALL cases, fixing the issues above. Same shape, same case ids where possible. Output ONLY the JSON.`;
    const fixRaw = await askClaude({
      content: [{ type: "text", text: fixPrompt }],
      system: SYSTEM_EXPAND,
      maxTurns: 1,
      label: "catalog/EXPAND-retry",
    });
    const fixed = extractJsonFromText<{ cases: TestCase[] }>(fixRaw);
    if (fixed && Array.isArray(fixed.cases)) {
      cases = fixed.cases;
      report = runFullValidation({
        cases,
        gameSpec,
        optionsJson: args.optionsJson,
        coverageNotes: plan.coverage_notes ?? [],
      });
    }
  }
  console.log(`[catalog] Step 3/3 validation:\n${formatValidationReport(report)}`);
  if (!report.ok) {
    throw new Error(
      `generateTestCaseCatalog: validation failed after retry — ${report.errors.length} error(s):\n${formatValidationReport(report)}`,
    );
  }

  const elapsed = Date.now() - t0;
  if (meta) meta.elapsed_ms = elapsed;

  return {
    game_slug: gameSpec.game_code,
    game_display_name: gameSpec.game_display_name,
    generated_at: new Date().toISOString(),
    total_cases: cases.length,
    cases,
    coverage_notes: plan.coverage_notes ?? [],
    generation_meta: meta,
  };
}
