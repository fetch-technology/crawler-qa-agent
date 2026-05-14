import { askClaude, extractJsonFromText, extractCodeFromText } from "./claude.js";
import type { TestCase } from "./test-catalog.js";

export type Invariant = {
  id: string;
  description: string;
  severity: "critical" | "major" | "minor";
  applies_to: "every_spin" | "non_free_spin" | "free_spin" | "session";
  check: string; // Plain-English check (e.g. "endingBalance === startingBalance - betAmount + winAmount")
  response_fields: string[]; // Response fields this invariant reads
  tolerance?: string; // Numeric tolerance for float comparisons
};

/**
 * Game-specific runtime check rules — AI suy ra từ recording samples.
 * Phase A produce, preflight tại bootstrap dùng để reject hints sai sớm,
 * runtime test-harness dùng completion_signal để biết khi nào spin xong.
 */
export type ExecutionStrategy = {
  /** Spin response về qua channel nào. AI infer từ recording. */
  channel: "http" | "websocket" | "hybrid";
  spin_endpoint_evidence: {
    /** URL pattern hoặc WS message kind đã chọn. Phải khớp network-hints.json. */
    pattern: string | null;
    /** Cite cụ thể từ samples vì sao endpoint NÀY là spin (chứ không phải wallet/balance/config). */
    evidence_in_samples: string;
    /** Liệt kê endpoint AI ĐÃ XEM XÉT nhưng REJECT, kèm lý do. */
    rejected_candidates: Array<{ pattern: string; reason: string }>;
  };
  completion_signal: {
    /** Khi nào 1 UI spin được tính là xong:
     * - "single_response": 1 spin = 1 response (PG, simple slots)
     * - "isEndRound_true": chờ response có isEndRound=true (cascade games)
     * - "tumble_chain_end": tumble cascade — đợi đến response không trigger tumble
     * - "ws_message_kind": chờ WS message với kind cụ thể
     * - "balance_settled": chờ balance không thay đổi 500ms (fallback)
     */
    method: "single_response" | "isEndRound_true" | "tumble_chain_end" | "ws_message_kind" | "balance_settled";
    /** Nếu method=ws_message_kind, kind value cần match. */
    ws_message_kind?: string | null;
    /** Game có cascade/tumble (multi-response per UI spin)? */
    tumble_aware: boolean;
    /** Free spins là sub-rounds độc lập hay chained vào round trigger? */
    free_spin_chains: boolean;
  };
  /** Các field mà 1 spin response thật BẮT BUỘC phải có (giúp preflight reject wallet snapshot). */
  field_validation: Array<{
    field: string;                                // normalized field name e.g. "winAmount"
    required: boolean;
    type: "number" | "string" | "boolean" | "array" | "object";
    min?: number;
    max?: number;
    nullable?: boolean;
  }>;
  /** Plain-English checks AI muốn chạy ở preflight (để bootstrap fail-fast). */
  preflight_checks: Array<{
    id: string;
    description: string;
    /** Rule machine-readable: kind + args.
     * - "all_samples_field_nonzero": args = { field: "betAmount" }
     * - "any_sample_field_present": args = { field: "matrix" }
     * - "samples_field_varies": args = { field: "winAmount" } (variance > 0 across samples)
     * - "field_type": args = { field: "winAmount", expected: "number" }
     * - "sample_count_min": args = { count: 1 }
     */
    rule: { kind: string; args: Record<string, unknown> };
  }>;
};

export type GameSpec = {
  game_code: string;
  game_display_name: string;
  engine: string | null;
  currency: string | null;
  rules_summary: string;
  bet_mechanics: {
    base_bet: number | null;
    bet_sizes: number[];
    bet_levels: number[];
    bet_amount_formula: string; // e.g. "betSize * betLevel * baseBet"
  };
  features: Array<{ name: string; description: string; trigger: string | null }>;
  symbols: Array<{
    code: string | null;
    name: string | null;
    type: "WILD" | "SCATTER" | "PICTURE_SYMBOL" | "BONUS" | "MYSTERY" | "UNKNOWN";
    multipliers: Record<string, string> | null;
    note: string | null;
  }>;
  invariants: Invariant[];
  sample_spin_response_shape: Record<string, string>; // Field name → type
  observed_caveats: string[]; // Things the AI noticed that may need human review
  /** Game-specific runtime data check strategy — preflight + harness dùng. */
  execution_strategy: ExecutionStrategy;
};

