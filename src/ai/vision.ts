import { readFileSync } from "node:fs";
import { askClaude, extractJsonFromText } from "./claude.js";

export type AIDecision = {
  action: "click" | "wait" | "spin_done" | "error";
  x: number;
  y: number;
  reason: string;
  confidence: number;
  observed_balance: string | null;
  observed_win: string | null;
  spin_state: "idle" | "spinning" | "result_visible" | "modal_blocking" | "unknown";
};

const VISION_SYSTEM_PROMPT =
  "You are a vision-driven QA automation agent. You analyze screenshots of a browser-based slot-machine game (Cocos Creator canvas) and output a single JSON object describing the next action. Never output anything other than the JSON.";

async function askClaudeVision(promptText: string, imageBase64: string): Promise<string> {
  return askClaude({
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
      { type: "text", text: promptText },
    ],
    system: VISION_SYSTEM_PROMPT,
  });
}

function extractJson<T>(raw: string): T | null {
  return extractJsonFromText<T>(raw);
}

export type ConfigAction = {
  action: "click" | "type" | "wait" | "done" | "error";
  x: number;
  y: number;
  text_to_type: string | null;      // chỉ khi action="type"
  reason: string;
  confidence: number;
  goal_achieved: boolean;
  current_state: string;            // mô tả AI đang thấy gì
  visible_controls: string[];
  // Stepper batch click: nếu cần lặp click N lần (vd bet $2 → $100, step $2 → 49 clicks).
  // Default 1. Cap ở runner để tránh runaway.
  repeat?: number;
  // Numeric value AI đọc được hiện tại (cho stepper) — dùng để tính step delta giữa 2 iter.
  observed_numeric_value?: number | null;
  // Target numeric AI suy ra từ goal (USD, rounds, …). Null nếu goal không có số cụ thể.
  target_numeric_value?: number | null;
};

/**
 * AI-driven game configuration. Mỗi iteration: AI so sánh trạng thái hiện tại
 * (từ screenshot) với target goal (natural language), quyết định next action.
 *
 * Hỗ trợ stepper: nếu AI thấy cần click +/- nhiều lần (vd bet $2→$100), trả
 * `repeat` = số lần click ước lượng. Setup driver sẽ click batch không hỏi AI lại
 * giữa chừng → tiết kiệm iteration.
 */
