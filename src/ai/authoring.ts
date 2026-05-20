import { askClaude, extractJsonFromText, extractCodeFromText } from "./claude.js";
import type { TestCase, TestCaseCatalog } from "./test-catalog.js";
import { listScenarios, loadScenario } from "../runner/scenario.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  strategyFor,
  emitTestBlock,
  emitLLMTestBlock,
  summarizeCoverage,
  isStatelessTest,
  type AvailableScenario,
} from "./hybrid-case-mapper.js";

/**
 * Detect spin button coordinate từ recording's iterations.json mới nhất.
 * Find click decision có reason match "spin button" → return median coord.
 *
 * Fallback (720, 810) nếu không tìm được — tương thích với fiesta-magenta.
 *
 * Coord khác nhau giữa game (PP cascade often có spin button bên phải ~1150,
 * RG có ở giữa ~720). Hardcode fail cho cross-game.
 */
export function detectSpinButtonCoord(gameSlug: string): { x: number; y: number } {
  const recDir = "fixtures/recordings";
  const fallback = { x: 720, y: 810 };
  if (!existsSync(recDir)) return fallback;

  try {
    // Pick latest recording for slug
    const candidates = readdirSync(recDir)
      .filter((n) => n.startsWith(`${gameSlug}__`))
      .map((n) => ({ name: n, full: join(recDir, n) }))
      .filter((d) => statSync(d.full).isDirectory())
      .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
    if (candidates.length === 0) return fallback;

    const iterPath = join(candidates[0]!.full, "iterations.json");
    if (!existsSync(iterPath)) return fallback;

    const data = JSON.parse(readFileSync(iterPath, "utf8")) as Array<{
      decision?: { action?: string; x?: number; y?: number; reason?: string };
    }>;

    // Collect click coords có reason mention "spin button".
    // CRITICAL filter: exclude clicks tới modal-close/dismiss/blocker even khi
    // reason chứa "spin" (vd "Close the modal blocking the spin button" — đây
    // là dismiss modal, KHÔNG phải spin click). Modal close thường y ≈ middle
    // viewport (300-500), spin button luôn ở bottom (y > 600).
    const spinClicks: Array<{ x: number; y: number }> = [];
    for (const d of data) {
      const dec = d.decision;
      if (!dec || dec.action !== "click") continue;
      if (typeof dec.x !== "number" || typeof dec.y !== "number") continue;
      const reason = (dec.reason ?? "").toLowerCase();
      // Negative filter: skip nếu reason indicates dismiss/close/modal action
      const DISMISS_KEYWORDS = [
        "close", "dismiss", "blocking", "blocker", "modal",
        "popup", "overlay", "splash", "tutorial", "welcome",
      ];
      if (DISMISS_KEYWORDS.some((k) => reason.includes(k))) continue;
      // Positive filter: spin-related reason
      if (!(reason.includes("spin button") || reason.includes("spin to win") || /\bspin\b/.test(reason))) {
        continue;
      }
      // Geometry filter: spin button luôn ở bottom half (y >= viewport_height * 0.6).
      // Viewport 1440×900 → spin button thường y > 700. Loại click ở center/top.
      if (dec.y < 540) continue;
      spinClicks.push({ x: dec.x, y: dec.y });
    }

    if (spinClicks.length === 0) return fallback;

    // Use median để robust với outlier
    const xs = spinClicks.map((c) => c.x).sort((a, b) => a - b);
    const ys = spinClicks.map((c) => c.y).sort((a, b) => a - b);
    const midX = xs[Math.floor(xs.length / 2)]!;
    const midY = ys[Math.floor(ys.length / 2)]!;
    return { x: midX, y: midY };
  } catch {
    return fallback;
  }
}

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
  /**
   * Math mechanic — drives which decoder + payout calculator the rule engine
   * uses to verify spin responses against paytable.
   *
   * - "ways"     : left-to-right adjacent reels (vd 25/243/3125 ways) — fiesta-magenta
   * - "paylines" : fixed line layout (vd 25-line, 30-line classic slots)
   * - "cluster"  : connected groups of ≥N same symbol anywhere — Sweet Bonanza, vswayscyhecity
   * - "megaways" : variable rows per reel (117649 ways) — Big Time Gaming
   * - "lines"    : alias for paylines
   * - "unknown"  : AI couldn't classify with confidence — rule engine falls back to ways
   */
  mechanic_type: "ways" | "paylines" | "cluster" | "megaways" | "lines" | "unknown";
  /** True if game uses cascade/tumble (winning symbols disappear → new symbols drop → re-evaluate). */
  cascade: boolean;
  /** Cluster minimum size to pay (default 5 for Sweet Bonanza family). Only relevant for "cluster". */
  cluster_min_size?: number;
  /** Paylines layout if "paylines" mechanic. Each line = array of row indices, length = reel count. */
  paylines?: number[][];
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
  "mechanic_type": "ways" | "paylines" | "cluster" | "megaways" | "lines" | "unknown",
  "cascade": boolean,
  "cluster_min_size": number | undefined,
  "paylines": number[][] | undefined,
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

    **PP cascade detection (gs2c/v3/gameService endpoints)**: Check samples for these raw fields — if ANY exist, set \`tumble_aware: true\` and \`method: "tumble_chain_end"\`:
      - \`rs_more\` (cascade continues flag)
      - \`rs_c\` (cascade index/count)
      - \`rs_iw\` (intermediate win amount)
      - \`rs_p\` (cascade phase)
      - \`rs_m\` (cascade multiplier)
      - \`rs_win\` (cascade win)
      - \`rs_t\` (cascade type)
      - \`s_mark\` (symbol marks for cascade)
    Cyberheist City, Sweet Bonanza, Sugar Rush family — all PP cascade games — emit ≥1 of these per cascade response. If you see them, the game IS cascade even if isEndRound is absent. \`free_spin_chains\` should also be \`true\` if you see free spin fields (\`rs_c\`, \`rs_m\` typically increase across free spin rounds).
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

Critical requirements for math mechanic classification (drives rule engine payout verification):
16. **mechanic_type**: Classify the math model. Look at paytable structure + features + response shape:
    - "cluster"  → paytable lists symbols with sizes like "5-7", "8-10", "11+" (not "3,4,5"); features mention "cluster"/"tumble"/"cascade"; response has rs_more/rs_iw/rs_t fields → Sweet Bonanza, Sugar Rush, Cyberheist City, vswayscyhecity
    - "ways"     → paytable has fixed match counts {3,4,5} for adjacency-based wins; features say "ways" or "ALL WAYS"; 25/125/243/3125 ways advertised → fiesta-magenta, fortune-pig
    - "paylines" → paytable has 3/4/5-of-a-kind per line; features mention "X paylines"; line patterns exist in config
    - "megaways" → variable rows per reel (2-7 symbols/reel); features mention "Megaways" or "117649 ways" — Big Time Gaming family
    - "lines"    → alias for paylines (rare, use "paylines" when uncertain)
    - "unknown"  → use ONLY if you cannot determine from samples; rule engine will fall back to ways (likely incorrect verification)

17. **cascade**: true if winning symbols disappear and new symbols drop in. Detect from:
    - Response fields: rs_more, rs_iw, rs_t, sa, sb (cascade state)
    - Features mention "Tumble", "Cascade", "Avalanche", "Re-spin"
    - na="c" (next action = continue cascade) in any sample

18. **cluster_min_size**: ONLY if mechanic_type="cluster". Default 5 (Sweet Bonanza family). Read from paytable — smallest match size listed.

19. **paylines**: ONLY if mechanic_type="paylines" AND you can extract line layouts from config samples. Each line = array of row indices (0=top), length = reel count. Leave undefined if unclear — paylines mechanic will use default all-rows.

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
    label: "authoring/GENERATE-legacy",
    timeoutMs: Number(process.env.QA_AUTHORING_TIMEOUT_MS ?? process.env.QA_CLAUDE_TIMEOUT_MS ?? 3_000_000),
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
    label: "authoring/GENERATE-cases",
    timeoutMs: Number(process.env.QA_AUTHORING_TIMEOUT_MS ?? process.env.QA_CLAUDE_TIMEOUT_MS ?? 300_000),
  });
  return extractCodeFromText(raw, "typescript");
}

/**
 * Hybrid test generator — template-based (KHÔNG dùng LLM).
 *
 * Có 2 chế độ:
 *   - **Catalog-driven** (recommended): truyền `catalog` → sinh 1 test per case từ
 *     `tests-cases.json`. Mỗi case map sang mock strategy:
 *       - mockable → use_scenario / spin_sequence với mock data
 *       - skip → test.skip với reason (cần LLM flow cho case này)
 *     Cover được 60-80% catalog deterministically.
 *
 *   - **Scenario-only fallback**: không truyền catalog → 1 test per scenario.
 *     Đơn giản nhưng narrow coverage (N test = N scenario).
 *
 * Trả null nếu slug không có scenario nào.
 */
export function generateHybridTestCode(args: {
  gameSlug: string;
  harnessImportPath: string; // unused — hybrid không dùng test-harness, chỉ để symmetric API
  envVarUrl: string;
  spinButton?: { x: number; y: number };
  catalog?: TestCaseCatalog | null;
}): string | null {
  const { gameSlug, envVarUrl, catalog } = args;
  const scenarioNames = listScenarios(gameSlug);
  if (scenarioNames.length === 0) return null;
  // Auto-detect spin button coord từ recording. User có thể override qua args.
  const spinButton = args.spinButton ?? detectSpinButtonCoord(gameSlug);

  const availableScenarios: AvailableScenario[] = scenarioNames.map((name) => {
    const scenario = loadScenario(gameSlug, name);
    return { name, label: scenario.label, scenario };
  });

  // Catalog-driven mode
  if (catalog && catalog.cases && catalog.cases.length > 0) {
    const coverage = summarizeCoverage(catalog.cases, availableScenarios, gameSlug);
    // Partition tests: stateless (shared session) vs stateful (isolated per test).
    // Only real_network_verify strategy được wire shared session — các strategy
    // khác (replay_or_vision, fs_chain_replay, ...) vẫn isolated.
    const sharedBlocks: string[] = [];
    const isolatedBlocks: string[] = [];
    const coverageRows: string[] = [];

    for (const tc of catalog.cases) {
      const strategy = strategyFor(tc, availableScenarios, { slug: gameSlug });
      const isStateless = isStatelessTest(tc, strategy);
      const canShare = isStateless && strategy.type === "real_network_verify";
      const block = emitTestBlock({
        testCase: tc,
        strategy,
        slug: gameSlug,
        spinButton,
        sharedSession: canShare,
      });
      if (canShare) sharedBlocks.push(block);
      else isolatedBlocks.push(block);
      let flag: string;
      if (strategy.type === "skip") flag = "SKIP";
      else if (strategy.type === "spin_sequence") flag = "SEQ ";
      else if (strategy.type === "cascade_chain") flag = "CASC";
      else if (strategy.type === "free_spin_chain") flag = "FREE";
      else if (strategy.type === "use_scenario" && strategy.overrides) flag = "SYN ";
      else flag = "MOCK";
      const sessionFlag = canShare ? "[shared]" : "[iso]   ";
      coverageRows.push(`//  ${sessionFlag} [${flag}] ${tc.id.padEnd(40)} — ${strategy.reason.slice(0, 70)}`);
    }
    const testBlocks: string[] = []; // kept for legacy reference in fallback below

    const coverageLines = [
      `// Coverage: ${coverage.mockable}/${coverage.total} active (${coverage.skipped} skipped)`,
      `// Breakdown:`,
      `//   MOCK = ${coverage.mockable - coverage.spinSequence - coverage.synthesized - coverage.cascadeChain - coverage.freeSpinChain} (use scenario as-is)`,
      `//   SYN  = ${coverage.synthesized} (synthesize override bet/win/balance)`,
      `//   SEQ  = ${coverage.spinSequence} (autoplay rotate)`,
      `//   CASC = ${coverage.cascadeChain} (cascade chain N responses)`,
      `//   FREE = ${coverage.freeSpinChain} (free spin chain N responses)`,
      `//   SKIP = ${coverage.skipped} (cần LLM flow)`,
      `// `,
      ...coverageRows,
    ].join("\n");

    return `// Auto-generated CATALOG-DRIVEN hybrid test for "${gameSlug}".
// Source: ${catalog.total_cases} cases từ fixtures/specs/${gameSlug}/${gameSlug}.test-cases.json
// + ${availableScenarios.length} scenarios từ fixtures/scenarios/${gameSlug}/.
//
// Mock strategy:
//   MOCK = use 1 scenario response
//   SEQ  = rotate N scenarios cho autoplay
//   SKIP = test.skip với reason (cần LLM flow)
//
${coverageLines}

import { test, expect } from "@playwright/test";
import { makeDeterministic } from "../../src/runner/deterministic.js";
import {
  spinDeterministic,
  assertSpinMatchesExpected,
} from "../../src/runner/deterministic-spin.js";
import { preGameWithReplayOrVision } from "../../src/runner/pre-game-replay.js";
import { runCaseActionWithReplayOrVision } from "../../src/runner/case-action.js";
import { loadScenario } from "../../src/runner/scenario.js";
import {
  assertUIMatchesResponse,
  extractExpectedFromResponse,
} from "../../src/runner/ui-verifier.js";
import { assertPayoutMatchesPaytable } from "../../src/runner/rule-engine.js";
import {
  spinReal,
  computeBet,
  computeWin,
  verifyShape,
  verifyBalanceConservation,
  verifyMaxWinCap,
  verifyWinPatternConsistency,
  verifyStateConsistency,
  dismissAnyModal,
} from "../../src/runner/spin-verify.js";
import { resolveSpinButton } from "../../src/runner/spin-button-resolve.js";

const GAME_URL = process.env.${envVarUrl};
if (!GAME_URL) throw new Error("${envVarUrl} required");

const SLUG = "${gameSlug}";
const VIEWPORT = { width: 1440, height: 900 };
// SPIN_BUTTON = fallback hardcode từ recording. Khi vision return bbox tại
// pre-game, resolveSpinButton dùng bbox center (live, không stale) → SPIN_BUTTON
// chỉ là safety net khi vision không locate được button (vd replay path).
const SPIN_BUTTON = { x: ${spinButton.x}, y: ${spinButton.y} };

${sharedBlocks.length > 0 ? `// ===== SHARED SESSION =====
// ${sharedBlocks.length} stateless tests — 1 browser + 1 pre-game upfront → 4× faster.
// KHÔNG dùng .serial vì auto-cascade-skip khi 1 fail → đè full block. Tests
// ở đây independent enough (mỗi test = dismissModal + spinReal), failure isolated.
test.describe(\`Hybrid shared session — \${SLUG}\`, () => {
  test.setTimeout(4 * 60_000);
  let sharedPage: import("playwright").Page;
  // Resolved trong beforeAll từ vision bbox (nếu có) → tests đọc tại click time.
  let sharedSpinButton: { x: number; y: number } = SPIN_BUTTON;
  let sharedSpinButtonLive = false;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    sharedPage = await context.newPage();
    await sharedPage.goto(GAME_URL);
    const ready = await preGameWithReplayOrVision(sharedPage, {
      slug: SLUG,
      viewport: VIEWPORT,
      label: "shared-session-pregame",
    });
    if (!ready.ready) {
      throw new Error(\`shared session pre-game không ready (source=\${ready.source})\`);
    }
    const sb = resolveSpinButton(ready, SPIN_BUTTON);
    sharedSpinButton = sb.coord;
    sharedSpinButtonLive = sb.live;
    console.log(\`[shared-session] pre-game ready (source=\${ready.source}) — spin button (\${sharedSpinButton.x},\${sharedSpinButton.y}) source=\${sb.source} — running \${${sharedBlocks.length}} stateless tests\`);
  });

  test.afterAll(async () => {
    if (sharedPage) await sharedPage.close().catch(() => {});
  });

${sharedBlocks.join("\n\n")}
});

` : ""}// ===== ISOLATED SESSION =====
// ${isolatedBlocks.length} stateful tests — fresh page mỗi test (stateful action,
// FS chain, autoplay, buy_feature, ...). Pre-game riêng cho từng test.
test.describe(\`Hybrid isolated — \${SLUG}\`, () => {
  test.setTimeout(4 * 60_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

${isolatedBlocks.join("\n\n")}
});
`;
  }

  // Scenario-only fallback mode
  const testBlocks: string[] = [];
  for (const av of availableScenarios) {
    const exp = av.scenario.expected;
    const expFields = [
      exp.bet != null ? `bet: ${exp.bet}` : null,
      exp.win != null ? `win: ${exp.win}` : null,
      exp.starting_balance != null ? `starting_balance: ${exp.starting_balance}` : null,
      exp.ending_balance != null ? `ending_balance: ${exp.ending_balance}` : null,
      exp.has_bonus != null ? `has_bonus: ${exp.has_bonus}` : null,
      exp.is_free_spin != null ? `is_free_spin: ${exp.is_free_spin}` : null,
    ]
      .filter(Boolean)
      .join(",\n      ");

    const extraAssertions =
      av.name === "no_win" &&
      exp.bet != null &&
      exp.starting_balance != null &&
      exp.ending_balance != null
        ? `
    expect(handle.scenario.expected.ending_balance, "no_win: ending = starting - bet").toBeCloseTo(
      handle.scenario.expected.starting_balance! - handle.scenario.expected.bet!,
      2,
    );`
        : "";

    testBlocks.push(`  test("${av.name} — verify mocked response + UI", async ({ page }) => {
    const handle = await makeDeterministic(page, {
      slug: SLUG,
      scenario: "${av.name}",
      spinOnly: true,
      noFreeze: true,
    });
    await page.goto(GAME_URL);
    const ready = await preGameWithReplayOrVision(page, {
      slug: SLUG,
      viewport: VIEWPORT,
      label: "pregame-${av.name}",
    });
    expect(ready.ready, \`pre-game không ready (source=\${ready.source})\`).toBe(true);
    const sb = resolveSpinButton(ready, SPIN_BUTTON);

    const result = await spinDeterministic(page, handle, { spinButton: sb.coord });
    expect(result.parsed).not.toBeNull();
    assertSpinMatchesExpected(result, {
      ${expFields},
    });
    expect(handle.spinRequestCount).toBeGreaterThanOrEqual(1);${extraAssertions}
  });`);
  }

  return `// Auto-generated scenario-only hybrid test for "${gameSlug}".
// Pattern: 1 test() per scenario. Pass catalog vào generateHybridTestCode()
// để có catalog-driven mode với rich coverage.

import { test, expect } from "@playwright/test";
import { makeDeterministic } from "../../src/runner/deterministic.js";
import {
  spinDeterministic,
  assertSpinMatchesExpected,
} from "../../src/runner/deterministic-spin.js";
import { preGameWithReplayOrVision } from "../../src/runner/pre-game-replay.js";
import { resolveSpinButton } from "../../src/runner/spin-button-resolve.js";

const GAME_URL = process.env.${envVarUrl};
if (!GAME_URL) throw new Error("${envVarUrl} required");

const SLUG = "${gameSlug}";
const VIEWPORT = { width: 1440, height: 900 };
const SPIN_BUTTON = { x: ${spinButton.x}, y: ${spinButton.y} };

test.describe(\`Hybrid scenario-only — \${SLUG}\`, () => {
  test.setTimeout(4 * 60_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

${testBlocks.join("\n\n")}
});
`;
}