const UNDERSTAND_SYSTEM =
  "You are a QA analyst specializing in online casino slot games. You read paytable/rules transcriptions and observed API responses, and produce a precise, machine-readable GameSpec describing testable invariants. You output ONLY valid JSON — no prose, no markdown fences.";

const GENERATE_SYSTEM =
  "You are a senior Playwright + TypeScript test engineer. You generate complete, compilable .spec.ts files using a provided test-harness API. Output ONLY the TypeScript code — no explanation, no markdown fences.";

export async function understandGameRules(args: {
  gameSlug: string;
  rulesMarkdown: string;
  sampleSpinResponses: unknown[];
  configResponse: unknown | null;
  /** Endpoint candidate đã chọn từ network-detect (Phase 0). AI dùng để confirm/reject. */
  hintsCandidate?: { url_pattern: string; method: string; field_mapping: Record<string, unknown> } | null;
  /** Top response candidates đã thấy trong recording để AI so sánh và liệt kê rejected_candidates. */
  responseCandidates?: Array<{ url: string; method: string; keys: string[]; sample_values?: Record<string, unknown> }>;
}): Promise<GameSpec> {
  const { gameSlug, rulesMarkdown, sampleSpinResponses, configResponse, hintsCandidate, responseCandidates } = args;

  const prompt = `Analyze the rules and observed API responses for slot game "${gameSlug}" and produce a GameSpec JSON.

=== TRANSCRIBED RULES (from paytable/info UI) ===
${rulesMarkdown}

=== SAMPLE SPIN RESPONSES (already filtered by network-detect — these are believed to be spin responses) ===
${JSON.stringify(sampleSpinResponses.slice(0, 5), null, 2)}

=== GAME CONFIG (from GET /{game}/config) ===
${configResponse ? JSON.stringify(configResponse, null, 2).slice(0, 6000) : "(not captured)"}

${hintsCandidate ? `=== NETWORK-DETECT CANDIDATE (the endpoint Phase 0 chose as spin endpoint) ===
${JSON.stringify(hintsCandidate, null, 2)}

CRITICAL: This is just a CANDIDATE. The samples above came from this endpoint. If the samples look WRONG for a spin (e.g. all values are 0, missing matrix/reels, looks like wallet snapshot), call it out in execution_strategy.spin_endpoint_evidence and add the candidate to rejected_candidates.` : ""}

${responseCandidates?.length ? `=== OTHER CANDIDATE RESPONSES (other endpoints seen in recording, for cross-reference) ===
${JSON.stringify(responseCandidates.slice(0, 10), null, 2)}` : ""}

Produce a GameSpec with this exact shape:

{
  "game_code": string,
  "game_display_name": string,
  "engine": string | null,
  "currency": string | null,
  "rules_summary": string,
  "bet_mechanics": {
    "base_bet": number | null,
    "bet_sizes": number[],
    "bet_levels": number[],
    "bet_amount_formula": string
  },
  "features": [ { "name": string, "description": string, "trigger": string | null } ],
  "symbols": [ { "code": string|null, "name": string|null, "type": "WILD"|"SCATTER"|"PICTURE_SYMBOL"|"BONUS"|"MYSTERY"|"UNKNOWN", "multipliers": {"3": "x5", ...}|null, "note": string|null } ],
  "invariants": [
    {
      "id": "balance_conservation",
      "description": "The ending balance equals starting balance minus bet plus winnings",
      "severity": "critical",
      "applies_to": "every_spin",
      "check": "endingBalance === startingBalance - betAmount + winAmount",
      "response_fields": ["startingBalance", "endingBalance", "betAmount", "winAmount"],
      "tolerance": "0.001"
    }
  ],
  "sample_spin_response_shape": { "id": "string", "betAmount": "number", ... },
  "observed_caveats": [ "strings describing anything uncertain or needing human review" ],
  "execution_strategy": {
    "channel": "http" | "websocket" | "hybrid",
    "spin_endpoint_evidence": {
      "pattern": "<url pattern from network-detect>",
      "evidence_in_samples": "<concrete cite — which fields/values prove this is a spin response>",
      "rejected_candidates": [
        { "pattern": "/api/v1/wallet/play", "reason": "totalBet=0 totalWin=0 in all samples → wallet snapshot, not spin result" }
      ]
    },
    "completion_signal": {
      "method": "single_response" | "isEndRound_true" | "tumble_chain_end" | "ws_message_kind" | "balance_settled",
      "ws_message_kind": null,
      "tumble_aware": boolean,
      "free_spin_chains": boolean
    },
    "field_validation": [
      { "field": "betAmount", "required": true, "type": "number", "min": 0.01 },
      { "field": "winAmount", "required": true, "type": "number", "min": 0 },
      { "field": "endingBalance", "required": true, "type": "number", "min": 0 }
    ],
    "preflight_checks": [
      { "id": "spin-not-wallet-snapshot", "description": "At least one sample must have non-zero bet (rejects wallet snapshot endpoints)", "rule": { "kind": "all_samples_field_nonzero", "args": { "field": "betAmount" } } },
      { "id": "win-field-numeric", "description": "winAmount must be a number, not undefined/null", "rule": { "kind": "field_type", "args": { "field": "winAmount", "expected": "number" } } },
      { "id": "win-varies", "description": "winAmount should vary across samples (otherwise snapshot)", "rule": { "kind": "samples_field_varies", "args": { "field": "winAmount" } } }
    ]
  }
}

Critical requirements:
1. Every invariant MUST reference ONLY the NORMALIZED top-level fields: betAmount, winAmount, endingBalance, startingBalance, updatedBalance, status, id, round, currency, totalBet, isEndRound, isFreeSpin, matrix, result.
2. DO NOT write invariants that reference \`_raw.<field>\` (raw provider-specific fields like "tw", "w", "c", "sa", "sb"). Raw field SEMANTICS vary by provider and even within a game (e.g. cascade/tumble mechanics in Pragmatic Play produce multiple responses per UI spin, each with a per-tumble "w" field that is NOT the total win). Relying on raw fields will produce false-positive failures.
3. Multiple samples may represent INTERMEDIATE states of the same spin round (tumbles/cascades, free-spin sub-rounds). Only assert invariants that hold for EVERY sample — if any sample violates, skip that invariant.
4. Derive invariants from BOTH transcribed rules AND observed patterns in normalized fields.
5. Minimum 5 invariants. Prioritize: balance conservation (\`endingBalance === startingBalance - betAmount + winAmount\`), status check, currency consistency, bet-amount positivity, win-amount non-negativity, round-completion flag.
6. Do not invent normalized fields that don't exist in the samples — check which normalized fields are actually present across ALL samples before using.
7. tolerance: "0.001" or "0.01" for money; "0" for integer flags; raise tolerance to "0.1" if you see variance across samples that's just rounding.

Critical requirements for execution_strategy:
8. **channel**: Pick "http" if samples are JSON HTTP responses (default). Pick "websocket" if you see signs the spin runs over WS (engine=Cocos AND no HTTP endpoint with matrix/reels — e.g. Revenge Games / fortune-pig). Pick "hybrid" only if you see both.
9. **spin_endpoint_evidence**: This is mission-critical. Cite SPECIFIC field values from samples that PROVE this endpoint is the spin (not wallet/balance/config). E.g. "samples have varying matrix arrays and totalWin > 0 in 2/5 samples" — NOT vague claims like "looks like spin".
10. **rejected_candidates**: If you suspect the network-detect candidate is wrong (samples look like wallet snapshot, all-zero values, no spin-specific fields), put the current pattern in rejected_candidates with explicit reason. Preflight will use this to fail bootstrap fast.
11. **completion_signal**:
    - "single_response" — non-cascade slots (1 spin = 1 response). USE THIS if you don't see isEndRound/tumble fields in samples.
    - "isEndRound_true" — only if you ACTUALLY see isEndRound field in samples (Pragmatic Play cascade).
    - "tumble_chain_end" — only if you see multi-response per UI spin pattern.
    - "ws_message_kind" — WebSocket games; set ws_message_kind to the specific kind/type field you observed.
    - "balance_settled" — fallback when nothing else works.
12. **field_validation — CRITICAL: only specify required:true for fields that ACTUALLY EXIST in the provided samples**. DO NOT add fields like "updatedBalance", "isEndRound", "isFreeSpin" as required UNLESS you see them in at least 1 sample. Walk through sample[0] keys and only require fields you can SEE. Adding a hallucinated required field will fail bootstrap. If a normalized field MIGHT be useful but isn't in samples, set required:false.
13. **field_validation type values**: must be one of "number" | "string" | "boolean" | "array" | "object". Use "array" for matrix/reels/symbols fields. typeof [] is "object" but the preflight checks Array.isArray separately — pick "array" if the value is an array.
14. **preflight_checks rule kinds available** (use these EXACT names, others will be skipped):
    - "all_samples_field_nonzero" args:{field}  — at least one sample has field !== 0 (rejects wallet snapshot)
    - "any_sample_field_present" args:{field}  — field exists in at least 1 sample
    - "samples_field_varies" args:{field}  — field has different values across samples
    - "field_type" args:{field, expected: "number"|"string"|"boolean"|"array"|"object"}  — strict type check
    - "field_equals" args:{field, value}  — all samples have field === value
    - "field_in" args:{field, values: [...]}  — all samples have field ∈ values (use for status enums)
    - "field_array_nonempty" args:{field}  — field is array with length > 0
    - "sample_count_min" args:{count}  — at least N samples
    Do NOT invent kinds like "field_matches", "regex_check" etc. — they will be skipped.
15. **preflight_checks minimum required** for any spin endpoint: "all_samples_field_nonzero" for betAmount AND "field_type" for winAmount=number. Add others only if game has the structure (e.g. "field_array_nonempty" for matrix only if matrix exists in samples).

Output ONLY the JSON.`;

  const raw = await askClaude({
    content: [{ type: "text", text: prompt }],
    system: UNDERSTAND_SYSTEM,
  });
  const spec = extractJsonFromText<GameSpec>(raw);
  if (!spec) {
    throw new Error(`Không parse được GameSpec JSON. Raw:\n${raw.slice(0, 500)}`);
  }
  return spec;
}

