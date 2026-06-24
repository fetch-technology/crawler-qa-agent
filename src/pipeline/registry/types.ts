export type GameSlug = string;

export type UiElementStrategy =
  | "dom"
  | "ocr"
  | "template"
  | "ai_vision"
  | "ai_recover"
  | "manual"
  | "manual_correction";

export type UiVerifyStatus = "verified" | "rejected" | "pending";

export type UiElement = {
  x: number;
  y: number;
  strategy: UiElementStrategy;
  confidence: number;
  selector?: string;
  baselineScreenshot?: string;
  detectedAt: string;
  /** What promoted this element to `status: "verified"`:
   *   - "QA" — a human clicked Confirm or supplied coords via Pick.
   *   - "probe" — runtime self-validation: clicked the AI-proposed coord, observed
   *     the expected signal (network response / pixel diff / OCR change). Equally
   *     trusted as QA for use, but flagged so QA can spot-check.
   *   - null/undefined — not yet promoted.
   */
  verifiedBy?: "QA" | "probe" | null;
  status?: UiVerifyStatus;
  verifiedAt?: string;
  /** When verifiedBy === "probe", a short tag describing the signal that
   *  confirmed (e.g. "spinResponse", "pixelDiff+OCR", "betOcrChanged"). */
  probeSignal?: string;
  /** True when this element lives on an EXTERNAL browser tab opened by
   *  clicking its parent trigger (window.open / target="_blank") — common
   *  for legacy game-history popups. Case-executor uses this to route the
   *  click to the captured tab page instead of the original game page.
   *  Coords are tab-relative (top-left of the new window, NOT of the game
   *  iframe). When the parent trigger click first opens the tab, all
   *  descendant clicks on namespaced children (`parentKey__child`) target
   *  the same tab until it's closed. */
  externalPage?: boolean;
  /** PNG baseline crop of the element in its known-OFF state — captured
   *  by ante-normalize after enforcing ante OFF during Discover. Used by
   *  runtime ensure_ante_off lambda (Tier 2 pixel diff) and by discover-
   *  time pre-snapshot guards to detect accidental drift. Stored as a
   *  relative path (e.g. "ante-baseline.png" under the game's fixtures
   *  dir); empty/undefined when not captured. Currently only meaningful
   *  for anteButton — defining at element level for future flexibility
   *  (e.g. doubleChance toggle could reuse). */
  offBaseline?: string;
};

export type UiRegistry = {
  spinButton?: UiElement;
  autoButton?: UiElement;
  turboButton?: UiElement;
  betPlus?: UiElement;
  betMinus?: UiElement;
  buyBonusButton?: UiElement;
  historyButton?: UiElement;
  menuButton?: UiElement;
  closePopupButton?: UiElement;
  paytableButton?: UiElement;
  [extra: string]: UiElement | undefined;
};

export type ProviderName = "Pragmatic" | "Generic" | "ThreeOaks";

export type ProviderCache = {
  provider: ProviderName;
  gameName: string;
  platform: "HTML5" | "Unity" | "Flash" | "Unknown";
  iframeCount: number;
  canvasCount: number;
  detectedAt: string;
};

export type ApiMapping = {
  spinApi: { url: string; method: "GET" | "POST" };
  historyApi?: { url: string; method: "GET" | "POST" };
  buyBonusApi?: { url: string; method: "GET" | "POST" };
};

export type FieldMapping = {
  bet: string;
  win: string;
  balance: string;
  balanceBefore?: string;
  roundId: string;
  reels: string;
  state?: string;
  freeSpinsRemaining?: string;
};

export type ParserCache = {
  parser: "PragmaticParser" | "GenericParser";
  version: number;
};

/**
 * Per-game bet-control tunables. Used by `set_bet_to_min` / `set_bet_to_max`
 * scenario actions. Default 20 clicks works for most PP games whose bet
 * ladder has 5-15 steps (clicking past max/min is no-op). Some games need
 * more clicks (longer ladder) or different delay.
 */
