// Per-key descriptions for the canonical main-screen UI elements, fed to the
// crop-verify locator so AI knows EXACTLY what to look for AND what success
// looks like after clicking. Each description has two parts:
//   1. Visual cue — how to identify the button on screen.
//   2. Expected click response — what SHOULD happen when clicked. This is
//      critical because the agent verifies its coord by CLICKING and OBSERVING
//      the game state. Without an explicit "what to expect", the agent can
//      mistake any screen change for success — e.g. clicking the spin button
//      while hunting for the autoplay button triggers a spin, and the agent
//      reports the wrong coord as verified (observed 2026-05-31 on
//      vs20rnriches: autoButton refined to (985,660) which is the spin
//      button's coord, balance ticked down 4 times during agent run, agent
//      still committed because "something happened"). The response cue gives
//      a negative check: "if I see X instead of the expected response, the
//      click missed".

export const CANONICAL_ELEMENT_DESCRIPTIONS: Record<string, string> = {
  spinButton:
    "the SPIN button — large round button at the bottom-center of the game UI, " +
    "typically with a circular-arrow icon. The most prominent button on screen. " +
    "EXPECTED RESPONSE on click: reels start rotating and the balance ticks " +
    "down by the bet amount within ~1s.",
  autoButton:
    "the AUTOPLAY button — round/rectangular button next to the spin button, " +
    "showing a circular-arrow icon with an 'A' or 'AUTO' label. " +
    "EXPECTED RESPONSE on click: an AUTOPLAY settings popup opens (showing " +
    "options like 'Number of spins', 'Stop after', loss limits, etc.). The " +
    "click should NOT spin the reels and should NOT decrease balance. If " +
    "clicking triggers a spin instead, you hit the spin button — refine to a " +
    "different coordinate.",
  turboButton:
    "the TURBO / fast-spin button — small button near the spin button, with a " +
    "lightning-bolt icon. EXPECTED RESPONSE on click: a turbo-mode indicator " +
    "appears (or the icon highlights); no spin, no popup. Often a toggle.",
  betPlus:
    "the bet PLUS button — '+' icon attached to (or just right of) the bet " +
    "amount display in the bottom info bar. " +
    "EXPECTED RESPONSE on click: the displayed bet amount increases by one " +
    "step within ~500ms (visible in the bet readout in the bottom info bar). " +
    "No spin, no popup. If the bet display does NOT change, the click missed.",
  betMinus:
    "the bet MINUS button — '-' icon attached to (or just left of) the bet " +
    "amount display in the bottom info bar. " +
    "EXPECTED RESPONSE on click: the displayed bet amount decreases by one " +
    "step within ~500ms (visible in the bet readout in the bottom info bar). " +
    "No spin, no popup. If the bet display does NOT change, the click missed.",
  betButton:
    "the BET / TOTAL BET level selector — a SINGLE tappable control (the bet " +
    "value readout itself, or a small coin/stack/▾ button beside it) used by " +
    "games that have NO separate '+'/'−' step buttons. " +
    "EXPECTED RESPONSE on click: a popup/panel opens listing selectable bet " +
    "amounts (chips like 0.20, 0.50, 1.00 …) for the player to pick. If the " +
    "game instead nudges the bet by one step, that is betPlus/betMinus, not " +
    "betButton. Return null when explicit +/- steppers exist.",
  buyBonusButton:
    "the BUY BONUS / BUY FEATURE button — usually a yellow, orange or " +
    "highlighted button somewhere on the side of the spin button, labeled " +
    "BUY BONUS, BUY FEATURE, BUY FREE SPINS, or just BUY. " +
    "EXPECTED RESPONSE on click: a confirmation popup opens showing the cost " +
    "to buy the feature (often '100x bet' or similar), with Yes/No or " +
    "Confirm/Cancel actions. No spin, no autoplay options.",
  menuButton:
    "the menu button — usually a hamburger ☰ icon, often at top-left or " +
    "bottom-left corner. " +
    "EXPECTED RESPONSE on click: a settings/menu popup opens with options " +
    "like Sound, Music, Language, History, Settings, etc.",
  paytableButton:
    "the paytable / info button — typically an 'i' icon or 'PAYTABLE' label. " +
    "Often near the menu button. " +
    "EXPECTED RESPONSE on click: a paytable popup opens showing symbol " +
    "payouts, multipliers, wild/scatter rules, and/or free spins rules. May " +
    "open to a 'FREE SPINS rules' page first — that still counts as success.",
  historyButton:
    "the game history button — clock or rectangular-list icon. " +
    "EXPECTED RESPONSE on click: a history popup opens showing previous " +
    "spin rounds (round IDs, bet, win, timestamp). Often in the menu area.",
  anteButton:
    "the ANTE BET / BET+ / Double Chance / Bet Boost toggle — a small toggle " +
    "or labeled control (often showing 'ANTE BET', 'BET+', '2x', or a " +
    "percentage like '+25%') usually on the LEFT side of the reels / bet area, " +
    "on the OPPOSITE side from the spin/buy cluster. Increasing the bet to " +
    "raise the free-spin trigger chance. " +
    "EXPECTED RESPONSE on click: the control switches ON/OFF (its highlight " +
    "or label state flips) and the displayed total bet changes (typically ×1.25 " +
    "when ON). No spin, no full-screen popup — it may open a small inline " +
    "panel. If the bet does not change and nothing toggles, the click missed. " +
    "Returns null if the game has no ante feature.",
};