export async function generatePlaywrightTest(args: {
  gameSpec: GameSpec;
  harnessImportPath: string;
  envVarUrl: string;
  spinsPerTest: number;
  testCases?: TestCase[];
}): Promise<string> {
  const { gameSpec, harnessImportPath, envVarUrl, spinsPerTest, testCases } = args;

  // Nếu có testCases → generate test-per-case. Nếu không → fallback to legacy single test.
  if (testCases && testCases.length > 0) {
    return generateParameterizedTestCode({
      gameSpec,
      harnessImportPath,
      envVarUrl,
      testCases,
    });
  }

  const prompt = `Generate a Playwright .spec.ts file that tests the slot game "${gameSpec.game_display_name}" (code=${gameSpec.game_code}) against the invariants in the GameSpec.

=== GAME SPEC (source of truth for invariants) ===
${JSON.stringify(gameSpec, null, 2)}

=== AVAILABLE TEST HARNESS ===

Import from "${harnessImportPath}":

  import { test, expect, type SpinResponse, openGame, doAutoSpin, openHistoryPanel, readHistoryRows, assertHistoryMatches, keepBrowserOpenIfRequested } from "${harnessImportPath}";

- \`test\` and \`expect\` are re-exported from @playwright/test.
- \`SpinResponse\` type represents a parsed spin response body. It's a loose type (Record-like) — access fields like spin.startingBalance, spin.endingBalance, spin.betAmount, spin.winAmount, spin.status, spin.updatedBalance, etc.
- \`openGame(page, url)\` returns a \`SpinCollector\` object. Call once at start. Throws if game fails to load.
- \`doAutoSpin(page, collector)\` executes one spin via AI-driven UI automation and returns a \`SpinResponse\`. Throws if no spin response within the timeout.
- \`openHistoryPanel(page, collector)\` — AI-driven navigation to the game's History/Rounds panel. Throws if cannot find/open.
- \`readHistoryRows(page)\` — takes a screenshot of the currently visible history panel and transcribes all rows to structured data.
- \`assertHistoryMatches(collector.spins, rows)\` — cross-checks captured spin responses (ground truth) against transcribed history UI rows. Throws with detailed diff on mismatch.
- \`keepBrowserOpenIfRequested(page)\` — call this at THE VERY END of the test body, AFTER all assertions. If env QA_KEEP_BROWSER_OPEN=1, it keeps the browser visible for manual inspection until the user closes it. No-op otherwise.
- The harness handles dismissing modals and clicking the Spin button automatically. Screenshots of every step are persisted automatically to a folder for user review (QA_SCREENSHOT_DIR or fixtures/tasks/{id}/screenshots).

=== OUTPUT FORMAT ===

Output a single .spec.ts file that:
1. Imports from "@playwright/test" and "${harnessImportPath}".
2. Reads process.env.${envVarUrl} (throw if missing).
3. Defines ONE test.describe("${gameSpec.game_code} — invariants", ...) block.
4. Inside, defines ONE test("runs ${spinsPerTest} spins and asserts all invariants"):
   - Call openGame to get collector.
   - Note: \`collector.spins\` may contain MORE entries than expected if the game uses cascade/tumble mechanics (each UI spin = multiple API responses). Do NOT assert \`collector.spins.length === N\` strictly — use \`>=\` instead.
   - Loop ${spinsPerTest} times: doAutoSpin(page, collector), then assert EVERY invariant from gameSpec.invariants.
   - For each invariant, use expect() with an informative message. For float invariants, use expect(Math.abs(a-b)).toBeLessThanOrEqual(tolerance).
   - **CRITICAL**: Do NOT reference \`spin._raw.xxx\` or \`(spin as any).raw.xxx\` in any assertion. Raw provider-specific fields (tw, w, c, sa, sb, rs_iw, etc.) have inconsistent semantics across cascade/tumble rounds. Only use the normalized top-level fields: spin.betAmount, spin.winAmount, spin.endingBalance, spin.startingBalance, spin.updatedBalance, spin.status, spin.id, spin.round, spin.currency, spin.isEndRound, spin.isFreeSpin, spin.matrix, spin.result.
   - For invariants that check a normalized field exists before asserting, use \`if (Number.isFinite(spin.xxx))\` or \`if (spin.xxx !== undefined && spin.xxx !== null)\`. Skip the assertion if the field is missing rather than asserting \`!== undefined\`.
   - After loop, aggregate: log a summary console.log with total bet, total win, RTP.
   - **History consistency check** — AFTER the summary log and BEFORE keepBrowserOpenIfRequested, add this block exactly:

     let historyOpened = false;
     try {
       await openHistoryPanel(page, collector);
       historyOpened = true;
     } catch (err) {
       console.warn(\`[history] could not open history UI: \${(err as Error).message}; skipping history check\`);
     }
     if (historyOpened) {
       const rows = await readHistoryRows(page);
       // Throws with diff on mismatch — propagate as test failure (intended)
       assertHistoryMatches(collector.spins, rows);
       console.log(\`[history] verified \${rows.length} UI rows against \${collector.spins.length} captured spins\`);
     }

   - **As the LAST line of the test body**, call \`await keepBrowserOpenIfRequested(page);\` so the user can optionally keep the browser open via env flag.
5. Set test.setTimeout to 600_000 ms (10 minutes) at the top of the describe block — AI-driven spins are slow.

=== IMPORTANT ===

- Output ONLY TypeScript code. No markdown fences, no explanation.
- ESM imports with the exact path above.
- Every invariant in gameSpec.invariants MUST become at least one expect() assertion — BUT if the invariant references raw fields, REWRITE it to use only normalized fields (see critical rule above).
- For invariants that apply to "non_free_spin" only, wrap in \`if (!spin.isFreeSpin)\`.
- For fields that may not always be present, use optional chaining and skip the assertion if undefined (do NOT assert that field must be defined).
- Do NOT import or reference any file outside of "@playwright/test" and "${harnessImportPath}".
- Do NOT reference \`spin._raw\` or raw provider fields anywhere.`;

  const raw = await askClaude({
    content: [{ type: "text", text: prompt }],
    system: GENERATE_SYSTEM,
    maxTurns: 1,
  });
  const code = extractCodeFromText(raw, "typescript");
  return code;
}

