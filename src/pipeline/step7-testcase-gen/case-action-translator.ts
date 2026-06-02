// AI: called only during cold-start | recovery | post-FAIL
//
// Translates natural-language `setup_instructions` from an AI-generated catalog
// case into a structured action sequence the case-executor can run. One AI call
// per case at cold-start, then cached in `test-cases.actions.json`. Subsequent
// runs (warm-start) load from cache — zero AI cost.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { dirForGame } from "../registry/paths.js";
import { formatRegistryHierarchy } from "../registry/hierarchy.js";
import type { UiRegistry } from "../registry/types.js";

export type CaseAction =
  | { kind: "click"; uiKey: string; times?: number; reason?: string }
  | { kind: "wait_ms"; ms: number }
  | { kind: "spin" }
  | { kind: "set_bet_to_min" }
  | { kind: "set_bet_to_max" }
  | { kind: "set_bet_to_value"; value: number; maxAttempts?: number; reason?: string }
  | { kind: "dismiss"; reason?: string }
  | { kind: "reset" }
  // Gap D — Adaptive waits. Replace blind wait_ms with predicate-based
  // waits so flaky timings (different game speeds, slow CI machines)
  // don't break tests.
  | { kind: "wait_until_state"; state: string; maxMs?: number; reason?: string }
  | { kind: "wait_until_network_idle"; idleMs?: number; maxMs?: number; reason?: string }
  | { kind: "wait_until_pixel_stable"; consecutiveStable?: number; maxMs?: number; reason?: string }
  | {
      // Autoplay-aware wait: returns when no spin-response captured for `quietMs`
      // (default 5000ms). Use instead of `wait_until_state MAIN` for autoplay
      // batches — MAIN state flickers briefly between rounds so wait_until_state
      // returns at spin #1 not spin #N.
      kind: "wait_until_no_spin_response";
      quietMs?: number;
      maxMs?: number;
      reason?: string;
    };

export type TranslatedCase = {
  caseId: string;
  actions: CaseAction[];
  /** Reason if the AI translator couldn't produce actions. */
  skipReason?: string;
};

export type CaseActionsCache = {
  schemaVersion: 1;
  generatedAt: string;
  cases: Record<string, TranslatedCase>;
};

const CACHE_FILE = "test-cases.actions.json";

export async function loadCache(slug: string): Promise<CaseActionsCache | null> {
  const { appendBuiltinActions } = await import("./builtin-cases.js");
  let cache: CaseActionsCache | null = null;
  try {
    cache = JSON.parse(await readFile(path.join(dirForGame(slug), CACHE_FILE), "utf8")) as CaseActionsCache;
  } catch {
    cache = null;
  }
  // Inject deterministic actions for built-in cases (e.g. payout-integrity) so
  // they're runnable without AI translation and survive regeneration. When no
  // cache file exists yet, synthesize one ONLY if a built-in actually applies
  // (PP-gated) — otherwise preserve the prior null (= "not translated yet").
  const base: CaseActionsCache = cache ?? { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: {} };
  const withBuiltins = await appendBuiltinActions(base, slug);
  if (cache === null && Object.keys(withBuiltins.cases).length === 0) return null;
  return withBuiltins;
}

export async function saveCache(slug: string, cache: CaseActionsCache): Promise<void> {
  await writeFile(
    path.join(dirForGame(slug), CACHE_FILE),
    JSON.stringify(cache, null, 2) + "\n",
    "utf8",
  );
}