/**
 * Unified codegen — emit 1 spec file với BOTH style (mock + LLM).
 *
 * Logic per case:
 *   - strategyFor(case, scenarios) = use_scenario | spin_sequence → emit hybrid mock test
 *   - strategyFor(case, scenarios) = skip → emit LLM-driven test (doAutoSpin)
 *
 * Result: 27 cases run hết, không có test.skip. Cost-optimized (mock những gì
 * mock được, LLM cho phần còn lại).
 *
 * Pre-requisite:
 *   - fixtures/specs/{slug}/{slug}.test-cases.json (catalog từ Phase 2 Generate)
 *   - fixtures/scenarios/{slug}/*.json (scenarios từ Phase 1 Collect)
 *
 * Trả null nếu thiếu catalog (caller fallback sang generateHybridTestCode hoặc
 * generateParameterizedTestCode).
 */
export function generateUnifiedTestCode(args: {
  gameSlug: string;
  envVarUrl: string;
  spinButton?: { x: number; y: number };
  catalog: TestCaseCatalog;
}): string | null {
  const { gameSlug, envVarUrl, catalog } = args;
  if (!catalog || !catalog.cases || catalog.cases.length === 0) return null;
  // Auto-detect spin button coord từ recording. User có thể override qua args.
  const spinButton = args.spinButton ?? detectSpinButtonCoord(gameSlug);
  const scenarioNames = listScenarios(gameSlug);

  const availableScenarios: AvailableScenario[] = scenarioNames.map((name) => {
    const scenario = loadScenario(gameSlug, name);
    return { name, label: scenario.label, scenario };
  });

  const coverage = summarizeCoverage(catalog.cases, availableScenarios);
  const testBlocks: string[] = [];
  const coverageRows: string[] = [];
  let mockCount = 0;
  let llmCount = 0;

  for (const tc of catalog.cases) {
    const strategy = strategyFor(tc, availableScenarios, { slug: gameSlug });
    if (strategy.type === "skip") {
      testBlocks.push(emitLLMTestBlock({ testCase: tc, reason: strategy.reason }));
      coverageRows.push(`//  [LLM ] ${tc.id.padEnd(40)} — ${strategy.reason.slice(0, 80)}`);
      llmCount++;
    } else {
      testBlocks.push(emitTestBlock({ testCase: tc, strategy, slug: gameSlug, spinButton }));
      const flag = strategy.type === "spin_sequence" ? "SEQ " : "MOCK";
      coverageRows.push(`//  [${flag}] ${tc.id.padEnd(40)} — ${strategy.reason.slice(0, 80)}`);
      mockCount++;
    }
  }

  const coverageLines = [
    `// Coverage: ${coverage.total} cases — ${mockCount} mock (${coverage.spinSequence} sequence + ${mockCount - coverage.spinSequence} single) + ${llmCount} LLM`,
    `// Cost estimate: ~$${(mockCount * 0.1 + llmCount * 0.5).toFixed(2)} (mock@$0.10 + LLM@$0.50 per case avg)`,
    `// `,
    ...coverageRows,
  ].join("\n");

  return `// Auto-generated UNIFIED hybrid+LLM test for "${gameSlug}".
// Source: ${catalog.total_cases} cases + ${availableScenarios.length} scenarios.
//
// Strategy auto-routing per case:
//   MOCK = makeDeterministic + spinDeterministic (deterministic, cheap)
//   SEQ  = rotate N scenarios cho autoplay (deterministic)
//   LLM  = doAutoSpin (vision per spin, fallback cho case không mockable)
//
${coverageLines}

import { test, expect } from "@playwright/test";
// Mock-style imports
import { makeDeterministic } from "../../src/runner/deterministic.js";
import {
  spinDeterministic,
  assertSpinMatchesExpected,
} from "../../src/runner/deterministic-spin.js";
import { preGameWithReplayOrVision } from "../../src/runner/pre-game-replay.js";
import { runCaseActionWithReplayOrVision } from "../../src/runner/case-action.js";
import { loadScenario } from "../../src/runner/scenario.js";
import {
  assertUIMatchesResponse,
  extractExpectedFromResponse,
} from "../../src/runner/ui-verifier.js";
import { assertPayoutMatchesPaytable } from "../../src/runner/rule-engine.js";
import {
  spinReal,
  computeBet,
  computeWin,
  verifyShape,
  verifyBalanceConservation,
  verifyMaxWinCap,
  verifyWinPatternConsistency,
  verifyStateConsistency,
  dismissAnyModal,
} from "../../src/runner/spin-verify.js";
import { resolveSpinButton } from "../../src/runner/spin-button-resolve.js";
// LLM-style imports
import {
  openGame,
  doAutoSpin,
  setActiveCase,
  keepBrowserOpenIfRequested,
} from "../../src/runner/test-harness.js";

const GAME_URL = process.env.${envVarUrl};
if (!GAME_URL) throw new Error("${envVarUrl} required");

const SLUG = "${gameSlug}";
const VIEWPORT = { width: 1440, height: 900 };
const SPIN_BUTTON = { x: ${spinButton.x}, y: ${spinButton.y} };

test.describe(\`Unified (mock+LLM) — \${SLUG}\`, () => {
  // LLM cases có thể tốn 30-120s/case → cho timeout rộng
  test.setTimeout(10 * 60_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

${testBlocks.join("\n\n")}
});
`;
}
