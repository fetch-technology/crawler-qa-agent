// Per-key behavior expectations fed to the verify-click agent. The agent
// clicks the element and judges whether the observed response matches
// the expectation described here — same pattern the upstream
// logic-data-crawler-creator uses (LLM observes click result + reasons
// about whether it matches mode/popup expectation), adapted to per-element
// granularity for QA registry building.
//
// Behavior strings are written for an LLM consumer: they describe what to
// LOOK FOR after the click (popup-close, page transition, toggle flip,
// network request, etc.) AND the explicit rejection signals that mean the
// click missed (real spin triggered, wrong popup opened, etc.).

const DEFAULT_BEHAVIOR =
  "Should produce a visible response (popup opens, page changes, toggle flips, " +
  "value updates, or a selection highlights). MUST NOT close the current popup " +
  "unexpectedly, MUST NOT trigger a real spin (which would deduct bet from balance " +
  "and start reels spinning). If the only observable response is reels spinning " +
  "and/or balance dropping by the bet amount, this is the WRONG button — the " +
  "click landed on the canvas spin area, not the intended element.";

/**
 * Returns a free-form English description of what SHOULD happen when the
 * given ui-element is clicked. Used by `verifyClickAgent` to decide if the
 * observed click result matches expectation. The description is pattern-
 * matched against the last segment of the (possibly namespaced) key so it
 * works for both canonical keys and sub-state keys at any depth.
 *
 * Returns null when the key doesn't match any known pattern — caller
 * substitutes a generic default.
 */