export async function decideConfigAction(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  goal: string;
  iteration: number;
  lastAction?: { action: string; reason: string } | null;
  observedHistory?: Array<{ value: number | null; clicks_since_last: number }>; // for step calibration
}): Promise<ConfigAction> {
  const { screenshotPath, viewport, goal, iteration, lastAction, observedHistory } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const historyHint =
    observedHistory && observedHistory.length > 0
      ? `\nObserved value history (most recent): ${JSON.stringify(observedHistory.slice(-5))}\nUse this to estimate step size if you need to batch-click.`
      : "";

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Iteration ${iteration}.
${lastAction ? `Last action: ${lastAction.action} — ${lastAction.reason}` : "First iteration."}${historyHint}

GOAL: ${goal}

You are configuring a slot game's UI to reach a target state. The play screen is already loaded. DO NOT click the main Spin button (used for manual single spin) unless the goal explicitly says "spin". HOWEVER, if the goal explicitly says to START AUTOPLAY (e.g. "Press Start", "begin autoplay session", "start the autoplay"), you MAY click the Start button inside the autoplay panel — that is a configuration action (it kicks off the configured rounds), not a manual spin.

Return ONLY JSON:
{
  "action": "click" | "type" | "wait" | "done" | "error",
  "x": number, "y": number,           // viewport px (0 if no click/type)
  "text_to_type": string | null,       // when action="type"
  "reason": string,                    // 1 sentence why this action
  "confidence": number,                // 0..1
  "goal_achieved": boolean,            // TRUE only when the UI clearly shows the target state
  "current_state": string,             // short description of what you see now (e.g. "BET $0.20 displayed, selector closed")
  "visible_controls": string[],        // visible interactive elements: ["bet_plus_button","bet_minus_button","bet_selector","autoplay_button"...]
  "repeat": number,                    // for stepper +/- clicks: batch count. 1 if single click. Up to 200.
  "observed_numeric_value": number | null,  // current numeric the goal targets (e.g. current BET as 2.00 if goal mentions bet)
  "target_numeric_value": number | null     // target numeric extracted from goal (e.g. 100 for "set bet to 100.00 USD")
}

Decision logic:
1. If current UI state matches GOAL exactly → goal_achieved=true, action="done".
2. **GOAL_ACHIEVED with tolerance**: if goal has a numeric target and current value is within ±10% OR within 1 step of target (whichever larger), set goal_achieved=true. Many games have a fixed bet ladder (0.20, 0.40, 0.60, 1.00, 2.00…) — the EXACT target may be UNREACHABLE. Accept the closest valid value rather than spinning forever.
3. If goal has a NUMERIC TARGET reachable via a +/- stepper button (bet, rounds, coin value):
   a. **Iter 0 (no history yet)**: action="click" on the stepper, repeat=1. This is a CALIBRATION click — never set repeat>1 here.
   b. **Iter 1 (have 1 observation)**: compute step = |new − old|. Set repeat = MIN(10, ceil(|target − current| / step)). Cap at 10 ON THIS ITER even if more clicks are mathematically needed — many games have NON-LINEAR steppers (step grows at higher bet levels). Better to take small batches and re-observe.
   c. **Iter 2+ (multiple observations)**: if step has been stable across 2+ observations, you may use repeat up to 100. If step changed (non-linear), keep repeat ≤ 20.
   d. **DIRECTION CORRECTION**: if you OVERSHOT the target (current > target when goal said increase, or current < target when goal said decrease), DO NOT set action="error". REVERSE direction — click the OPPOSITE stepper (- if you were +, + if you were -). The setup goal's wording ("using + button") is a HINT, not a hard constraint. Reaching the target value is what matters; using the other button to fine-tune is correct behavior.
   e. After repeat clicks, you'll see the result next iter — fine-tune.
4. If you need to click a button/selector (non-stepper) → action="click", repeat=1.
5. If you need to type a number → action="type".
6. If UI is mid-animation/loading → action="wait", repeat=0.
7. If goal target is FUNDAMENTALLY UNREACHABLE (feature not present, off the bet ladder by a lot, …) — first try the closest reachable value (rule 2). Only set action="error" if you've explored both directions and confirmed no valid value within tolerance exists.

═══ MULTI-STEP POPUP FLOWS ═══

If goal mentions BUY FEATURE / PURCHASE:
  Buy feature in slot games is typically a 2-3 step flow inside a popup:
    Step 1. Click the option/tier card (highlights it; SHOULD NOT auto-buy)
    Step 2. Click the prominent "BUY" / "BUY ANYWAY" / "PURCHASE" / "CONFIRM" button
            (usually below the option cards or at the bottom of the popup)
    Step 3. (sometimes) A "Are you sure?" dialog → click YES / OK / CONFIRM
  goal_achieved=true ONLY after the final commit click. If you see the option
  highlighted but the popup still showing → step 1 done, step 2/3 NOT done →
  KEEP clicking. Never set goal_achieved=true while the buy popup is still
  visible. The buy is committed when the popup CLOSES and reels visibly start.

If goal mentions AUTOPLAY START:
  Step 1. Open Autoplay menu (button near spin)
  Step 2. Configure rounds (click number chip/preset)
  Step 3. (optional) Configure stop conditions
  Step 4. Click START button at bottom of menu
  goal_achieved=true ONLY after Start clicked AND reels start spinning.

If goal mentions SPECIAL BETS / ANTE:
  Step 1. Open Special Bets panel (button on side)
  Step 2. Click the desired option to select
  Step 3. (sometimes) Click Apply/OK to confirm and close panel
  goal_achieved=true when panel closed AND ante indicator shows new state.

═══ EXAMPLES ═══

Examples:
- Goal "Set bet to $100" first iter, no history: action="click" on bet_plus, repeat=1. observed_numeric_value=2, target_numeric_value=100.
- Goal "Set bet to $100" iter 1, history shows 2.00 → 2.20 (step 0.20): repeat=MIN(10, 489)=10. Click + 10 times. Re-observe.
- Goal "Set bet to $100" iter 2, history shows step is now 1.00 at higher bet: re-estimate, repeat=MIN(20, ...) etc.
- Goal "Set bet to $100" but you OVERSHOT to $240: REVERSE — action="click" on bet_minus, repeat appropriate. NOT action="error".
- Goal "Decrease bet to 0.50" but ladder is 0.20/0.40/0.60: at 0.40, step=0.20, target 0.50 → 0.40 is within 1 step → goal_achieved=true (closest reachable).
- Goal "Open Buy Feature popup": action="click" on Buy Feature button, repeat=1.

NEVER click the main Spin button unless explicitly part of the goal.
For stepper goals: prefer SMALL batch + re-observe over giant batch. Non-linear stepper is common.
NEVER set repeat > 100 unless step is verified stable across ≥2 observations.
Stop when goal is VISUALLY CONFIRMED achieved (or within tolerance for numeric goals).`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<ConfigAction>(raw);
  if (!parsed) {
    return {
      action: "error",
      x: 0,
      y: 0,
      text_to_type: null,
      reason: `JSON parse failed. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      goal_achieved: false,
      current_state: "",
      visible_controls: [],
    };
  }
  return parsed;
}

export type PreGameDismissal = {
  action: "click" | "wait" | "done";
  x: number;
  y: number;
  reason: string;
  confidence: number;
  blocker_type:
    | "age_gate"
    | "terms_accept"
    | "cookies"
    | "welcome"
    | "tutorial"
    | "language_picker"
    | "currency_picker"
    | "sound_prompt"
    | "promo_popup"
    | "error_popup"
    | "loading"
    | "launcher"
    | "other"
    | "none";
  blocker_text: string | null;
  play_screen_ready: boolean;
  visible_elements: string[];
};

/**
 * Phát hiện và dismiss blocker cho tới khi game ở đúng play screen.
 * Trả về decision + flag `play_screen_ready` để caller quyết định có break loop.
 * KHÔNG click Spin button — chỉ clear đường cho tới khi play screen visible.
 */