/** Return the description for a canonical key, or null if not canonical. */
export function describeCanonicalElement(uiKey: string): string | null {
  return CANONICAL_ELEMENT_DESCRIPTIONS[uiKey] ?? null;
}

/**
 * Augment a canonical-element description with a SPATIAL ANCHOR derived from
 * the already-known spinButton coord. Crop-verify agent vision is fragile for
 * adjacent / small buttons (autoButton vs spinButton, betPlus vs spinButton —
 * <50px gaps); without an anchor it can drift onto the wrong neighbor and
 * commit a "verified" coord that triggers the wrong response. With an anchor
 * ("spinButton is at (988,640); the AUTOPLAY button is ~80-150px right of it"),
 * the agent has a measurable reference + can recenter its search.
 *
 * Only added when spinButton has a finite coord. Self (spinButton) gets the
 * base description unchanged — it's the anchor for everyone else, discovered
 * first because it's the largest, most unambiguous control.
 *
 * Caller order matters: this is called AFTER spinButton is verified. For
 * keys with no useful anchor relationship to spin (menuButton, paytableButton
 * — usually in a different corner of the UI), the base description is
 * returned unchanged.
 */
export function enrichDescriptionWithSpinAnchor(
  uiKey: string,
  baseDescription: string,
  spinCoord: { x: number; y: number } | null,
): string {
  if (!spinCoord || !Number.isFinite(spinCoord.x) || !Number.isFinite(spinCoord.y)) {
    return baseDescription;
  }
  if (uiKey === "spinButton") return baseDescription;

  const sx = Math.round(spinCoord.x);
  const sy = Math.round(spinCoord.y);

  const anchorByKey: Record<string, string> = {
    betPlus:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The bet PLUS button is ` +
      `IMMEDIATELY ADJACENT to the bet readout — typically 80-180px RIGHT of spinButton at a ` +
      `similar y (within ±40px). It is a SMALL "+" icon, not a large round button. If a candidate ` +
      `coordinate falls within 30px of spinButton's center, that candidate IS spinButton — keep ` +
      `searching outward.`,
    betMinus:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The bet MINUS button is ` +
      `IMMEDIATELY ADJACENT to the bet readout — typically 80-180px LEFT of spinButton at a ` +
      `similar y (within ±40px). It is a SMALL "−" icon, not a large round button. If a candidate ` +
      `coordinate falls within 30px of spinButton's center, that candidate IS spinButton — keep ` +
      `searching outward.`,
    autoButton:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The AUTOPLAY button is ` +
      `ADJACENT to spinButton — typically 50-150px RIGHT of spinButton, or directly BELOW it ` +
      `(~50px down). It is NEVER on top of spinButton. If a candidate coord falls within 30px ` +
      `of spinButton's center, you've identified spinButton — refine OUTWARD (right or down).`,
    turboButton:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The TURBO button is a SMALL ` +
      `icon near spinButton — usually 50-100px LEFT of spinButton, or just below the bet area. ` +
      `Not the large central button itself.`,
    buyBonusButton:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The BUY BONUS button is a ` +
      `prominent labeled button (often yellow/orange/red) SEPARATE from the spin/bet cluster. ` +
      `Frequently on the FAR LEFT or FAR RIGHT side of the UI, well away from spinButton ` +
      `(>200px). Do NOT pick a coord inside the spin/bet cluster.`,
    anteButton:
      `SPATIAL ANCHOR: the verified spinButton is at (${sx}, ${sy}). The ANTE BET / BET+ toggle ` +
      `sits SEPARATE from the spin/bet cluster — typically on the FAR LEFT side of the reels/bet ` +
      `area, often mirroring the buyBonus button on the opposite side (>150px from spinButton). ` +
      `It is a SMALL toggle/label, not a large round button. Do NOT pick a coord inside the ` +
      `spin/bet cluster; if a candidate falls within 30px of spinButton, keep searching the far side.`,
  };

  const anchor = anchorByKey[uiKey];
  return anchor ? `${baseDescription}\n\n${anchor}` : baseDescription;
}

/** Order in which to localize. Spin is first since it's the most unambiguous
 *  anchor; menu/info etc. follow. Less critical buttons last so a timeout in
 *  the middle doesn't leave the must-haves missing. */
// historyButton + turboButton are intentionally EXCLUDED — in PP-style games
// they live INSIDE popups (history → menu popup, turbo → autoplay popup), NOT
// on the main screen. Localizing them at level 1 makes the AI hallucinate a
// main-screen coord (false positive). Discover them as nested children via the
// per-row [Discover] flow on menuButton / autoButton. Mirrors the note in
// EXPECTED_UI_ELEMENTS_DEFAULTS.
export const CANONICAL_PRIORITY_ORDER: ReadonlyArray<string> = [
  "spinButton",
  "betPlus",
  "betMinus",
  "menuButton",
  "paytableButton",
  "buyBonusButton",
  "autoButton",
  "anteButton",
];
