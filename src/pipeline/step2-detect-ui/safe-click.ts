// Safety guards for graph exploration. Some UI elements MUST NOT be clicked
// during discovery because clicking them has irreversible side effects:
//   - spinButton → triggers real spin (deducts balance)
//   - confirmButton inside buyBonus → deducts ~$40-$10000 (buy bonus cost)
//   - startButton inside autoplay → loops infinite spins
//   - gambleButton → risks current win
//
// Pattern matched on element key (registry name). Blacklist takes priority
// over whitelist.

const BLACKLIST_PATTERNS: RegExp[] = [
  /^spinButton$/i,
  /^autoButton$/i,         // toggles autoplay popup — but actuating start is gated separately
  /confirm.*[Bb]utton$/i,  // buyBonus__confirmButton, etc.
  /start.*[Bb]utton$/i,    // autoplay__startButton, etc.
  /[Gg]amble[Bb]utton$/i,
  /double.*[Bb]utton$/i,   // gamble double button
  /buy.*[Bb]utton$/i,      // buyBonus__buySuperButton — these would COMMIT a buy
  /superButton$/i,         // buy super tier button
  /normalButton$/i,        // buy normal tier button
  /anteButton$/i,          // ante toggle ON would change next spin
];

// Elements that are CONFIRMED safe to click for discovery — they reveal
// new state without changing game economics.
const WHITELIST_PATTERNS: RegExp[] = [
  /^menuButton$/i,
  /^historyButton$/i,
  /^paytableButton$/i,
  /^buyBonusButton$/i,       // opens popup, doesn't commit
  /^autoButton$/i,           // re-allow autoButton opening (clicked once to open autoplay popup)
  /[Cc]loseButton$/i,
  /closeButton$/i,
  /prevPageButton$/i,
  /nextPageButton$/i,
  /rulesButton$/i,
  /infoButton$/i,
  /settingsButton$/i,
  /soundToggle$/i,
];

export function isSafeToClickForDiscovery(elementKey: string): boolean {
  // Whitelist takes precedence — explicit allow.
  for (const pat of WHITELIST_PATTERNS) {
    if (pat.test(elementKey)) return true;
  }
  // Otherwise blacklist filters out destructive.
  for (const pat of BLACKLIST_PATTERNS) {
    if (pat.test(elementKey)) return false;
  }
  // Unknown elements: conservative — skip.
  return false;
}

export function explainSafety(elementKey: string): string {
  if (isSafeToClickForDiscovery(elementKey)) return "safe";
  for (const pat of BLACKLIST_PATTERNS) {
    if (pat.test(elementKey)) return `blacklisted by pattern ${pat.source}`;
  }
  return "not in whitelist (conservative skip)";
}