/**
 * Per-game popup keyword overrides. Empty/missing → engine uses defaults
 * from src/pipeline/utils/ocr-popup.ts. Extending list adds game-specific
 * popup names (e.g. "ROLLING IN TREASURES" splash, custom event banners).
 */
/**
 * Per-trigger sub-state hint: when QA clicks a UI element, what popup does
 * it open? Used by manual-verify discovery to suggest a state label.
 * Per-game override file `sub-state-hints.json` can add new triggers
 * (game-specific buttons) or override default labels.
 */
export type SubStateHintsConfig = {
  /** Map from trigger key (e.g. "buyBonusButton") → hint */
  hints?: Record<string, { stateLabel: string; description: string; discoverHint?: string }>;
};

/**
 * Per-game list of UI elements that discovery should TARGET (main-state).
 * Defaults cover the universal slot buttons (spinButton, betPlus, ...).
 * Per-game override file `expected-ui-elements.json` can ADD game-specific
 * elements (anteBet, doubleChance, autoCountSlide-N, ...) so AI discovery
 * actively looks for them instead of silently missing them.
 */
export type ExpectedUiElementsConfig = {
  /** Replace defaults entirely instead of extending. Default false (extend). */
  replaceDefaults?: boolean;
  /** Element targets — each has a visual description fed to the AI prompt. */
  elements?: Array<{ key: string; description: string; critical?: boolean }>;
};

export type PopupKeywordsConfig = {
  /** Additional interstitial popup keywords (auto-dismissable). */
  interstitial?: string[];
  /** Additional sub-state popup keywords (paytable / settings / etc.). */
  substate?: string[];
  /** Replace defaults entirely instead of extending. Default false. */
  replaceDefaults?: boolean;
};

export type BetControlsConfig = {
  /** Clicks on betMinus to reach min. Default 20. */
  minBetClicks?: number;
  /** Clicks on betPlus to reach max. Default 20. */
  maxBetClicks?: number;
  /** Wait between clicks (ms). Default 80. */
  stepDelayMs?: number;
};

/**
 * Per-game timing tunables for the scenario runner (Phase 8). All defaults
 * baked into the engine but overridable via `timing-config.json` per game
 * (e.g., slow games need longer settle, fast games can shrink it).
 */
export type TimingConfig = {
  /** Max wait for a spin click → response (ms). Default 15000. */
  spinResponseTimeoutMs?: number;
  /** No-new-spin idle window after action loop (ms). Default 10000. */
  postActionSettleMs?: number;
  /** First-spin grace period before bailing if no responses (ms). Default 30000. */
  actionTimeoutMs?: number;
  /** Absolute hard cap for entire case execution (ms). Default 300000 (5 min). */
  hardCapMs?: number;
  /** Delay before suspecting popup-block after spin click (ms). Default 2500. */
  popupCheckDelayMs?: number;
  /** Wait between center-click attempts in dismiss action (ms). Default 800. */
  dismissInterClickMs?: number;
  /** Pre-dismiss wait for animation chains (ms). Default 10000. */
  dismissPreWaitMs?: number;
  /** Max popup-recover retries per spin click. Default 2. */
  maxSpinRetries?: number;
};

/**
 * Per-game mechanic facts derived from observed network traffic during
 * cold-start (or first manual session spin). Used by the parser to compute
 * bet correctly across different game families (lines vs ways vs cluster).
 *
 * - mechanic: how the game pays out
 *   - "lines"   — paylines (vs20rnriches has 20). bet = c × l (or c × bl).
 *   - "ways"    — ways-to-win (vswaysmahwin2 has 1024). bet = c × FIXED_M
 *                 (usually 20 across PP catalog). l field carries WAYS COUNT.
 *   - "cluster" — cluster pays (Sweet Bonanza). bet = c × FIXED_M.
 *   - "unknown" — not yet detected.
 * - betMultiplier: the M in `bet = c × M`. Derived from balance change
 *   between consecutive spins (deductedAmount / c). Persists per game.
 * - waysOrLines: raw `l` value from the spin request — informational, helps
 *   future debugging.
 * - detectedAt: ISO timestamp.
 * - detectionMethod: how this entry was derived. "balance_derived" is the
 *   trusted path (observed real deduction). "manual" if QA overrode. "fallback"
 *   if we used a heuristic (l vs M comparison) without balance evidence.
 */