export function expectedBehaviorFor(uiKey: string): string {
  const lastSegment = uiKey.split("__").pop() ?? uiKey;
  const lower = lastSegment.toLowerCase();

  // Dismissal / navigation back — popup should close (or page back).
  if (/(^|[_-])(close|cancel|exit|back|dismiss)([A-Z]|$)|closeButton$|cancelButton$|exitButton$|backButton$/i.test(lastSegment)) {
    return (
      "Should CLOSE the current popup and return to the previous screen " +
      "(typically the main game or a parent popup). Expect a LARGE visible " +
      "change (>30% pixel diff) — the popup is gone and game-main reveals. " +
      "If the popup stays open after the click, the coord is on the wrong " +
      "control. If clicking triggers a real spin (reels rotate, balance " +
      "drops), the click bypassed the popup entirely — reject."
    );
  }

  // Bet selection in a bet-picker popup.
  if (/^bet-[\d.]+/i.test(lastSegment) || /betoption|bet_option/i.test(lower)) {
    return (
      "Should SELECT a bet level in the bet selector popup. Either (a) the " +
      "tapped level highlights (small visual change near the click point, " +
      "1-10% pixel diff localized), OR (b) the popup closes and the main bet " +
      "readout updates to this level. MUST NOT trigger a spin. MUST NOT open " +
      "an unrelated popup (autoplay, paytable, buy bonus)."
    );
  }

  // Pagination within a popup.
  if (/nextpage|next_page|page\d+/i.test(lower)) {
    return (
      "Should NAVIGATE to a different page within the SAME popup. Page " +
      "content changes (30-70% pixel diff inside the popup area) but the " +
      "popup itself stays open — close button still visible, popup frame " +
      "unchanged. MUST NOT close the popup. MUST NOT spin."
    );
  }
  if (/prevpage|prev_page/i.test(lower)) {
    return (
      "Should NAVIGATE to the previous page within the same popup. Page " +
      "content changes but the popup stays open. MUST NOT close the popup."
    );
  }

  // Tabs.
  if (/[Tt]ab$|^tab[A-Z]/i.test(lastSegment) || /symboldetailstab/i.test(lower)) {
    return (
      "Should SWITCH between tabs in the same popup. Content area changes; " +
      "tab indicator highlights. Popup itself stays open."
    );
  }

  // Toggles — small visual change, no popup transition.
  if (/[Tt]oggle$/i.test(lastSegment)) {
    return (
      "Should TOGGLE a setting state (sound on/off, music on/off, ante on/off, " +
      "turbo on/off, etc.). Small but distinct visual change near the click " +
      "coord — the icon flips state (e.g. speaker icon swaps to muted, switch " +
      "moves from off to on). MUST NOT close the popup. MUST NOT spin. MUST " +
      "NOT open a new popup."
    );
  }

  // Sliders — drag/click adjust value.
  if (/[Ss]lider$/i.test(lastSegment)) {
    return (
      "Should ADJUST the slider value. Either the thumb moves toward the " +
      "click coord, or a discrete snap-point highlights. Visible change " +
      "localized to the slider track. MUST NOT close the popup. MUST NOT spin."
    );
  }

  // Volume / mute buttons (specific kinds of toggles, sometimes labeled differently).
  if (/[Vv]olumeButton$|[Mm]uteButton$/i.test(lastSegment)) {
    return (
      "Should TOGGLE volume or mute state. Icon updates. Popup stays open. " +
      "No spin."
    );
  }

  // Limit-config buttons inside autoplay popup.
  if (/lossLimit|singleWinLimit|winExceedsLimit/i.test(lastSegment)) {
    return (
      "Should OPEN a sub-popup for entering a numeric limit (loss limit, " +
      "single-win limit, etc.) — typically a small input field or keypad " +
      "appears. OR toggles the limit's enabled state. Popup must stay " +
      "present (parent or sub). MUST NOT close the autoplay popup entirely."
    );
  }

  // stopOnXxx in autoplay options.
  if (/stopOn[A-Z]/i.test(lastSegment)) {
    return (
      "Should TOGGLE an autoplay stop condition (stop on any win, stop on " +
      "feature, stop on balance limit). Small visual change near the option " +
      "row. MUST NOT start autoplay, MUST NOT close popup."
    );
  }

  // Quick-bet / coin-value adjusters (bet area, not main bet+/-).
  if (/quickBetButton$|betLevel|coinValue/i.test(lastSegment)) {
    return (
      "Should ADJUST bet level or coin value. Bet readout in the popup OR " +
      "main UI updates. May produce small UI animation. MUST NOT spin. " +
      "MUST NOT close popup unexpectedly."
    );
  }

  // Confirm / yes — commits an action (may cost money).
  if (/confirm|^yes/i.test(lower)) {
    return (
      "Should COMMIT an action (e.g. purchase buy-bonus). Typically opens a " +
      "new popup (confirmation result, free spins UI) or closes current. " +
      "CAUTION: this may consume real money — expect large network activity " +
      "(/gameService POST with purchase payload) and balance change. As long " +
      "as a network request fires AND the UI advances to a new state, the " +
      "click is verified — even if balance dropped (this is the expected " +
      "behavior of confirm buttons in a dev environment)."
    );
  }

  // Start-autoplay — triggers autoplay loop.
  if (/start.*[Aa]utoplay|^startButton$|startAutoplayButton$/i.test(lastSegment)) {
    return (
      "Should START an autoplay sequence — multiple spins fire in succession. " +
      "Expect /gameService POSTs and balance drops in a loop. As long as the " +
      "first spin fires within ~3s, the click is verified (we don't wait for " +
      "the full autoplay to complete during verification)."
    );
  }

  // Symbol detail (paytable sub-button).
  if (/symbolButton$|symbol_button/i.test(lastSegment)) {
    return (
      "Should SHOW symbol detail / payout info — either highlight on the " +
      "current page or open a sub-section. Popup stays open."
    );
  }

  // Generic info-screen buttons in menu/settings popup.
  if (/[Ll]anguageButton$|[Hh]elpButton$|[Rr]ulesButton$|infoButton$/i.test(lastSegment)) {
    return (
      "Should OPEN an info / settings sub-screen. Either a new sub-popup " +
      "appears, OR content in the same popup swaps to the requested view. " +
      "Popup remains visible. MUST NOT close all popups, MUST NOT spin."
    );
  }

  // History-related (inside menu popup).
  if (/[Hh]istoryButton$|gameHistoryButton$/i.test(lastSegment)) {
    return (
      "Should OPEN a game-history view — typically a sub-popup or scrollable " +
      "list of past rounds. Popup remains visible (parent or new sub). MUST " +
      "NOT spin."
    );
  }

  return DEFAULT_BEHAVIOR;
}