export async function decidePreGameDismissal(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  iteration: number;
  dismissedSoFar?: number;
}): Promise<PreGameDismissal> {
  const { screenshotPath, viewport, iteration, dismissedSoFar = 0 } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Iteration ${iteration}. Blockers dismissed so far: ${dismissedSoFar}.

You are helping automate a slot game QA test. Before gameplay can start, you must clear EVERY blocker (age gate, terms, welcome popups, tutorials, sound prompt, loading screens, etc.) until the PLAY SCREEN is fully ready. You do NOT play the game — just clear blockers.

Return ONLY JSON:
{
  "action": "click" | "wait" | "done",
  "x": number, "y": number,           // viewport px (0 if no click)
  "reason": string,
  "confidence": number,               // 0..1
  "blocker_type": "age_gate" | "terms_accept" | "cookies" | "welcome" | "tutorial" | "language_picker" | "currency_picker" | "sound_prompt" | "promo_popup" | "error_popup" | "loading" | "launcher" | "other" | "none",
  "blocker_text": string | null,      // short title/label text of the blocker, max 80 chars
  "play_screen_ready": boolean,       // TRUE ONLY when ALL "done" criteria below are met
  "visible_elements": string[]        // list of what you see, e.g. ["reels","spin_button","balance","bet_amount","modal:age_gate","loading_spinner"]
}

═══ ACTION = "done" ONLY WHEN ALL OF THESE ARE TRUE ═══
Set play_screen_ready=true and action="done" ONLY if you observe:
  ✓ Slot machine reels with symbols (fruits, candies, cards, whatever the game uses)
  ✓ A SPIN button (usually circular arrow or "SPIN" text, typically bottom-right/center)
  ✓ A balance/credit value shown (e.g. "$1,000.00", "CREDIT 100,000", "BALANCE: 500")
  ✓ A bet amount shown (e.g. "BET $2.00", "TOTAL BET 0.20")
  ✓ NO overlay modal/popup covering the reels
  ✓ NO loading spinner / progress bar
  ✓ Game FILLS most of the viewport (NOT a small preview embedded in a marketing page)
  ✓ NO browser-like top navbar ("Home / Products / News / Contact", provider logo + menu links) visible above the game

If ANY of these is missing → action="click" or action="wait" (NEVER "done").

═══ CRITICAL: DEMO LANDING PAGE (Pragmatic Play, Evolution, etc.) ═══
If you see a marketing/landing page with:
  - Provider logo (PRAGMATIC PLAY, etc.) + top navigation menu (Home, Products, Client Hub, Company, News, Contact)
  - A SMALL game preview embed (reels visible but taking <60% of viewport)
  - A "Full screen game" / "Full Screen" / "Play" / "Launch" button visible (often bottom-right of the embed, or a prominent CTA)
  - Text like "Back to Games" / game description paragraphs / "Full screen game" link
→ This is NOT the play screen. play_screen_ready=false.
→ CLICK the "Full screen game" / "Play" button to expand into the actual playable game.
→ blocker_type="launcher".

Do NOT mark play_screen_ready=true even if reels/balance are technically visible on a landing page — the actual game interaction surface is the fullscreen view, not the preview.

═══ BLOCKER DISMISSAL RULES ═══

1. AGE GATE — "Are you 18+?", "Pragmatic Play content is intended for persons 18 years or older", "Confirm legal age"
   → CLICK the AFFIRMATIVE button: "Yes", "Yes, I am 18+", "I am 18+", "Confirm"
   → blocker_type="age_gate"

2. TERMS / LEGAL — "I have read and agree to the terms"
   → CLICK "Accept" / "Agree" / "I agree". blocker_type="terms_accept"

3. COOKIE BANNER
   → CLICK "Accept" / "Accept all" / "OK" / "Got it". blocker_type="cookies"

4. WELCOME / INTRO POPUP — non-tutorial splash
   → CLICK close X or "Play" / "Start" / "Continue". blocker_type="welcome"

5. TUTORIAL / HOW-TO-PLAY overlay
   → CLICK "Skip" / "Close" / "X". blocker_type="tutorial"

6. LANGUAGE / CURRENCY picker
   → If "Continue" with default selected → click it
   → Otherwise pick EN / USD → click Continue
   → blocker_type="language_picker" or "currency_picker"

7. SOUND / MUSIC prompt — "Enable sound?"
   → CLICK "Enable" or close X. blocker_type="sound_prompt"

8. PROMO / BONUS offer — "Welcome bonus available!", "Special offer!"
   → CLICK close X or "No thanks" (promo is not a navigation blocker). blocker_type="promo_popup"

9. ERROR POPUP — "Connection error", "Session expired"
   → CLICK close X or "Retry". blocker_type="error_popup". If recurring, action="done" with confidence<0.5 (caller will abort).

10. LOADING SPINNER / PROGRESS BAR — "Loading...", bar filling
    → action="wait", blocker_type="loading"

11. LAUNCHER / INTERMEDIATE SCREEN — "Click to play", big centered Play button on otherwise empty screen, "Enter game" button
    → CLICK the Play / Enter button. blocker_type="launcher"

═══ GOLDEN RULES ═══
A. When choosing between AFFIRMATIVE ("Yes"/"Accept"/"Continue"/"OK"/"I am 18+") and NEGATIVE ("No"/"Cancel"/"Back"/"Decline"/"Exit"):
   → ALWAYS pick AFFIRMATIVE. Negative buttons navigate AWAY from the game and break the test.
B. If you can see PARTIAL game UI (reels loading, some symbols appearing) but not fully ready → action="wait", play_screen_ready=false.
C. If screen is completely blank/black → action="wait", blocker_type="loading".
D. NEVER click the Spin button, Autoplay button, or bet selectors — your job ends when play screen is ready.

Output ONLY the JSON object.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<PreGameDismissal>(raw);
  if (!parsed) {
    return {
      action: "wait",
      x: 0,
      y: 0,
      reason: `JSON parse failed. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      blocker_type: "other",
      blocker_text: null,
      play_screen_ready: false,
      visible_elements: [],
    };
  }
  // Defensive: nếu AI thiếu field bất kỳ (vd response truncated, rate limit,
  // partial JSON), default an toàn để caller không crash khi access .confidence
  // .action .blocker_type v.v.
  if (typeof parsed.action !== "string") parsed.action = "wait";
  if (typeof parsed.x !== "number") parsed.x = 0;
  if (typeof parsed.y !== "number") parsed.y = 0;
  if (typeof parsed.reason !== "string") parsed.reason = "(no reason)";
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) parsed.confidence = 0;
  if (typeof parsed.blocker_type !== "string") parsed.blocker_type = "other";
  if (parsed.blocker_text === undefined) parsed.blocker_text = null;
  if (parsed.play_screen_ready === undefined) parsed.play_screen_ready = false;
  if (!Array.isArray(parsed.visible_elements)) parsed.visible_elements = [];
  return parsed;
}

export type RulesFlowDecision = {
  action: "click" | "scroll" | "wait" | "done" | "error";
  x: number;
  y: number;
  scroll_direction: "up" | "down" | null;
  scroll_amount: number | null; // ~400 px mỗi lần nếu null
  reason: string;
  confidence: number;
  phase: "dismissing_modal" | "finding_rules_button" | "opening_rules" | "reading_rules" | "scrolling" | "next_page" | "completed";
  current_page: number | null;
  estimated_total_pages: number | null;
  rules_visible: boolean;
};

export type TranscribedRulesPage = {
  page_number: number;
  title: string | null;
  sections: Array<{ heading: string; body: string }>;
  symbols: Array<{
    code: string | null;
    name: string | null;
    multipliers: Record<string, string> | null;
    note: string | null;
  }>;
  features: string[];
  raw_text: string;
};

export type OptionsFlowDecision = {
  action: "click" | "scroll" | "wait" | "done" | "error";
  x: number;
  y: number;
  scroll_direction: "up" | "down" | null;
  scroll_amount: number | null;
  reason: string;
  confidence: number;
  phase:
    | "dismissing_modal"
    | "finding_settings_button"
    | "opening_settings"
    | "reading_options"
    | "scrolling"
    | "completed";
  options_visible: boolean;
};

export type TranscribedOption = {
  name: string;                       // e.g. "Autospin", "Bet Size", "Sound", "Turbo"
  category: "control" | "audio" | "display" | "game" | "other";
  type: "toggle" | "selector" | "slider" | "button" | "link" | "unknown";
  current_value: string | null;       // e.g. "On", "0.02", "10 rounds"
  possible_values: string[] | null;   // e.g. ["0.01", "0.02", "0.50", "1.00"]
  description: string | null;
  location_hint: string;              // where in the UI (e.g. "bottom-left of settings modal")
};

export async function decideOptionsFlow(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  iteration: number;
  lastAction?: { action: string; reason: string; phase: string } | null;
}): Promise<OptionsFlowDecision> {
  const { screenshotPath, viewport, iteration, lastAction } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Iteration ${iteration}.
${lastAction ? `Last: ${lastAction.action} (phase=${lastAction.phase}) — ${lastAction.reason}` : "First iteration."}

Your job: navigate to the GAME SETTINGS / OPTIONS / CONFIGURATION panel (NOT rules/paytable, NOT history). Typical options include: Autospin config, Bet size, Quick Spin/Turbo, Sound, Music, Language, Graphics quality.

Return ONLY JSON:
{
  "action": "click" | "scroll" | "wait" | "done" | "error",
  "x": number, "y": number,
  "scroll_direction": "up" | "down" | null,
  "scroll_amount": number | null,
  "reason": string,
  "confidence": number,
  "phase": "dismissing_modal" | "finding_settings_button" | "opening_settings" | "reading_options" | "scrolling" | "completed",
  "options_visible": boolean
}

Flow:
1. Dismiss any blocker modal (NOT settings itself) — phase="dismissing_modal".
2. Find the SETTINGS/OPTIONS button — typically a GEAR icon (⚙) or 3-dots, or inside a Menu panel under "Settings"/"Options". Not the Info/Rules button. phase="finding_settings_button".
3. Click it to open — phase="opening_settings".
4. When settings panel is clearly visible with multiple toggles/selectors → options_visible=true, phase="reading_options".
5. If content cut-off → action="scroll", direction="down", (x,y) inside settings panel. phase="scrolling".
6. When all settings content has been shown (scrolled to bottom or no more content) → action="done", phase="completed". DO NOT close the panel.
7. Stuck ≥3 iterations → action="error".

Key: the settings/options panel is DIFFERENT from:
- Rules/Paytable (symbols, multipliers, game mechanics) — skip those
- History (list of past rounds) — skip those
Look specifically for configurable controls: ON/OFF toggles, value selectors (bet size chips), sliders, etc.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<OptionsFlowDecision>(raw);
  if (!parsed) {
    return {
      action: "error",
      x: 0,
      y: 0,
      scroll_direction: null,
      scroll_amount: null,
      reason: `JSON parse failed. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      phase: "completed",
      options_visible: false,
    };
  }
  return parsed;
}

