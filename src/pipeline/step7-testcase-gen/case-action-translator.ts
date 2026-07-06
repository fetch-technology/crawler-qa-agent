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
import type { UiRegistry, UiElement } from "../registry/types.js";

export type CaseAction =
  | { kind: "click"; uiKey: string; times?: number; reason?: string }
  | { kind: "hold"; uiKey: string; ms?: number; reason?: string }
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
      /** Exit on quiet even with 0 new spins — for IDLE-CONFIRM waits
       *  ("verify nothing is still spinning"), where zero spins = success. */
      allowZeroSpins?: boolean;
      reason?: string;
    }
  // Actively STOP a running autoplay batch (state-aware, runtime-branching):
  // observe spin activity; while spins keep arriving (and no FS chain is
  // playing out) click autoButton — during a RUNNING autoplay that click is
  // the STOP control. Waiting-out a long batch has proven unreliable
  // (celebration pauses fake "quiet"; 100-spin batches outlive any wait cap);
  // stopping is deterministic. No-op when already idle. Internal use
  // (calibration etc.) — not part of the AI translator vocabulary.
  | { kind: "stop_autoplay_if_running"; maxMs?: number; reason?: string }
  // Force ante toggle OFF before the case proceeds. Idempotent — uses
  // pixel-diff vs offBaseline captured during Discover. Auto-prepended
  // to every case by the translator when the registry has anteButton
  // with offBaseline set. No-op when game has no ante feature. Failing
  // this lambda fails the whole case (default bet semantics broken).
  | { kind: "ensure_ante_off"; reason?: string };

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
- {"kind":"hold","uiKey":"<key>","ms":<int>,"reason":"<short>"} — press-and-hold a UI element, then release. Use for controls whose label/instructions say HOLD/LONG PRESS, especially spin/autoplay controls like "HOLD FOR AUTOPLAY". Default ms is 5000. uiKey MUST EXIST.
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
- Entries marked [hold] or [hold Nms] require a long-press gesture. Use {"kind":"hold","uiKey":"<key>","ms":N} for those entries instead of click when opening/using that control.
- Entries marked [external-tab] live on a SEPARATE browser tab opened by their PARENT trigger (e.g. \`historyButton\` opens a new tab → \`historyButton__roundsTable\` is in that tab). When the action sequence needs to click an [external-tab] element:
  1. First click the PARENT trigger (the top-level key, NOT marked [external-tab]).
  2. Add a longer wait_ms (≥2000ms) so the new tab has time to load.
  3. Then click the [external-tab] children. The case-executor auto-routes clicks to the captured tab; you don't need any special action.
  4. After interacting, the tab is closed automatically at end of case. If the case is mid-flow and you need to return to the game (e.g. to spin afterwards), DO emit a click on the tab's closeButton (also [external-tab]) so the page focus returns cleanly.
- DO NOT invent uiKeys not in the hierarchy. If a required element is missing, output {"actions":[],"reason":"missing uiKey <name>"}.
- If the UI text or setup says "hold", "long press", "press and hold", or the registered control is a "Hold for Autoplay" style button, emit {"kind":"hold","uiKey":"<key>","ms":5000} instead of click. Add a wait_ms 1500 afterward if a popup/panel needs to render.

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
  // Match `<identifier>.betAmount` — `<identifier>` is whatever the catalog
  // AI named the spin variable: `spin` for top-level top, but commonly `s`
  // / `r` / `c` inside `.every(s => …)` / `.map(s => …)` / `.reduce(...)`
  // lambdas over collector.spins. Earlier the regex hard-coded `spin.`
  // which missed every `.every`/.map`/.reduce` assertion → no pinned bet
  // detected → fallback to set_bet_to_min → assertion failed because the
  // spin landed at MIN (e.g. 0.20) instead of the asserted target (7.00).
  // \b boundary on left so we don't pick up unrelated suffixes like
  // `someotherbetAmount` (unlikely but cheap to guard against).
  for (const a of customAssertions) {
    const code = a.check_code;
    if (!code) continue;
    // Skip free-spin invariant assertions. Free-spin rounds have bet=0
    // (server doesn't debit the wallet on FS), so the catalog often writes
    // `.filter(s => s.isFreeSpin).every(s => s.betAmount === 0)` to verify
    // that invariant. That's a CHECK on FS rounds, NOT a setup hint for
    // the player-controllable bet. Without this guard, the regex below
    // greedily matched `betAmount === 0` and translator injected
    // `set_bet_to_value{value:0}` (no game has 0 as a settable bet),
    // breaking every FS-watcher case. Detect via FS-filter keyword anywhere
    // in the assertion code.
    if (/isFreeSpin|free[\s_]?spin/i.test(code)) continue;
    // Pattern 1: <id>.betAmount === 7.00 / <id>.betAmount == 7
    const eqMatch = code.match(/\b[A-Za-z_$][\w$]*\.betAmount\s*===?\s*(\d+(?:\.\d+)?)/);
    if (eqMatch) {
      const v = Number(eqMatch[1]);
      // Defensive: any assertion that pinned bet=0 outside of FS context
      // is still invalid. Slot bet ladders never include 0 — minimum is
      // betMin (typically 0.20). Treat 0 as "no useful pin" and let the
      // translator fall back to set_bet_to_min.
      if (v > 0) return v;
      continue;
    }
    // Pattern 2: Math.abs(<id>.betAmount - 7.00) <= 0.01
    const absMatch = code.match(/Math\.abs\(\s*\b[A-Za-z_$][\w$]*\.betAmount\s*-\s*(\d+(?:\.\d+)?)/);
    if (absMatch) {
      const v = Number(absMatch[1]);
      if (v > 0) return v;
      continue;
    }
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
  const assertions = args.customAssertions ?? [];
  // 0. Spin-observation categories ALWAYS need spins to exercise the feature —
  //    never FORBID them. A free-spin / respin WATCH case must spin even when
  //    the catalog mis-set spin_count=0, or when an assertion uses a
  //    `collector.spins.length === 0 || <check>` skip-guard. (buy_feature is
  //    intentionally NOT here: its buy-click triggers the feature, so a
  //    spin_count=0 buy case correctly emits no manual spins.)
  if (args.category && /^(free_spins|respin)$/.test(args.category)) {
    return { policy: "REQUIRED", reason: `category=${args.category} (must spin to observe the feature)` };
  }
  // 1. Explicit negative-spin assertion → FORBIDDEN. Only when the zero-check is
  //    the assertion's OPERATIVE condition — NOT when it's part of an `|| …`
  //    skip-guard. `collector.spins.length === 0 || <real check>` passes
  //    vacuously on empty runs (a guard), and matching it here wrongly forbade
  //    legitimate multi-spin watch cases (their actions came out empty).
  const negativeSpinPattern = /collector\.spins\.length\s*===?\s*0\b/;
  if (assertions.some((a) => a.check_code && negativeSpinPattern.test(a.check_code) && !a.check_code.includes("||"))) {
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
      ...maybeAntePreamble(input.uiMap),
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
    // Run the SAME native-autoplay conversion as the AI path below. Without
    // this, empty-setup FS-watch cases (e.g. free-spins-trigger-watch, 60
    // spins, no AI) stayed as 60 discrete clicks and never became autoplay-1000
    // — the short-circuit returned before the post-process safety net.
    const finalActions = ensureAutoplayHygiene(maybeConvertToAutoplay(actions, {
      category: input.category,
      spinCount: input.spinCount,
      uiMap: input.uiMap,
    }), input.uiMap);
    return { caseId: input.caseId, actions: finalActions, aiCalled: false };
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
    if ((a.kind === "click" || a.kind === "hold") && !input.uiMap[a.uiKey]) {
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
    return { caseId: input.caseId, actions: normalizeNestedUiActions(filtered, input.uiMap), aiCalled: true };
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

  // Auto-prepend ensure_ante_off when game has ante. Idempotent — when
  // registry lacks anteButton this is a no-op step at runtime. Inserted
  // AFTER the spin-policy/bet-anchor safety nets so the bet anchor still
  // runs second (semantic order: ante off → bet level → spin). Skip if
  // case already has one (e.g. AI emitted it explicitly).
  const preamble = maybeAntePreamble(input.uiMap);
  if (preamble.length > 0 && !parsed.actions.some((a) => a.kind === "ensure_ante_off")) {
    parsed.actions.unshift(...preamble);
  }

  // POST-PROCESS SAFETY NET: convert a long uniform discrete-spin run into the
  // game's NATIVE AUTOPLAY (deterministic — so re-translate reliably produces
  // autoplay, no manual edit). Faster + far more robust than N manual clicks,
  // and the only practical way to reach the spin counts that organically
  // trigger free spins. Runs LAST so the ante/bet prelude is preserved.
  const normalizedActions = normalizeNestedUiActions(parsed.actions, input.uiMap);
  const finalActions = ensureAutoplayHygiene(maybeConvertToAutoplay(normalizedActions, {
    category: input.category,
    spinCount: input.spinCount,
    uiMap: input.uiMap,
  }), input.uiMap);
  return { caseId: input.caseId, actions: finalActions, aiCalled: true };
}

/** Minimum discrete-spin run length that triggers native-autoplay conversion
 *  (free-spin/respin watch cases convert at any count — they need autoplay to
 *  reach a trigger). */
const AUTOPLAY_MIN_SPINS = 20;

/** Convert a uniform discrete-spin run → native autoplay when the registry
 *  exposes the autoplay UI. Deterministic; exported for tests. */
export function maybeConvertToAutoplay(
  actions: CaseAction[],
  input: { category?: string; spinCount?: number; uiMap: UiRegistry },
): CaseAction[] {
  const reg = input.uiMap as Record<string, UiElement | undefined>;
  if (!reg.autoButton || !reg["autoButton__startAutoplayButton"]) return actions;
  const presets = Object.keys(reg)
    .map((k) => /^autoButton__autoCountSlide-(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (presets.length === 0) return actions;

  const firstSpin = actions.findIndex((a) => a.kind === "spin");
  if (firstSpin < 0) return actions; // AI already used autoplay (no discrete spins) — leave it
  let lastSpin = firstSpin;
  for (let i = firstSpin; i < actions.length; i++) {
    if (actions[i]!.kind === "spin") lastSpin = i;
  }
  const runSlice = actions.slice(firstSpin, lastSpin + 1);
  const numSpins = runSlice.filter((a) => a.kind === "spin").length;
  // Only convert a UNIFORM run (spin + wait_ms only) — a run with bet changes /
  // clicks interspersed needs discrete per-spin control, leave it alone.
  if (!runSlice.every((a) => a.kind === "spin" || a.kind === "wait_ms")) return actions;

  const isFsWatch = /^(free_spins|respin)$/.test(input.category ?? "");
  const target = Math.max(numSpins, input.spinCount ?? 0);
  if (!isFsWatch && target < AUTOPLAY_MIN_SPINS) return actions; // keep short runs discrete

  // Count tile: FS watch → highest preset (maximise trigger chance); else the
  // smallest preset that covers the target (fallback highest).
  const tile = isFsWatch
    ? presets[presets.length - 1]!
    : (presets.find((n) => n >= target) ?? presets[presets.length - 1]!);
  // ~6s/spin budget + 10s quiet — same rationale as buildAutoplayBatch: a
  // tight cap/quiet ends the case MID-BATCH, and evaluation then races the
  // still-running autoplay (observed: end-of-case OCR read the balance one
  // whole bet BELOW the last captured spin — the next round had already
  // deducted). ensureAutoplayHygiene() appends the stop tail as the backstop.
  const maxMs = Math.min(900_000, tile * 6000 + 120_000);

  const autoplaySeq: CaseAction[] = [
    { kind: "click", uiKey: "autoButton", reason: "open autoplay panel (auto-converted from discrete spins)" },
    { kind: "wait_ms", ms: 1500 },
    { kind: "click", uiKey: `autoButton__autoCountSlide-${tile}`, reason: `select ${tile}-spin autoplay batch` },
    { kind: "wait_ms", ms: 500 },
    { kind: "click", uiKey: "autoButton__startAutoplayButton", reason: "start autoplay batch" },
    { kind: "wait_until_no_spin_response", quietMs: 10_000, maxMs, reason: `wait autoplay batch of ${tile} (FS-aware) to finish` },
  ];
  const before = actions.slice(0, firstSpin);
  // Drop any trailing wait_ms after the spin run (belonged to discrete spins).
  const after = actions.slice(lastSpin + 1).filter((a) => a.kind !== "wait_ms");
  console.warn(`[case-translator/autoplay] converted ${numSpins} discrete spin(s) → native autoplay tile=${tile} (category=${input.category ?? "?"}, fsWatch=${isFsWatch})`);
  return [...before, ...autoplaySeq, ...after];
}

/** Autoplay hygiene post-pass: any action plan that STARTS an autoplay batch
 *  must also guarantee the batch is fully stopped before later steps and the
 *  end-of-case evaluation. Without it, a quiet-gap/timeout exit from the wait
 *  leaves autoplay RUNNING → assertions and OCR race a moving game (observed:
 *  final balance OCR exactly one bet below the last captured spin), and the
 *  leftover batch keeps burning balance after the case returns. Appends
 *  (right after the batch wait):
 *    1. wait_until_state MAIN — actively dismisses an end-of-feature
 *       celebration (a PAUSED autoplay emits no spins, so the stop action
 *       cannot see it until the popup is cleared), then
 *    2. stop_autoplay_if_running — effect-verified stop of whatever remains.
 *  No-op when the plan has no autoplay start, lacks autoButton, or already
 *  contains a stop action. Applied AFTER maybeConvertToAutoplay, so it covers
 *  both converted plans and autoplay flows the AI authored directly. */
export function ensureAutoplayHygiene(actions: CaseAction[], uiMap: UiRegistry): CaseAction[] {
  const reg = uiMap as Record<string, UiElement | undefined>;
  if (!reg.autoButton) return actions;
  const startIdx = actions.findIndex(
    (a) => a.kind === "click" && (a as { uiKey?: string }).uiKey === "autoButton__startAutoplayButton",
  );
  if (startIdx < 0) return actions;
  if (actions.some((a) => a.kind === "stop_autoplay_if_running")) return actions;
  let insertAt = startIdx + 1;
  for (let i = startIdx + 1; i < actions.length; i++) {
    if (actions[i]!.kind === "wait_until_no_spin_response") { insertAt = i + 1; break; }
  }
  const tail: CaseAction[] = [
    { kind: "wait_until_state", state: "MAIN", maxMs: 30_000, reason: "dismiss end-of-feature celebration (a paused autoplay emits no spins)" },
    { kind: "stop_autoplay_if_running", reason: "ensure no leftover autoplay before evaluation / later steps" },
  ];
  return [...actions.slice(0, insertAt), ...tail, ...actions.slice(insertAt)];
}

function uiActionKey(a: CaseAction): string | null {
  return (a.kind === "click" || a.kind === "hold") ? a.uiKey : null;
}

function isCloseLikeUiKey(uiKey: string): boolean {
  const last = uiKey.split("__").pop() ?? uiKey;
  return /close|cancel|back|exit|dismiss/i.test(last);
}

function isPassiveContainerAncestor(uiKey: string): boolean {
  const last = uiKey.split("__").pop() ?? uiKey;
  return /dropdown|panel|popup|modal|selector|list/i.test(last);
}

function actionForRegistryElement(uiKey: string, uiMap: UiRegistry, reason: string): CaseAction {
  const el = uiMap[uiKey];
  if (el?.preferredGesture === "hold") {
    return { kind: "hold", uiKey, ms: el.preferredHoldMs ?? 5000, reason };
  }
  return { kind: "click", uiKey, reason };
}

function dropdownOpenerForOption(uiKey: string, uiMap: UiRegistry): string | null {
  const parts = uiKey.split("__");
  const leaf = parts.at(-1);
  if (!leaf || parts.length < 2) return null;
  const m = /^(.+?)-(?:until-)?\d+(?:\.\d+)?(?:-.+)?$/i.exec(leaf);
  if (!m) return null;
  const parent = parts.slice(0, -1).join("__");
  const base = m[1]!;
  const candidates = [
    `${parent}__${base}Dropdown`,
    `${parent}__${base}Selector`,
    `${parent}__${base}List`,
  ];
  return candidates.find((k) => Boolean(uiMap[k])) ?? null;
}

/** Post-process AI-authored UI actions so nested keys are physically reachable.
 *  The prompt tells AI to click every ancestor for `a__b__c`, but models still
 *  sometimes jump straight to the leaf. This inserts any missing ancestor
 *  action, and honors registry `[hold]` metadata for both inserted ancestors
 *  and AI-authored clicks. */
export function normalizeNestedUiActions(actions: CaseAction[], uiMap: UiRegistry): CaseAction[] {
  const out: CaseAction[] = [];
  const active = new Set<string>();
  let skipNextWaitMs = false;

  const markActive = (uiKey: string) => {
    const parts = uiKey.split("__");
    for (let i = 1; i <= parts.length; i++) active.add(parts.slice(0, i).join("__"));
  };

  const nextUiKeyAfter = (idx: number): string | null => {
    for (let j = idx + 1; j < actions.length; j++) {
      const next = actions[j]!;
      if (next.kind === "wait_ms") continue;
      return uiActionKey(next);
    }
    return null;
  };

  for (let idx = 0; idx < actions.length; idx++) {
    const raw = actions[idx]!;
    if (skipNextWaitMs && raw.kind === "wait_ms") {
      skipNextWaitMs = false;
      continue;
    }
    skipNextWaitMs = false;
    const rawUiKey = uiActionKey(raw);
    if (!rawUiKey) {
      out.push(raw);
      if (raw.kind === "dismiss" || raw.kind === "reset") active.clear();
      continue;
    }

    if (raw.kind === "click" && isPassiveContainerAncestor(rawUiKey)) {
      const nextUiKey = nextUiKeyAfter(idx);
      if (nextUiKey?.startsWith(`${rawUiKey}__`)) {
        markActive(rawUiKey);
        skipNextWaitMs = true;
        continue;
      }
    }

    const parts = rawUiKey.split("__");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("__");
      if (active.has(ancestor)) continue;
      if (!uiMap[ancestor]) continue;
      if (isPassiveContainerAncestor(ancestor)) {
        markActive(ancestor);
        continue;
      }
      out.push(actionForRegistryElement(ancestor, uiMap, `open ancestor ${ancestor} for ${rawUiKey}`));
      out.push({ kind: "wait_ms", ms: 1500 });
      markActive(ancestor);
    }

    const optionOpener = raw.kind === "click" ? dropdownOpenerForOption(rawUiKey, uiMap) : null;
    if (optionOpener && !active.has(optionOpener) && rawUiKey !== optionOpener) {
      out.push(actionForRegistryElement(optionOpener, uiMap, `open dropdown ${optionOpener} for ${rawUiKey}`));
      out.push({ kind: "wait_ms", ms: 500 });
      markActive(optionOpener);
    }

    const action = raw.kind === "click" && uiMap[raw.uiKey]?.preferredGesture === "hold"
      ? { kind: "hold" as const, uiKey: raw.uiKey, ms: uiMap[raw.uiKey]?.preferredHoldMs ?? 5000, reason: raw.reason ?? "registry marks this control as hold" }
      : raw;
    out.push(action);
    markActive(rawUiKey);
    if (isCloseLikeUiKey(rawUiKey)) active.clear();
  }

  return out;
}

/** Build a native autoplay batch action sequence for ~targetSpins rounds.
 *  Returns null when the registry lacks the autoplay UI (caller falls back to
 *  discrete spins). Picks the smallest preset tile >= targetSpins (fallback
 *  to the highest preset). Exported + reused by payout calibration so a
 *  100-spin calibration batch runs as one native autoplay instead of 100
 *  per-click discrete spins (much faster wall-clock, same captured combos). */
export function buildAutoplayBatch(
  uiMap: UiRegistry,
  opts: { targetSpins: number; reason?: string },
): { actions: CaseAction[]; tile: number } | null {
  const reg = uiMap as Record<string, UiElement | undefined>;
  if (!reg.autoButton || !reg["autoButton__startAutoplayButton"]) return null;
  const presets = Object.keys(reg)
    .map((k) => /^autoButton__autoCountSlide-(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (presets.length === 0) return null;
  const tile = presets.find((n) => n >= opts.targetSpins) ?? presets[presets.length - 1]!;
  // Budget ~6s/spin (not 3s): real batches run slower — ante ON, cascade
  // animations, win-celebration gaps. A too-tight cap times out MID-batch,
  // which leaves autoplay STILL RUNNING; the next phase's autoButton click then
  // TOGGLES it off instead of opening the panel → that phase never spins. Fast
  // games still exit early via the 5s quiet gap, so a generous cap is free.
  const maxMs = Math.min(900_000, tile * 6000 + 120_000);
  const actions: CaseAction[] = [
    { kind: "click", uiKey: "autoButton", reason: opts.reason ?? "open autoplay panel" },
    { kind: "wait_ms", ms: 1500 },
    { kind: "click", uiKey: `autoButton__autoCountSlide-${tile}`, reason: `select ${tile}-spin autoplay batch` },
    { kind: "wait_ms", ms: 500 },
    { kind: "click", uiKey: "autoButton__startAutoplayButton", reason: "start autoplay batch" },
    // quiet=10s, not 5s: autoplay inter-spin gaps during win celebrations /
    // long tumbles regularly exceed 5s (observed 8–13s), which made the wait
    // declare "batch finished" while autoplay was merely between spins — the
    // next phase then clicked autoButton ON A RUNNING autoplay (= stop toggle).
    { kind: "wait_until_no_spin_response", quietMs: 10_000, maxMs, reason: `wait autoplay batch of ${tile} to finish` },
  ];
  return { actions, tile };
}

/** Returns `[{kind:"ensure_ante_off"}]` when the registry has an
 *  anteButton; otherwise empty. Inserted as the first action of every
 *  translated case so bet-level assertions hold (ante ON inflates the
 *  bet by ~25%). Cheap no-op at runtime when the game doesn't have
 *  ante — the case-executor early-returns on missing anteButton. */
function maybeAntePreamble(uiMap: UiRegistry): CaseAction[] {
  if (!uiMap || !uiMap.anteButton) return [];
  return [{ kind: "ensure_ante_off", reason: "force ante OFF — bet assertions assume base wager" }];
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
