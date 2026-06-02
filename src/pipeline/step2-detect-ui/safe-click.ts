// Safety guards for graph exploration. Some UI elements MUST NOT be clicked
// during discovery because clicking them has irreversible side effects:
//   - spinButton → triggers real spin (deducts balance + advances state)
//   - confirmButton / yesButton inside buyBonus → COMMITS the buy (real $$)
//   - startButton inside autoplay → loops infinite spins
//   - gambleButton → risks current win
//
// Two modes:
//   PRODUCTION (default): full blacklist + narrow whitelist; unknown → skip.
//   AGGRESSIVE (env QA_AGGRESSIVE_DISCOVER=1): only the CRITICAL blacklist
//     stays; unknown → ALLOW. Lets the explorer reach destructive popups
//     (e.g. open buy-bonus tier options → discover Yes/Cancel popup → ESC
//     out via navigate-back) without clicking the actual commit buttons.
//     Intended for dev/demo environments where balance is fake.

// Always blocked, in EVERY mode. These DIRECTLY commit / advance game
// state, never reveal new UI worth discovering on click.
const CRITICAL_BLACKLIST_PATTERNS: RegExp[] = [
  /^spinButton$/i,
  /start.*[Bb]utton$/i,           // autoplay startButton
  /[Gg]amble[Bb]utton$/i,
  /double.*[Bb]utton$/i,          // gamble double button
  /confirm.*[Bb]utton$/i,         // buyBonus__confirmButton commits the buy
  /^yes[Bb]utton$|yes[Bb]utton$/i, // "yesButton" or "anything_yesButton"
];

// Production-safe blacklist (used only when AGGRESSIVE mode is OFF).
const PRODUCTION_BLACKLIST_PATTERNS: RegExp[] = [
  ...CRITICAL_BLACKLIST_PATTERNS,
  /^autoButton$/i,         // toggles autoplay popup; aggressive whitelists this
  /buy.*[Bb]utton$/i,      // buy tier (normalButton/superButton/buyMaxButton)
  /superButton$/i,
  /normalButton$/i,
  /anteButton$/i,          // ante toggle → changes next spin
];

// Elements that are CONFIRMED safe to click for discovery — they reveal
// new state without changing game economics. Expanded 2026-06-01 to cover
// popup-internal patterns (sliders, toggles, page nav, autoplay options)
// so depth-2/3 exploration actually fires. Previously most popup-internal
// keys (autoButton__autospinsSlider, paytableButton__page2Button, etc.)
// fell off the whitelist → conservative-skip → explorer stopped at depth 1.
const WHITELIST_PATTERNS: RegExp[] = [
  // Canonical main controls
  /^menuButton$/i,
  /^historyButton$/i,
  /^paytableButton$/i,
  /^buyBonusButton$/i,       // opens popup, doesn't commit
  /^autoButton$/i,           // opens autoplay popup
  /^betPlus$/i,              // adjusts bet (reversible) OR opens bet-selector popup
  /^betMinus$/i,             // adjusts bet (reversible) OR opens bet-selector popup
  // Popup-internal navigation / dismissal
  /[Cc]loseButton$/i,
  /closeButton$/i,
  /[Bb]ackButton$/i,
  /[Cc]ancelButton$/i,
  /prevPageButton$/i,
  /nextPageButton$/i,
  /[Pp]age\d+Button$/i,      // page1Button, page2Button, …
  /[Tt]ab$/i,                // generic tab navigation
  /rulesButton$/i,
  /infoButton$/i,
  /settingsButton$/i,
  // Toggles / sliders (configuration, not commit)
  /[Tt]oggle$/i,             // soundToggle, musicToggle, ambientToggle, turboToggle, …
  /[Ss]lider$/i,             // volumeSlider, autospinsSlider, …
  /[Vv]olumeButton$/i,
  /[Mm]uteButton$/i,
  // Autoplay options (do NOT commit — only configure)
  /lossLimitButton$/i,
  /singleWinLimitButton$/i,
  /winExceedsLimitButton$/i,
  /[Ss]topOn[A-Z]/i,          // stopOnAnyWin, stopOnFeature, stopOnBalanceLimit, …
  // Bet adjusters (reversible)
  /quickBetButton$/i,
  /[Bb]etLevel[A-Z]?/i,       // betLevel1, betLevel2, betLevelMax, …
  /[Cc]oinValue/i,            // coinValueDecrease/Increase
  // Paytable / info panel sub-buttons
  /[Ss]ymbolButton$/i,
  /[Ll]anguageButton$/i,
  /[Hh]elpButton$/i,
];

function isAggressiveMode(): boolean {
  return process.env.QA_AGGRESSIVE_DISCOVER === "1";
}

export function isSafeToClickForDiscovery(elementKey: string): boolean {
  if (isAggressiveMode()) {
    // Dev mode — block only the truly committing/advancing buttons. Allow
    // everything else (incl. buy-tier options, unknowns) so the explorer can
    // reach destructive popups + discover their contents, then ESC back.
    for (const pat of CRITICAL_BLACKLIST_PATTERNS) {
      if (pat.test(elementKey)) return false;
    }
    return true;
  }
  // Production-safe — whitelist precedence, then blacklist, unknown skipped.
  for (const pat of WHITELIST_PATTERNS) {
    if (pat.test(elementKey)) return true;
  }
  for (const pat of PRODUCTION_BLACKLIST_PATTERNS) {
    if (pat.test(elementKey)) return false;
  }
  return false;
}

export function explainSafety(elementKey: string): string {
  if (isSafeToClickForDiscovery(elementKey)) return "safe";
  if (isAggressiveMode()) {
    for (const pat of CRITICAL_BLACKLIST_PATTERNS) {
      if (pat.test(elementKey)) return `aggressive: critical-blacklist ${pat.source}`;
    }
    return "aggressive: unexpected skip";
  }
  for (const pat of PRODUCTION_BLACKLIST_PATTERNS) {
    if (pat.test(elementKey)) return `blacklisted by pattern ${pat.source}`;
  }
  return "not in whitelist (conservative skip)";
}