export type GameMechanics = {
  mechanic: "lines" | "ways" | "cluster" | "unknown";
  betMultiplier: number;
  waysOrLines: number;
  detectedAt: string;
  detectionMethod: "balance_derived" | "manual" | "fallback";
  evidence?: {
    coin: number;
    deductedFromBalance: number;
    requestSample?: string;
  };
};

export type Region = { x: number; y: number; width: number; height: number };

export type OcrRegions = {
  balanceArea?: Region;
  winArea?: Region;
  freeSpinCounter?: Region;
  betArea?: Region;
};

export type StateSignature =
  | { kind: "ocr"; text: string; region: Region }
  | { kind: "template"; image: string; region: Region };

export type StateSignatures = {
  FREE_SPIN?: StateSignature;
  BONUS?: StateSignature;
  GAMBLE?: StateSignature;
  RETRIGGER?: StateSignature;
};

export type PaytableEntry = {
  symbol: string;
  name: string;
  payouts: Array<{ count: number; multiplier: number }>;
};

export type Paytable = {
  symbols: PaytableEntry[];
  features?: Array<{ name: string; description?: string }>;
};

/**
 * Self-calibrated payout model — for each numeric reel symbol index, the
 * coin-INVARIANT unit rate per N-of-a-kind count, measured from the server's
 * own win breakdown and confirmed to match the published paytable.
 *
 * Predicted combo win = curve[count] * ways * coin   (ways absent/0 => 1).
 *
 * Derived from captured spins (>= 2 coin levels) + paytable, then GATED by
 * self-validation: `trusted` only when it reproduces 100% of observed combos
 * AND the measured rates agree with the paytable (so "verify vs paytable" is
 * real). Verification is a NO-OP unless trusted → never false-fails.
 */
export type PayoutModel = {
  mechanic: GameMechanics["mechanic"];
  /** index (as string) -> { curve: count -> coin-invariant unit rate
   *  (win/ways/coin); names: candidate paytable symbol names (>1 when several
   *  share an identical curve — harmless, same pay); paytableAgreement }. */
  symbolCurves: Record<string, {
    curve: Record<string, number>;
    names: string[];
    paytableAgreement: boolean;
  }>;
  calibration: {
    coinLevels: number[];      // distinct coin values observed during calibration
    spinsUsed: number;
    combosTotal: number;
    combosMatched: number;     // combos reproduced within tolerance
    reproducedAll: boolean;    // combosMatched === combosTotal
    paytableAgreement: boolean; // measured rates matched the paytable (all named symbols)
    derivedBy: "deterministic" | "ai" | "deterministic+ai";
  };
  /** Only true when reproducedAll AND coinLevels.length >= 2 AND paytable
   *  agreement. Verification is a NO-OP unless trusted (never false-fails). */
  trusted: boolean;
  generatedAt: string;
  notes?: string[];
};

export type PopupRegions = {
  paytablePopup?: Region;
  historyPopup?: Region;
  buyBonusPopup?: Region;
  historyRowTemplate?: Region;
};

export type RegistryMeta = {
  schemaVersion: number;
  createdAt: string;
  lastValidatedAt?: string;
  gameUrl: string;
  gameVersionHash?: string;
};

export type ValidationResult = {
  ok: boolean;
  invalidEntries: string[];
  reason?: string;
};

export interface RegistryStore<T> {
  load(slug: GameSlug): Promise<T | null>;
  save(slug: GameSlug, data: T): Promise<void>;
  exists(slug: GameSlug): Promise<boolean>;
}