export type PlayScreenSnapshot = {
  game_title: string | null;              // as displayed in game canvas
  provider_guess: string | null;          // visual branding if obvious (PragmaticPlay, etc.)
  balance: { value: string | null; currency: string | null };
  bet: {
    current: string | null;               // e.g. "2.00" or "0.20"
    min: string | null;                   // if a min/max indicator is visible
    max: string | null;
    step_kind: "plus_minus" | "chips" | "selector" | "unknown";
    chips: string[] | null;               // if discrete chips visible ["0.20","0.40","1.00",...]
  };
  controls: Array<{
    name: string;                         // "Spin", "Autoplay", "Turbo", "Menu", "Sound", "Buy Feature", "Special Bets", "Ante Bet", "Double Chance"...
    kind: "button" | "toggle" | "selector" | "link";
    visible: boolean;
    approx_location: string;              // "bottom-right", "left side of reels", ...
    state_hint: string | null;            // "ON"/"OFF" for toggles, current value for selectors
  }>;
  buy_feature: {
    available: boolean;
    options: Array<{
      label: string;                      // e.g. "Free Spins", "Super Free Spins"
      price_multiplier: string | null;    // e.g. "100x", "3x"
      price_absolute: string | null;      // e.g. "$200.00"
    }>;
  };
  special_bets: {
    available: boolean;                   // ante bet, double chance, bet boost
    variants: Array<{ label: string; state: string | null; price: string | null }>;
  };
  rules_summary: {
    paylines_or_ways: string | null;      // "20 lines", "243 ways", "scatter pays"
    feature_mentions: string[];           // text visible like "6+ matching symbols pay", "Tumble feature"
    visible_symbols: string[];            // symbol names/colors if identifiable
    max_win: string | null;               // "wins up to 25,000x" if visible anywhere (banner/header/tooltip)
  };
  raw_observations: string;               // free-form notes for debugging
};