/**
 * Generate spec.ts với nhiều test() block, mỗi test = 1 TestCase từ catalog.
 * Setup driver được dùng cho từng case trước khi chạy assertions.
 */
async function generateParameterizedTestCode(args: {
  gameSpec: GameSpec;
  harnessImportPath: string;
  envVarUrl: string;
  testCases: TestCase[];
}): Promise<string> {
  const { gameSpec, harnessImportPath, envVarUrl, testCases } = args;

  const prompt = `Generate a Playwright .spec.ts file that runs EACH test case as a separate test() block for slot game "${gameSpec.game_display_name}" (code=${gameSpec.game_code}).

=== GAME SPEC ===
${JSON.stringify(gameSpec, null, 2)}

=== TEST CASE CATALOG (${testCases.length} cases) ===
${JSON.stringify(testCases, null, 2)}

=== AVAILABLE TEST HARNESS ===

Import from "${harnessImportPath}":
  import { test, expect, type SpinResponse, type ScreenValues, openGame, doAutoSpin, applyCaseSetup, openHistoryPanel, readHistoryRows, assertHistoryMatches, readScreenValues, assertScreenMatchesAPI, keepBrowserOpenIfRequested, setActiveCase, balanceChainsFromPreviousRound, getRoundEndSpins, waitForAutoplayRounds, waitForFeatureComplete, detectBuyFeatureDeduction, getCurrentBalance } from "${harnessImportPath}";

Primitives:
- \`openGame(page, url)\` → SpinCollector (call ONCE per test)
- \`applyCaseSetup(page, goal: string)\` → { achieved, reason } — AI-driven config, returns after UI state reaches goal or timeout. Use once per test to configure before spinning.
- \`doAutoSpin(page, collector)\` → SpinResponse — execute ONE spin via AI
- \`openHistoryPanel(page, collector)\` + \`readHistoryRows(page)\` + \`assertHistoryMatches(spins, rows)\` — for history category cases
- \`keepBrowserOpenIfRequested(page)\` — call at end of each test
- \`setActiveCase(caseId: string | null)\` — sets the screenshot subfolder for this test. Call at the START of each test() with testCase.id, then \`setActiveCase(null)\` in a finally block at the END.
- \`balanceChainsFromPreviousRound(collector.spins, currentSpin)\` → boolean — CASCADE-SAFE balance chain check. Returns true if currentSpin.startingBalance matches the previous ROUND's endingBalance (or if there is no previous round). Use this for "balance-chain" / "round-to-round balance continuity" assertions instead of indexing collector.spins[i-1] directly. In cascade games (Sweet Bonanza, Sugar Rush, …) one UI spin produces MANY API responses, so naive index comparisons are wrong.
- \`getRoundEndSpins(collector.spins)\` → SpinResponse[] — filters to one entry per round end (useful for assertions that should evaluate per-round, not per-cascade).
- \`waitForAutoplayRounds(collector, expectedRounds, opts?)\` → Promise<void> — wait until the collector has captured at least N round-end responses. Use this for category="autoplay" cases INSTEAD of looping doAutoSpin, because the game's NATIVE autoplay (started by the setup) is much faster than AI-clicking Spin N times. Throws on timeout or stall (autoplay stop condition triggered early).
- \`waitForFeatureComplete(collector, opts?)\` → Promise<void> — wait for a buy-feature/free-spins chain to FULLY play out. Pass \`sinceIndex\` (snapshot of \`collector.spins.length\` BEFORE setup) so responses captured DURING setup count as new rounds. Returns when chain has \`minRounds\` (default 1) rounds AND no new round in \`quietMs\` (default 8s). Throws if no rounds appeared within \`startTimeoutMs\` (default 60s).
- \`detectBuyFeatureDeduction(spins, startIndex?, balanceBefore?)\` → \`{ deduction, baseBet, ratio, spin } | null\` — verify buy was committed by comparing balance BEFORE setup with balance after the first round in the buy chain. Formula: \`deduction = balanceBefore − endingBalance(firstRound) + winAmount(firstRound)\`. ALWAYS pass the third arg \`balanceBefore\` captured via \`getCurrentBalance(collector)\` BEFORE \`applyCaseSetup\` runs, otherwise the calculation may fall back to a wrong baseline (some providers emit a single \`balance\` field per response so single-round formulas fail).
- \`getCurrentBalance(collector)\` → \`number | null\` — last-seen balance from the last spin or authorize response. Use to snapshot \`balanceBefore\` for buy-feature deduction.
- \`readScreenValues(page, label?)\` → \`ScreenValues\` — vision-OCR play screen, returns \`{ balance, bet, last_win, total_win, currency, free_spins_remaining, multiplier }\`. Each field can be \`null\` if UI doesn't display it. Costs ~3-5s per call (Claude vision).
- \`assertScreenMatchesAPI(spin, screen, opts?)\` → throws if UI display ≠ API. Compares \`screen.balance\` vs \`spin.endingBalance\`, \`screen.bet\` vs \`spin.betAmount\`, \`screen.last_win\` vs \`spin.winAmount\` (skipped if UI null). Pass \`{ tolerance: 0.01, skipBalance, skipBet, skipLastWin }\` to override.

=== OUTPUT SHAPE ===

Output ONLY TypeScript code. One file with:
1. Import block (as above).
2. \`const GAME_URL = process.env.${envVarUrl}; if (!GAME_URL) throw new Error("GAME_URL required");\`
3. Single \`test.describe("${gameSpec.game_code} — test cases", () => { ... })\` block. **DO NOT** use \`test.describe.configure({ mode: 'serial' })\`. Each test creates its own browser context + page (\`openGame\` is called inside each test) so they are independent. Serial mode would auto-skip every subsequent test if one fails — we want each test to run regardless of others.
4. \`test.setTimeout(600_000)\` inside describe.
5. For EACH testCase in the catalog, emit ONE \`test(\\\`\${testCase.id}: \${testCase.name}\\\`, async ({ page }) => { ... })\` block.

Inside each test:
a. \`setActiveCase("<testCase.id>");\` as the FIRST line — wrap subsequent body in try/finally where \`finally { setActiveCase(null); }\`.
b. const collector = await openGame(page, GAME_URL);
c. IF setup_instructions is non-empty:
     const setup = await applyCaseSetup(page, testCase.setup_instructions);
     if (!setup.achieved) {
       test.skip(true, \`[setup failed: \${setup.reason}] \${testCase.setup_instructions}\`);
       return;
     }
d. If expected_bet is set, log warning if current bet mismatches (soft check).
e. **Spin execution — branch by category:**
   - **category === "autoplay"**: DO NOT loop doAutoSpin. Setup must have STARTED native autoplay. After setup, call \`await waitForAutoplayRounds(collector, testCase.spin_count, { perRoundTimeoutMs: 30_000 })\`. Then iterate over the captured rounds for assertions: \`for (let spinIndex = 0; spinIndex < testCase.spin_count; spinIndex++) { const spin = getRoundEndSpins(collector.spins)[spinIndex]; if (!spin) break; <invariant assertions on spin> }\`.
   - **category === "buy_feature" or "free_spins"**: DO NOT loop doAutoSpin. **CRITICAL ORDERING**:
       1. \`const startIndex = collector.spins.length;\` BEFORE applyCaseSetup
       2. \`const balanceBefore = getCurrentBalance(collector);\` BEFORE applyCaseSetup (so we capture pre-buy balance — buy response often arrives DURING setup)
       3. await applyCaseSetup(...)
       4. \`await waitForFeatureComplete(collector, { minRounds: 1, sinceIndex: startIndex });\`
       5. Assertions on \`getRoundEndSpins(collector.spins.slice(startIndex))\`
       6. \`detectBuyFeatureDeduction(collector.spins, startIndex, balanceBefore)\` — MUST pass \`balanceBefore\` as third arg, otherwise the deduction calc breaks for providers that return a single \`balance\` field per response (PP, etc.).
   - **category === "ui_consistency"**: After spinning (loop doAutoSpin testCase.spin_count times), call \`const screen = await readScreenValues(page, "post-spin")\` ONCE after the LAST spin. Then either:
       (a) Use \`assertScreenMatchesAPI(spin, screen)\` for the standard balance/bet/last_win triple-check (pass \`spin\` = last spin from loop), OR
       (b) Inline custom assertions referencing both \`spin\` and \`screen\` (e.g. cumulative balance after multi-spin: \`Math.abs(screen.balance - (initialBalance - totalBet + totalWin)) <= 0.01\`).
       The \`screen\` variable MUST be in scope for any custom_assertions that reference it. Pass \`{ skipLastWin: true }\` to assertScreenMatchesAPI for cascade games where UI shows accumulated win, not per-response.
   - **all other categories**: Loop testCase.spin_count times: \`const spin = await doAutoSpin(page, collector);\` then apply invariant assertions (from gameSpec.invariants that match testCase.invariant_ids, or all critical+major if invariant_ids empty).
f. Apply custom_assertions: for each, evaluate check_code as JS expression. Use \`eval\` ONLY inside a try/catch, OR — better — hardcode the check_code directly into the generated test as \`expect(<check_code>).toBeTruthy()\`. This is safer than runtime eval.
g. If category="history": AFTER all spins, open history panel, read rows, assertHistoryMatches(collector.spins, rows). Wrap in try/catch, soft-fail if history UI not available.
h. At end (inside try, before finally clears the case scope): await keepBrowserOpenIfRequested(page);

=== CRITICAL RULES ===

- Output ONLY TypeScript. No markdown fences, no explanation.
- Generate ONE test() block PER test case in the catalog. If 15 cases → 15 tests.
- Test names: use template literal with testCase.id and testCase.name.
- Inline invariants from gameSpec.invariants as expect() calls. ONLY reference normalized fields (spin.betAmount, spin.winAmount, spin.endingBalance, spin.startingBalance, spin.updatedBalance, spin.status, spin.id, spin.currency, spin.isFreeSpin, spin.isEndRound). DO NOT reference spin._raw or raw provider fields.
- For custom_assertions, EMBED check_code directly: \`expect(<check_code>, '<description>').toBeTruthy()\`. Do NOT use runtime eval.
- **Numeric guards on normalized fields**: ALWAYS guard numeric checks with type-check first. NEVER write bare \`spin.winAmount >= 0\`. ALWAYS write \`typeof spin.winAmount === 'number' && spin.winAmount >= 0\`. Same for betAmount/endingBalance/startingBalance. AND in the assertion message, embed the actual value: \`expect(typeof spin.winAmount === 'number' && spin.winAmount >= 0, \\\`win_amount_non_negative (got=\${spin.winAmount}, type=\${typeof spin.winAmount})\\\`).toBeTruthy()\`. This makes failures debuggable when network mapping is wrong.
- **Balance-chain assertions** (id like "balance-chain", "round-to-round", check_code that compares spin.startingBalance with previous endingBalance): REWRITE the check_code to use the cascade-safe helper:
  \`expect(balanceChainsFromPreviousRound(collector.spins, spin), 'balance-chain').toBeTruthy()\`
  NEVER write \`collector.spins[spinIndex-1].endingBalance\` or any direct index — that is wrong for cascade games.
- For float comparisons use Math.abs(a-b) <= tolerance, not toBeCloseTo.
- \`collector.spins.length\` may be > spin_count (cascade/tumble). Use \`>=\` not \`===\`.
- Summary log at end of each test: \`console.log(\\\`[\${testCase.id}] spins=\${collector.spins.length} totalBet=\${totalBet} totalWin=\${totalWin}\\\`)\`.

OUTPUT the .spec.ts code now.`;

  const raw = await askClaude({
    content: [{ type: "text", text: prompt }],
    system: GENERATE_SYSTEM,
    maxTurns: 1,
  });
  return extractCodeFromText(raw, "typescript");
}