const SYSTEM_PROMPT = `You are a QA test automation engineer. You translate natural-language setup instructions for slot-game test cases into a structured JSON action sequence. Output ONLY valid JSON — no prose, no markdown fences.

Available actions:
- {"kind":"click","uiKey":"<key>","times":N,"reason":"<short>"} — click a UI element N times (default 1). uiKey MUST EXIST in the provided uiMap_hierarchy (case-sensitive, exact match).
- {"kind":"wait_ms","ms":<int>} — fixed wait (PREFER predicate waits below for non-trivial pauses)
- {"kind":"wait_until_state","state":"<MAIN|FREE_SPIN|BIG_WIN_POPUP|...>","maxMs":<int>,"reason":"<short>"} — poll game state every 500ms until matched (or timeout). Use INSTEAD of wait_ms when waiting for a known state transition. Less flaky than fixed timing.
- {"kind":"wait_until_network_idle","idleMs":<int>,"maxMs":<int>} — wait until no network requests in flight for idleMs (default 1500ms). Use after triggering an action that fires API calls (spin, buy, autoplay start).
- {"kind":"wait_until_pixel_stable","consecutiveStable":<int>,"maxMs":<int>} — wait until viewport pixels stable across N consecutive samples (default 3). Use to wait for spin animation to fully stop.
- {"kind":"wait_until_no_spin_response","quietMs":<int>,"maxMs":<int>,"reason":"<short>"} — wait until no spin-response captured for quietMs (default 5000). USE THIS FOR AUTOPLAY BATCHES instead of wait_until_state MAIN — autoplay games flicker MAIN between rounds so wait_until_state returns prematurely. quietMs=5000 + maxMs=180000 is a sensible default for autoplay batches up to 30 rounds.
- {"kind":"spin"} — trigger a spin (clicks spinButton if present)
- {"kind":"set_bet_to_min"} — click betMinus repeatedly until min reached (helper)
- {"kind":"set_bet_to_max"} — click betPlus repeatedly until max reached (helper)
- {"kind":"set_bet_to_value","value":<number>,"reason":"<short>"} — OCR-verified bet navigation. Engine reads bet widget via OCR after each click, stops when displayed value matches target. PREFER THIS over hardcoded \`click betMinus times=N\` for arbitrary bet targets — N depends on current bet which is unknown ahead of time. Falls back to set_bet_to_min if betArea OCR not configured.
- {"kind":"dismiss","reason":"<short>"} — wait 10s then click center of viewport 2x. Use for "PRESS ANYWHERE TO CONTINUE" / celebration / free-spin-start interstitials. The 10s wait covers full animation chain (buy → spin → stop → celebration).
- {"kind":"reset"} — return to default state (reload page, internal helper)

ADAPTIVE WAIT PREFERENCE (reduces flakiness — but with critical exceptions):
- **AFTER A SPIN, USE wait_ms 2500 (NOT wait_until_network_idle).** The engine
  has provider-aware round-end signal detection (PP: action=doCollect) that
  blocks the next spin click until the game ACTUALLY emits the round-end
  signal, even if cascade animation is still running. So a small wait_ms
  buffer (2500ms) is enough — the round-end gate handles the cascade case.
  Don't use wait_until_network_idle: cascade games emit constant background
  traffic (telemetry, asset prefetch, heartbeat) so the predicate rarely
  resolves.
- Prefer wait_until_state when expecting a known transition AWAY from MAIN (e.g.,
  wait_until_state FREE_SPIN_TRIGGERED after buy-feature confirm). Avoid
  wait_until_state MAIN right after a spin — autoplay/cascade games stay in MAIN
  the whole time so the predicate fires immediately and the wait is useless.
- wait_until_network_idle is ONLY useful for non-spin actions: buy-feature confirm,
  autoplay-start button, page navigation. Not for between-spin pauses.
- Use wait_ms for everything else: ≤500ms for short gaps (popup open/close),
  2500ms between spins, 1500-2500ms after non-spin clicks.

Critical rules about the uiMap_hierarchy:
- Top-level keys (no "__") are MAIN-state buttons available in the default game screen.
- Keys with "__" are NESTED (e.g. "buyBonusButton__freeSpinsOption" means clicking buyBonusButton opens a popup containing freeSpinsOption).
- To click a nested element, your action sequence MUST first click each ancestor in order so the popup is open. Example to click "a__b__c": [{click a}, {wait_ms 1500}, {click a__b}, {wait_ms 1500}, {click a__b__c}].
- Entries marked [human-verified] have HIGHLY trusted coordinates; prefer them over unverified ones if alternatives exist.
- DO NOT invent uiKeys not in the hierarchy. If a required element is missing, output {"actions":[],"reason":"missing uiKey <name>"}.

Bet adjustment rules (CRITICAL):
- **DEFAULT: emit \`{"kind":"set_bet_to_value","value":<target>}\` for ANY arbitrary bet target.** Engine reads bet widget via OCR after each click and stops when displayed value matches target. Robust to unknown starting bet (auto-detects current value). Use this UNLESS target is exactly min or max (then use set_bet_to_min / set_bet_to_max).
- betMinus and betPlus are STEP buttons (decrease/increase by 1 ladder rung).
  In SOME PP games they ALSO open a bet-selection popup when clicked — this is
  game-specific.
- ONLY emit hardcoded \`click betMinus times=N\` when:
  - You see a registered POPUP uiKey like \`betMinus__betAmount-0.50\` in the uiMap_hierarchy AND
  - The case explicitly wants to test the popup-selection UI (not just set bet value).
- For ALL OTHER bet adjustments → use \`set_bet_to_value\` (or \`set_bet_to_min\` / \`set_bet_to_max\` for those exact targets). The hardcoded times=N approach assumes a known starting ladder index, which is unreliable across sessions.
- To open a bet-selection POPUP (when the game has one): emit a SINGLE click on
  betMinus (\`times\` omitted or =1). The engine auto-clicks the sibling button
  (betPlus) as a fallback in case betMinus is disabled because bet is already
  at min — so the popup reliably opens regardless of current bet edge state.
- NEVER emit clicks like \`betMinus__bet-X.XX\` unless you actually see that EXACT uiKey in the uiMap_hierarchy. If the popup doesn't exist, use \`set_bet_to_value\` instead.
- If at ladder min already and target = min → no clicks needed. set_bet_to_min is a no-op if already at min.

BET BEFORE FIRST SPIN (CRITICAL — bet leaks across cases):
- The game session is SHARED across cases, so the previous case's last bet level persists into this case. Before the FIRST {"kind":"spin"} in your action sequence you MUST emit a bet-setting action so the spin runs at a known bet — otherwise balance / win / payout assertions fail intermittently depending on run order.
- Choose the setter by examining the case's custom_assertions list (provided below) and setup intent:
  - **Assertion pins a specific betAmount** (e.g. \`spin.betAmount === 7.00\` or \`Math.abs(spin.betAmount - 7.00) <= 0.01\`) → emit \`{"kind":"set_bet_to_value","value":<that number>}\`. ANCHORING TO MIN HERE BREAKS THE ASSERTION. The "default-bet-equals-X" cases are the canonical example — even with empty setup, the bet MUST be set to X first because previous cases may have left bet elsewhere.
  - Setup targets a specific bet (e.g. "set bet to 2.00 then spin") → use \`set_bet_to_value\` / \`set_bet_to_min\` / \`set_bet_to_max\` as the setup implies.
  - Bet-agnostic case (RTP, balance conservation, payout integrity, free-spin trigger, autoplay, multi-spin loops, etc.) → emit {"kind":"set_bet_to_min"} as a deterministic anchor (cheapest, no OCR, robust across sessions).
- Place the setter BEFORE the first spin — typically at the very start of the actions array, after any popup-navigation clicks that the setup needs.
- Skip ONLY when SPIN POLICY = FORBIDDEN (no spin runs, so no anchor needed).

Buy-feature / free-spin trigger pattern (CRITICAL):
- After clicking a "yes" / "confirm" button in a buy-feature popup (e.g. \`buyBonusButton__freeSpinsOption__yesButton\`), a CELEBRATION popup appears: "CONGRATULATIONS YOU WON N FREE SPINS — PRESS ANYWHERE TO CONTINUE".
- This popup BLOCKS the free-spin chain from starting. You MUST emit a {"kind":"dismiss"} action right after the confirm click to wait + click anywhere to clear it.
- After dismiss, the FS chain auto-plays for ~30-90s. **YOU MUST emit a final \`wait_until_state\` action AFTER dismiss** so the engine keeps the network listener attached until the chain completes. Without it, engine's default 10s settle window expires before the first FS spin even lands → catalog assertions fail to find FS frames.
- Pattern (FULL, for buy-feature → FS):
  \`[click yesButton] → [wait_ms 500] → [dismiss] → [wait_until_state MAIN maxMs=120000 "wait FS chain to complete"]\`
- For organic FS triggers (scatter + spin) without buy-feature: same pattern minus the buyBonus click.

Multi-spin rules (CRITICAL):
Two paths to multi-spin — pick based on case intent + registered uiKeys:

PATH 1 — Spin loop (preferred default, for data-only cases):
- Use when case wants N spin records for assertion (RTP, conservation, length>=N).
- Emit: \`{"kind":"spin"}, {"kind":"wait_ms","ms":2500}\` repeated N times. 2500ms
  is a buffer; the engine's round-end signal detection actually gates the next
  click (so even big-cascade rounds are handled correctly without longer waits).
- Skip autoplay UI entirely. Faster, simpler, no slider needed.
- For N≥50: truncate to 10-20 spins, note "truncated from N to 20 to keep action sequence finite".

PATH 2 — Autoplay UI flow (only when case TESTS autoplay UI):
- Use ONLY if setup_instructions explicitly mention "autoplay panel", "start button", "autoplay UI", or test specifically targets autoplay UI behavior.
- Required: uiMap_hierarchy must contain registered preset uiKeys for value selection, e.g.:
  - \`autoButton__autoCountSlide-10\`, \`autoButton__autoCountSlide-30\`, \`autoButton__autoCountSlide-100\` (click target N — values come from the backend slider-stop synthesis, typically {10,20,30,50,70,100,500,1000})
  - \`autoButton__startAutoplayButton\` (start)
- Pattern: \`[click autoButton] → [wait_ms 1500] → [click autoButton__autoCountSlide-N] → [wait_ms 500] → [click autoButton__startAutoplayButton] → [wait_until_no_spin_response quietMs=5000 maxMs=180000 reason="wait autoplay batch of N to complete"]\`. The final wait_until_no_spin_response keeps the listener attached until ALL N rounds finish — DO NOT use wait_until_state MAIN here, autoplay flickers MAIN between rounds and the wait returns at spin #1.
- If preset uiKey for target N doesn't exist → FALL BACK to PATH 1 (spin loop). DO NOT attempt to drag sliders — there's no drag action available.
- Slider preset uiKeys must be REGISTERED VIA MANUAL Pick in Game by QA. If missing → spin loop only.

Other rules:
1. If setup_instructions is empty or trivial ("default state"), output {"actions":[],"reason":"no setup needed"}.
2. Include a final {"kind":"spin"} ONLY when the case actually needs a spin
   for its assertions to fire. Use these explicit rules:
   - If "SPIN POLICY: REQUIRED" is included below → emit final spin.
   - If "SPIN POLICY: FORBIDDEN" is included below → DO NOT emit any spin
     action AT ALL (the case asserts no-spin or is pure UI inspection).
   - If "SPIN POLICY: OPTIONAL" → judge by setup intent: spin only if the
     setup configures something that needs a spin to verify (bet change,
     turbo toggle, etc.). Cases inspecting menus, settings toggles,
     paytable popups, history popups, info screens → NO spin.
3. Prefer high-level helpers in this order: set_bet_to_min/max for min/max targets, set_bet_to_value for arbitrary numeric targets, hardcoded click betMinus only for popup-selection UI testing.
4. Use wait_ms 1500 after each navigation click (popup opening) and wait_ms 2500 after each spin.
5. Output format: {"actions":[<list>],"reason":"<optional explanation if actions=[]>"}.`;