export async function extractPlayScreenSnapshot(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
}): Promise<PlayScreenSnapshot> {
  const imageBase64 = readFileSync(args.screenshotPath).toString("base64");
  const prompt = `Viewport ${args.viewport.width}x${args.viewport.height}. This is a READY play screen of a slot game (reels, spin button, balance all visible).

Extract EVERYTHING testable into a single JSON — do NOT navigate, do NOT open menus. Only report what you can SEE right now.

Return ONLY:
{
  "game_title": string | null,
  "provider_guess": string | null,
  "balance": { "value": string | null, "currency": string | null },
  "bet": {
    "current": string | null,
    "min": string | null,
    "max": string | null,
    "step_kind": "plus_minus" | "chips" | "selector" | "unknown",
    "chips": string[] | null
  },
  "controls": [
    { "name": string, "kind": "button"|"toggle"|"selector"|"link", "visible": boolean, "approx_location": string, "state_hint": string | null }
  ],
  "buy_feature": {
    "available": boolean,
    "options": [ { "label": string, "price_multiplier": string | null, "price_absolute": string | null } ]
  },
  "special_bets": {
    "available": boolean,
    "variants": [ { "label": string, "state": string | null, "price": string | null } ]
  },
  "rules_summary": {
    "paylines_or_ways": string | null,
    "feature_mentions": string[],
    "visible_symbols": string[],
    "max_win": string | null
  },
  "raw_observations": string
}

Guidance:
- BET: look for "BET", "TOTAL BET", "STAKE". If chips/selector visible, list them. If +/- steppers, step_kind="plus_minus".
- BALANCE: look for "CREDIT", "BALANCE", "CASH" — any prominent currency number that is NOT the bet.
- CONTROLS: include every visible interactive element you can name (Spin, Autoplay, Turbo, Menu, Info, Sound, Settings, Buy Feature, Special Bets, Ante Bet).
- BUY_FEATURE: button usually labeled "BUY FEATURE" / "BUY BONUS" / "BUY" with a price like "100x" or "$200". available=true only if visible.
- SPECIAL_BETS: Pragmatic often shows "ANTE BET", "DOUBLE CHANCE", "SPECIAL BETS" — report if any visible.
- RULES_SUMMARY: pull info from banner text, game-intro strip, tooltip labels. E.g. Sweet Bonanza shows "wins up to 25,000x", "6+ matching symbols pay" — include those.
- Do NOT guess values that aren't on screen. Prefer null over hallucinated.
- Output ONLY the JSON object.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<PlayScreenSnapshot>(raw);
  if (!parsed) {
    return {
      game_title: null,
      provider_guess: null,
      balance: { value: null, currency: null },
      bet: { current: null, min: null, max: null, step_kind: "unknown", chips: null },
      controls: [],
      buy_feature: { available: false, options: [] },
      special_bets: { available: false, variants: [] },
      rules_summary: { paylines_or_ways: null, feature_mentions: [], visible_symbols: [], max_win: null },
      raw_observations: `[extract failed] raw: ${raw.slice(0, 300)}`,
    };
  }
  return parsed;
}

export async function transcribeOptionsPanel(args: {
  screenshotPath: string;
}): Promise<TranscribedOption[]> {
  const imageBase64 = readFileSync(args.screenshotPath).toString("base64");

  const prompt = `This screenshot shows a slot game's SETTINGS / OPTIONS panel. Transcribe EVERY option (toggle, selector, slider, button) you can see into structured JSON.

Return ONLY:
{
  "options": [
    {
      "name": string,                     // e.g. "Autospin", "Bet Size", "Quick Spin", "Sound", "Turbo", "Music", "Language"
      "category": "control" | "audio" | "display" | "game" | "other",
      "type": "toggle" | "selector" | "slider" | "button" | "link" | "unknown",
      "current_value": string | null,     // e.g. "On"/"Off", "0.02", "10 rounds", "English"
      "possible_values": string[] | null, // if visible (e.g. bet chips: ["0.01","0.02","0.50","1.00"])
      "description": string | null,       // label/tooltip if visible
      "location_hint": string             // where in the panel, e.g. "top row left", "bottom right"
    }
  ]
}

Rules:
- One entry per distinct option. Don't duplicate.
- type="toggle" for on/off switches. type="selector" for chip groups / dropdowns. type="slider" for volume bars. type="button" for action buttons (e.g. "Reset"). type="link" for links like "Terms & Conditions".
- possible_values: only if ALL values are visible. Otherwise null.
- If it's a bet-size selector with a "+/-" stepper (not discrete chips), possible_values=null and mention in description.
- Category:
  - "control": Autospin, Quick Spin, Turbo, Bet size, Bet level
  - "audio": Sound, Music
  - "display": Graphics quality, Animations, Fullscreen
  - "game": Language, Rules link
  - "other": anything else
- Output ONLY the JSON object.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<{ options: TranscribedOption[] }>(raw);
  return parsed?.options ?? [];
}