/** Extract a pinned betAmount target from a case's custom_assertions, if
 *  any assertion equates spin.betAmount to a specific number. Used by both
 *  the empty-setup short-circuit and the post-process safety net so the bet
 *  anchor matches what the assertion expects — anchoring to MIN would FAIL
 *  any case whose assertion expects a specific bet (e.g. default-bet=7).
 *  Returns null when no betAmount equality pattern is found. */
export function extractPinnedBetAmount(
  customAssertions: Array<{ check_code?: string }> | undefined,
): number | null {
  if (!customAssertions) return null;
  for (const a of customAssertions) {
    const code = a.check_code;
    if (!code) continue;
    // Pattern 1: spin.betAmount === 7.00 / spin.betAmount == 7
    const eqMatch = code.match(/spin\.betAmount\s*===?\s*(\d+(?:\.\d+)?)/);
    if (eqMatch) return Number(eqMatch[1]);
    // Pattern 2: Math.abs(spin.betAmount - 7.00) <= 0.01
    const absMatch = code.match(/Math\.abs\(\s*spin\.betAmount\s*-\s*(\d+(?:\.\d+)?)/);
    if (absMatch) return Number(absMatch[1]);
  }
  return null;
}

/** Decide SPIN POLICY for the translator AI based on catalog metadata.
 *  REQUIRED → emit final spin; FORBIDDEN → emit no spin; OPTIONAL → judge.
 *  Exported so test cases can pin policy resolution behavior. */
export function resolveSpinPolicy(args: {
  spinCount?: number;
  category?: string;
  customAssertions?: Array<{ check_code?: string }>;
}): { policy: "REQUIRED" | "FORBIDDEN" | "OPTIONAL"; reason: string } {
  // 1. Explicit negative-spin assertion → FORBIDDEN
  const assertions = args.customAssertions ?? [];
  const negativeSpinPattern = /collector\.spins\.length\s*===?\s*0\b/;
  if (assertions.some((a) => a.check_code && negativeSpinPattern.test(a.check_code))) {
    return { policy: "FORBIDDEN", reason: "assertion checks collector.spins.length === 0" };
  }
  // 2. spin_count = 0 (catalog explicitly says no spins) → FORBIDDEN
  if (args.spinCount === 0) {
    return { policy: "FORBIDDEN", reason: "catalog spin_count = 0" };
  }
  // 3. spin_count > 0 → REQUIRED
  if (typeof args.spinCount === "number" && args.spinCount > 0) {
    return { policy: "REQUIRED", reason: `catalog spin_count = ${args.spinCount}` };
  }
  // 4. Pure-UI categories — likely no spin needed but let AI decide
  if (
    args.category
    && /^(options|ui_consistency|history|paytable|rules_consistency|meta|settings)$/.test(args.category)
  ) {
    return { policy: "OPTIONAL", reason: `category=${args.category} (UI inspection — judge by setup)` };
  }
  // 5. Default — AI judges; rarely hit since catalog usually has spin_count
  return { policy: "OPTIONAL", reason: "no explicit signal (judge by setup)" };
}

function buildPrompt(input: {
  caseId: string;
  caseName: string;
  category: string;
  setup: string;
  uiMap: UiRegistry;
  gameSpec?: GameSpec;
  spinCount?: number;
  customAssertions?: Array<{ id?: string; check_code?: string }>;
}): string {
  const hierarchy = formatRegistryHierarchy(input.uiMap, { includeRejected: false });
  const specLines: string[] = [];
  if (input.gameSpec) {
    const s = input.gameSpec;
    if (s.betLadder?.length) specLines.push(`Bet ladder (achievable bet values): [${s.betLadder.join(", ")}]`);
    if (s.defaultBet !== undefined) specLines.push(`Current/default bet: ${s.defaultBet}`);
    if (s.betMin !== undefined) specLines.push(`Bet min: ${s.betMin}`);
    if (s.betMax !== undefined) specLines.push(`Bet max: ${s.betMax}`);
  }
  const policy = resolveSpinPolicy({
    spinCount: input.spinCount,
    category: input.category,
    customAssertions: input.customAssertions,
  });
  const spinPolicyLine = `\nSPIN POLICY: ${policy.policy} (reason: ${policy.reason})`;
  // Surface the assertion check_code values so AI can pick a bet anchor that
  // matches a pinned betAmount (see "BET BEFORE FIRST SPIN" in SYSTEM_PROMPT).
  // Truncated per-assertion to keep prompts short; the full code lives in the
  // catalog and runs at assertion time anyway.
  const assertionsBlock = (input.customAssertions && input.customAssertions.length > 0)
    ? "\nCustom assertions (these run AFTER actions; choose actions that make them pass):\n"
      + input.customAssertions
        .filter((a) => a.check_code)
        .map((a) => `- ${a.id ?? "(unnamed)"}: ${a.check_code!.slice(0, 240)}`)
        .join("\n")
    : "";
  const pinnedBet = extractPinnedBetAmount(input.customAssertions);
  const pinnedBetLine = pinnedBet != null
    ? `\nPINNED BET TARGET: an assertion expects spin.betAmount=${pinnedBet}. Anchor with set_bet_to_value(${pinnedBet}) before the first spin — do NOT use set_bet_to_min/max here.`
    : "";
  const spinCountLine = input.spinCount && input.spinCount > 1
    ? `\nSPIN COUNT REQUIREMENT: This case requires ${input.spinCount} spins. Emit ${input.spinCount} repeated {"kind":"spin"} actions (each followed by {"kind":"wait_ms","ms":2500} except the last), OR use autoplay UI to start a batch of ${input.spinCount} spins.`
    : "";
  return [
    `Case: ${input.caseId}`,
    `Name: ${input.caseName}`,
    `Category: ${input.category}`,
    "",
    "Setup instructions:",
    input.setup,
    "",
    "uiMap_hierarchy (only verified/pending; rejected excluded):",
    "```",
    hierarchy,
    "```",
    specLines.length > 0 ? "\nGame spec (use for ladder math):\n" + specLines.join("\n") : "",
    spinPolicyLine,
    spinCountLine,
    assertionsBlock,
    pinnedBetLine,
    "",
    "Output the actions JSON.",
  ].join("\n");
}

export type GameSpec = {
  betLadder?: number[];
  defaultBet?: number;
  betMin?: number;
  betMax?: number;
};

export async function translateCase(input: {
  caseId: string;
  caseName: string;
  category: string;
  setup: string;
  uiMap: UiRegistry;
  gameSpec?: GameSpec;
  /** Total spins required by the test (catalog's spin_count). Used so the
   *  empty-setup short-circuit emits the right number of spin clicks; the
   *  AI prompt also receives this for non-empty setups. */
  spinCount?: number;
  /** Catalog's custom_assertions for THIS case. Used to detect "no-spin"
   *  intent (e.g. assertion `collector.spins.length === 0`) so the translator
   *  doesn't emit a contaminating final spin. Passed both to the AI prompt
   *  (via SPIN POLICY) AND to the post-process safety net below. */
  customAssertions?: Array<{ id?: string; check_code?: string }>;
}): Promise<TranslatedCase & { aiCalled: boolean }> {
  // Resolve spin policy ONCE for use by both empty-setup short-circuit AND
  // the post-process safety net after AI returns.
  const policy = resolveSpinPolicy({
    spinCount: input.spinCount,
    category: input.category,
    customAssertions: input.customAssertions,
  });

  // Empty setup → trivial spin-only case, no AI needed.
  if (!input.setup || input.setup.trim().length === 0) {
    // FORBIDDEN policy → emit zero actions (case asserts no-spin or
    // spin_count=0). Empty actions + skipReason tells the runner this is OK.
    if (policy.policy === "FORBIDDEN") {
      return {
        caseId: input.caseId,
        actions: [],
        skipReason: `no setup + no spin needed (${policy.reason})`,
        aiCalled: false,
      };
    }
    const n = Math.max(1, input.spinCount ?? 1);
    // Anchor bet to a known value before the first spin — game session is
    // shared across cases, so without this the spin inherits the previous
    // case's bet level. See "BET BEFORE FIRST SPIN" in SYSTEM_PROMPT. If the
    // case asserts a specific betAmount, anchor to THAT value (set_bet_to_value)
    // so the assertion holds; otherwise default to set_bet_to_min (cheapest,
    // no OCR required).
    const pinnedBet = extractPinnedBetAmount(input.customAssertions);
    const betAnchor: CaseAction = pinnedBet != null
      ? { kind: "set_bet_to_value", value: pinnedBet, reason: `assertion pins betAmount=${pinnedBet}` }
      : { kind: "set_bet_to_min" };
    const actions: CaseAction[] = [
      betAnchor,
      { kind: "wait_ms", ms: 800 },
    ];
    for (let i = 0; i < n; i++) {
      actions.push({ kind: "spin" });
      // 2500ms is a small buffer between clicks. Engine round-end signal
      // detection (PP doCollect, etc.) actually gates the next click, so
      // even big-cascade rounds work correctly without longer waits. See
      // case-executor.ts roundEndCount logic + provider spec roundEndSignals.
      if (i < n - 1) actions.push({ kind: "wait_ms", ms: 2500 });
    }
    return { caseId: input.caseId, actions, aiCalled: false };
  }

  const prompt = buildPrompt(input);
  let raw: string;
  try {
    raw = await askClaude({
      content: prompt,
      system: SYSTEM_PROMPT,
      label: `case-translator/${input.caseId.slice(0, 30)}`,
      maxTurns: 1,
    });
  } catch (err) {
    return {
      caseId: input.caseId,
      actions: [],
      skipReason: `AI translator failed: ${err instanceof Error ? err.message : String(err)}`,
      aiCalled: true,
    };
  }

  const parsed = extractJsonFromText<{ actions: CaseAction[]; reason?: string }>(raw);
  if (!parsed) {
    return {
      caseId: input.caseId,
      actions: [],
      skipReason: "AI output not parseable as JSON",
      aiCalled: true,
    };
  }
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    return {
      caseId: input.caseId,
      actions: [],
      skipReason: parsed.reason ?? "AI returned empty actions",
      aiCalled: true,
    };
  }

  // Validate uiKey references.
  for (const a of parsed.actions) {
    if (a.kind === "click" && !input.uiMap[a.uiKey]) {
      return {
        caseId: input.caseId,
        actions: [],
        skipReason: `AI referenced missing uiKey: ${a.uiKey}`,
        aiCalled: true,
      };
    }
  }

  // POST-PROCESS SAFETY NET: enforce SPIN POLICY = FORBIDDEN by stripping
  // any spin actions the AI emitted anyway. Strips trailing wait_ms that
  // followed the spins (they're meaningless without the spin). Logs the
  // stripped count so debugging is obvious if QA wonders where actions went.
  if (policy.policy === "FORBIDDEN") {
    const beforeLen = parsed.actions.length;
    const filtered: CaseAction[] = [];
    for (let i = 0; i < parsed.actions.length; i++) {
      const a = parsed.actions[i]!;
      if (a.kind === "spin") continue; // drop spin
      filtered.push(a);
    }
    // Strip trailing wait_ms (it followed a now-removed spin)
    while (filtered.length > 0 && filtered[filtered.length - 1]!.kind === "wait_ms") {
      filtered.pop();
    }
    const stripped = beforeLen - filtered.length;
    if (stripped > 0) {
      console.warn(`[case-translator/${input.caseId}] SPIN POLICY=FORBIDDEN — stripped ${stripped} contaminating action(s) the AI emitted (${policy.reason})`);
    }
    return { caseId: input.caseId, actions: filtered, aiCalled: true };
  }

  // POST-PROCESS SAFETY NET: enforce BET BEFORE FIRST SPIN. The game session
  // is shared across cases, so without an anchor the first spin runs at
  // whatever bet the previous case left behind → flaky balance/win/payout
  // assertions. If the AI didn't emit a bet-setter before the first spin,
  // inject one. Anchor matches assertion intent: set_bet_to_value when an
  // assertion pins betAmount to a specific number, else set_bet_to_min.
  const firstSpinIdx = parsed.actions.findIndex((a) => a.kind === "spin");
  if (firstSpinIdx >= 0) {
    const prelude = parsed.actions.slice(0, firstSpinIdx);
    const hasBetSetter = prelude.some(
      (a) =>
        a.kind === "set_bet_to_min"
        || a.kind === "set_bet_to_max"
        || a.kind === "set_bet_to_value",
    );
    if (!hasBetSetter) {
      const pinnedBet = extractPinnedBetAmount(input.customAssertions);
      const injected: CaseAction = pinnedBet != null
        ? { kind: "set_bet_to_value", value: pinnedBet, reason: `assertion pins betAmount=${pinnedBet}` }
        : { kind: "set_bet_to_min" };
      console.warn(
        `[case-translator/${input.caseId}] BET BEFORE SPIN — AI omitted bet anchor; injecting ${injected.kind}${pinnedBet != null ? `(${pinnedBet})` : ""} before first spin`,
      );
      parsed.actions.splice(
        firstSpinIdx,
        0,
        injected,
        { kind: "wait_ms", ms: 800 },
      );
    }
  }

  return { caseId: input.caseId, actions: parsed.actions, aiCalled: true };
}

/**
 * Translate all cases, caching per case to disk. Cases already in cache are
 * reused (no AI call). Returns the full updated cache.
 */
export async function translateAllCases(
  slug: string,
  cases: Array<{
    id: string;
    name: string;
    category: string;
    setup_instructions?: string;
    spin_count?: number;
    custom_assertions?: Array<{ id?: string; check_code?: string }>;
  }>,
  uiMap: UiRegistry,
  gameSpec?: GameSpec,
): Promise<CaseActionsCache> {
  const existing = (await loadCache(slug)) ?? {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    cases: {},
  };

  let newCount = 0;
  for (const c of cases) {
    if (existing.cases[c.id]) continue;
    const translated = await translateCase({
      caseId: c.id,
      caseName: c.name,
      category: c.category,
      setup: c.setup_instructions ?? "",
      uiMap,
      gameSpec,
      spinCount: c.spin_count,
      customAssertions: c.custom_assertions,
    });
    existing.cases[c.id] = translated;
    newCount++;
  }
  if (newCount > 0) {
    existing.generatedAt = new Date().toISOString();
    await saveCache(slug, existing);
  }
  console.log(`[case-translator] ${newCount} new + ${cases.length - newCount} cached → ${cases.length} total`);
  return existing;
}