export type HistoryFlowDecision = {
  action: "click" | "scroll" | "wait" | "done" | "error";
  x: number;
  y: number;
  scroll_direction: "up" | "down" | null;
  scroll_amount: number | null;
  reason: string;
  confidence: number;
  phase:
    | "dismissing_modal"
    | "finding_history_button"
    | "opening_menu"
    | "opening_history"
    | "history_visible"
    | "scrolling"
    | "completed";
  history_visible: boolean;
  row_count: number;
};

export type TranscribedHistoryRow = {
  round_id: string | null;
  time: string | null;
  bet: number | null;
  win: number | null;
  balance_after: number | null;
  currency: string | null;
  raw_text: string;
  column_headers_detected?: string[];
};

export async function decideHistoryFlow(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  iteration: number;
  lastAction?: { action: string; reason: string; phase: string } | null;
}): Promise<HistoryFlowDecision> {
  const { screenshotPath, viewport, iteration, lastAction } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Iteration ${iteration}.
${lastAction ? `Last action: ${lastAction.action} (phase=${lastAction.phase}) — ${lastAction.reason}` : "First iteration."}

Your job: navigate to the GAME HISTORY / ROUNDS / TRANSACTIONS panel (a list showing the player's recent spins with bet, win, balance, time). Return ONLY JSON:

{
  "action": "click" | "scroll" | "wait" | "done" | "error",
  "x": number, "y": number,
  "scroll_direction": "up" | "down" | null,
  "scroll_amount": number | null,
  "reason": string,
  "confidence": number,
  "phase": "dismissing_modal" | "finding_history_button" | "opening_menu" | "opening_history" | "history_visible" | "scrolling" | "completed",
  "history_visible": boolean,
  "row_count": number
}

Flow:
1. If a modal blocks the game (but NOT a history panel itself), dismiss it — phase="dismissing_modal".
2. If history panel not visible yet:
   - Look for icon: clock, list, "History"/"Rounds"/"Bets"/"Transactions" label. Often top-right, or inside Menu/hamburger.
   - Menu open: click "History"/"Rounds" item — phase="opening_history".
   - No menu: click the history icon — phase="finding_history_button".
3. History visible with rows (bet/win/balance columns) → history_visible=true, phase="history_visible".
4. If rows appear truncated/more scrollable → action="scroll", scroll_direction="down", (x,y)=center of history panel. phase="scrolling".
5. When enough rows are transcribable (>= expected N spins) → action="done" (do NOT close the panel).
6. Stuck ≥3 same-state iterations, or clearly no history UI → action="error".

Do NOT close the history panel. Leave it open for the next transcription step.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<HistoryFlowDecision>(raw);
  if (!parsed) {
    return {
      action: "error",
      x: 0,
      y: 0,
      scroll_direction: null,
      scroll_amount: null,
      reason: `JSON parse failed. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      phase: "completed",
      history_visible: false,
      row_count: 0,
    };
  }
  return parsed;
}

export async function transcribeHistoryRows(args: {
  screenshotPath: string;
}): Promise<TranscribedHistoryRow[]> {
  const imageBase64 = readFileSync(args.screenshotPath).toString("base64");

  const prompt = `This screenshot shows a slot game's HISTORY / ROUNDS / TRANSACTIONS panel listing recent spins.

Transcribe EVERY visible row into structured JSON. Return ONLY:
{
  "rows": [
    {
      "round_id": string | null,       // unique round/spin ID (often a long alphanumeric string like "01KPW...")
      "time": string | null,           // timestamp shown (HH:MM:SS or similar)
      "bet": number | null,            // bet amount — ALWAYS non-negative (what player wagered)
      "win": number | null,            // win amount — ALWAYS non-negative (what player received; 0 if loss)
      "balance_after": number | null,  // balance AFTER this spin, if shown
      "currency": string | null,       // e.g. "USD", "$"
      "raw_text": string,              // ALL text visible in this row, preserving spatial order
      "column_headers_detected": string[]  // column names you identified (e.g. ["Round", "Bet", "Win", "Balance", "Time"])
    }
  ]
}

CRITICAL rules on numeric fields:
- "bet" and "win" MUST be non-negative (>= 0). Slot games never have negative bet or win.
- If a column shows a NEGATIVE number (like "-0.20" or "-100"), it is a "Net Change" / "Delta" / "P&L" column, NOT win. DO NOT put that value into "win".
  - In that case, if you cannot identify a separate positive win column, set "win" to null.
  - Same rule for "bet": never negative.
- If "win" is shown as blank / "-" / "—" / "0" → set to 0 or null, never negative.
- If unsure which column is which, PREFER null over guessing. A null is fine; a wrong number fails the test.

Parsing rules:
- Strip currency symbols and thousands separators: "1,234.56 USD" → 1234.56.
- Preserve decimal precision: "0.20" → 0.2, "0.40" → 0.4.
- If the panel uses a scale (e.g. cents), DO NOT convert — return the raw displayed number.
- Dashes "-" / "—" / empty → null.

Other:
- Preserve visual order (top row first).
- raw_text should be the complete text seen in that row (including labels/timestamps) — this is used for debugging if automated parsing is wrong.
- column_headers_detected: list the column names you see in the table header. Helps verify which column you treated as "win".
- Output ONLY the JSON object.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<{ rows: TranscribedHistoryRow[] }>(raw);
  return parsed?.rows ?? [];
}

/**
 * Output từ transcribePlayScreenValues — số liệu OCR từ play-screen sau spin.
 * Numeric fields được parse đã (strip currency/commas), dùng để so với API response.
 */
export type TranscribedScreenValues = {
  /** Balance hiện tại hiển thị (canonical: dollars, không phải cents) */
  balance: number | null;
  /** Bet amount đang set (cho spin tiếp theo hoặc spin vừa rồi) */
  bet: number | null;
  /** Win amount của spin GẦN NHẤT — nếu game hiển thị "WIN", "Last Win", "Pay" v.v. */
  last_win: number | null;
  /** Total Win cumulative nếu hiển thị (autoplay window, free spins counter) */
  total_win: number | null;
  /** Currency symbol/code visible */
  currency: string | null;
  /** Free spins counter nếu đang trong free spin mode */
  free_spins_remaining: number | null;
  /** Multiplier cho free spin nếu visible */
  multiplier: string | null;
  /** All raw text fragments AI đã thấy — debug aid khi parsing sai */
  raw_observations: string;
};

export async function transcribePlayScreenValues(args: {
  screenshotPath: string;
}): Promise<TranscribedScreenValues> {
  const imageBase64 = readFileSync(args.screenshotPath).toString("base64");

  const prompt = `This screenshot shows a slot game's PLAY SCREEN (reels visible, possibly mid-spin or post-spin).

Transcribe ALL numeric values displayed on the play screen into structured JSON. These will be cross-checked against the API response that drove this state.

Return ONLY:
{
  "balance": number | null,            // Current player balance display ("BALANCE", "CREDIT", "CASH"). Strip currency/commas. e.g. "$1,234.56" → 1234.56
  "bet": number | null,                 // Current total bet display ("BET", "TOTAL BET", "STAKE")
  "last_win": number | null,            // Win amount of the LATEST spin if shown ("WIN", "LAST WIN", "PAY"). 0 if "0.00" or empty.
  "total_win": number | null,           // Cumulative win counter if shown (autoplay total, free-spin total)
  "currency": string | null,            // e.g. "USD", "$", "€"
  "free_spins_remaining": number | null, // Counter if in free-spin mode (e.g. "5/10" → 5, or "FREE SPINS: 8" → 8)
  "multiplier": string | null,          // Win multiplier shown (e.g. "x2", "5x", "TOTAL MULTIPLIER 12x")
  "raw_observations": string            // Free-form notes: any other numeric labels you saw, debugging context
}

CRITICAL parsing rules:
- Strip currency symbols ($, €, ฿) and thousands separators (commas, spaces) before parsing: "$1,234.56" → 1234.56, "1 234,56" → 1234.56
- Preserve decimal precision: "0.20" → 0.2 (NOT 0.20)
- If a value is shown as "—" / "-" / blank → null (NOT 0, unless explicitly "0.00")
- If "0.00" is explicitly displayed → 0 (number)
- If text says "WIN" but no number is visible (between spins) → last_win = null
- DO NOT convert cents↔dollars — return the raw displayed number value
- For balance: pick the MAIN player balance, not bonus balance (if both shown, balance = cash, ignore bonus)
- For bet: total bet (bet × lines), not coin value
- last_win: the win of the SINGLE most recent spin. If a "TOTAL WIN" / running total is also shown for autoplay/free spins → that goes in total_win, not last_win.

Output ONLY the JSON object.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<TranscribedScreenValues>(raw);
  if (!parsed) {
    return {
      balance: null,
      bet: null,
      last_win: null,
      total_win: null,
      currency: null,
      free_spins_remaining: null,
      multiplier: null,
      raw_observations: `[transcription failed] raw: ${raw.slice(0, 300)}`,
    };
  }
  return parsed;
}

export async function decideRulesFlow(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  iteration: number;
  pagesCaptured: number;
  lastAction?: { action: string; reason: string; phase: string } | null;
}): Promise<RulesFlowDecision> {
  const { screenshotPath, viewport, iteration, pagesCaptured, lastAction } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Iteration ${iteration}. Rules pages already captured: ${pagesCaptured}.
${lastAction ? `Last action: ${lastAction.action} (phase=${lastAction.phase}) — ${lastAction.reason}` : "First iteration."}

Your job: automate navigation to the GAME RULES / PAYTABLE screen, then page/scroll through ALL rule content. Return ONLY JSON:
{
  "action": "click" | "scroll" | "wait" | "done" | "error",
  "x": number, "y": number,              // viewport px (0 if no click)
  "scroll_direction": "up" | "down" | null,  // set when action="scroll"
  "scroll_amount": number | null,         // pixels to scroll, default 400 if null
  "reason": string,
  "confidence": number,
  "phase": "dismissing_modal" | "finding_rules_button" | "opening_rules" | "reading_rules" | "scrolling" | "next_page" | "completed",
  "current_page": number | null,
  "estimated_total_pages": number | null,
  "rules_visible": boolean
}

Decision flow:
1. If any blocking modal/splash/popup (NOT the rules itself) → dismiss it. phase="dismissing_modal".
2. If rules NOT visible and no menu open → click Menu/hamburger/i/?/Info button. phase="finding_rules_button".
3. If a menu is open with "Rules"/"Paytable"/"Info"/"Help" → click that item. phase="opening_rules".
4. If rules visible:
   4a. If content is CUT-OFF at bottom (scrollbar visible, or text trails off, or you see only part of the paragraph/paytable) → action="scroll", scroll_direction="down" at (x,y)=CENTER of the rules content area. phase="scrolling".
   4b. If you see a "Next"/">"/arrow/pagination button to jump to another page → action="click" on that arrow. phase="next_page".
   4c. Otherwise phase="reading_rules".
5. When the last rule page has been viewed AND you've scrolled to the bottom (no more content below) → action="done", phase="completed".

Rules for scroll:
- Only scroll INSIDE the rules modal. (x,y) should be inside the modal/overlay, usually around viewport center or middle of the modal area.
- scroll_direction="up" only needed to go back; usually "down".
- scroll_amount: 400 for small modals, 600 for large ones; null = default 400.

Important:
- rules_visible=true ONLY when paytable/rules content (symbols + multipliers, game mechanics text) fills most of the screen.
- current_page: from visible page indicator like "2/5" → 2. If no indicator, estimate from content order.
- If you clicked next/scrolled and the content LOOKS IDENTICAL to last iteration → mark done (we've reached the end).
- Stuck ≥3 iterations → action="error".`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson(raw) as RulesFlowDecision | null;
  if (!parsed) {
    return {
      action: "error",
      x: 0,
      y: 0,
      scroll_direction: null,
      scroll_amount: null,
      reason: `JSON parse failed. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      phase: "completed",
      current_page: null,
      estimated_total_pages: null,
      rules_visible: false,
    };
  }
  return parsed;
}

export async function transcribeRulesPage(args: {
  screenshotPath: string;
  pageNumber: number;
}): Promise<TranscribedRulesPage> {
  const { screenshotPath, pageNumber } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `This screenshot shows page ${pageNumber} of a slot-machine game's rules/paytable. Transcribe ALL visible content into structured JSON:

{
  "page_number": ${pageNumber},
  "title": string | null,
  "sections": [ { "heading": string, "body": string } ],
  "symbols": [
    {
      "code": string | null,           // e.g. "WILD", "SC", "AA"
      "name": string | null,           // display name if shown
      "multipliers": { "3": "x5", "4": "x20", "5": "x100" } | null,  // multipliers by match count
      "note": string | null            // special behavior text
    }
  ],
  "features": [ "Free Spins triggered by 3+ scatters", ... ],
  "raw_text": string                   // all visible text, preserve line breaks
}

Rules:
- Transcribe exactly what's visible — don't hallucinate payouts not shown.
- For payout multipliers, capture both bet-level and bet-size multipliers if shown.
- If a symbol's multiplier is not visible on this page, set multipliers=null.
- Return ONLY the JSON object, no prose.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson(raw) as TranscribedRulesPage | null;
  if (!parsed) {
    return {
      page_number: pageNumber,
      title: null,
      sections: [],
      symbols: [],
      features: [],
      raw_text: `[transcription failed] raw: ${raw.slice(0, 400)}`,
    };
  }
  return parsed;
}

export async function decideNextAction(args: {
  screenshotPath: string;
  viewport: { width: number; height: number };
  spinsCompleted: number;
  spinsTarget: number;
  lastAction?: { action: string; reason: string } | null;
}): Promise<AIDecision> {
  const { screenshotPath, viewport, spinsCompleted, spinsTarget, lastAction } = args;
  const imageBase64 = readFileSync(screenshotPath).toString("base64");

  const prompt = `Viewport ${viewport.width}x${viewport.height}. Progress ${spinsCompleted}/${spinsTarget} spins done.
${lastAction ? `Last action: ${lastAction.action} — ${lastAction.reason}` : "First iteration."}

Decide the next action to automate a Fortune Pig slot-machine game. Return ONLY a JSON object (no prose, no markdown fences) with these fields:
{
  "action": "click" | "wait" | "spin_done" | "error",
  "x": number,          // viewport px (center of element to click). 0 if no click.
  "y": number,          // viewport px. 0 if no click.
  "reason": string,     // 1 short sentence
  "confidence": number, // 0..1
  "observed_balance": string | null,  // balance text as shown (e.g. "999,999.60") or null if not visible
  "observed_win": string | null,      // win amount of last spin if visible, else null
  "spin_state": "idle" | "spinning" | "result_visible" | "modal_blocking" | "unknown"
}

Semantics:
- "click" → tap at (x,y). Use this to dismiss any modal/tutorial/welcome popup, accept terms, close result dialog, or press the main Spin button.
- "wait" → reels spinning, loading, or animation in progress.
- "spin_done" → a spin has clearly completed (reels stopped, result settled). Caller increments counter.
- "error" → unrecoverable (error modal, blank screen).

Priority: dismiss any blocker first; then if idle, click the main Spin/Play button; otherwise wait. The Spin button is typically a prominent circular/rectangular button in the center-bottom or right of the game canvas.`;

  const raw = await askClaudeVision(prompt, imageBase64);
  const parsed = extractJson<AIDecision>(raw);
  if (!parsed) {
    return {
      action: "error",
      x: 0,
      y: 0,
      reason: `Không parse được JSON từ AI. Raw: ${raw.slice(0, 200)}`,
      confidence: 0,
      observed_balance: null,
      observed_win: null,
      spin_state: "unknown",
    };
  }
  return parsed;
}
