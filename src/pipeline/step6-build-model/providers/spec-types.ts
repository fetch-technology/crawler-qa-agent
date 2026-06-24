// Provider Spec — declarative description of a slot game provider's wire
// format. Used by SpecDrivenParser to handle ANY provider without code.
//
// Adding a new provider = write a JSON file matching this shape and register
// it via createParserForProvider(specJson). Zero TS code change required.
//
// Phase 9 — replaces hardcoded PragmaticParser / GenericParser with
// spec-driven generic parser.

export type WireFormat =
  | "querystring"   // URLSearchParams parsing (PP gs2c)
  | "json"          // application/json
  | "form"          // multipart form data
  | "auto";         // try JSON first, fall back to querystring

export type ReelsDecoder =
  | "column_major"  // Stops string laid out column-by-column (PP "s" field)
  | "row_major"     // Stops string laid out row-by-row
  | "json_array"    // Raw 2D array in JSON
  | "csv";          // Comma-separated, rows separated by newline or |

/** Field-name mapping from canonical → wire field. Multiple wire candidates
 *  separated by `|` are tried in order (e.g. "bb|balanceBefore"). Each candidate
 *  may be a DEEP path with dot segments (e.g. "context.spins.round_win",
 *  "user.balance") for providers that nest their spin data — resolved by walking
 *  the parsed object. A plain name with no dot is a top-level lookup (unchanged). */
export type FieldMap = {
  /** Wallet balance BEFORE bet was deducted. */
  balanceBefore?: string;
  /** Wallet balance AFTER spin completes (win credited). */
  balanceAfter: string;
  /** Round bet read from the RESPONSE (providers like 3 Oaks put round_bet in
   *  the response, not the request). When set + present, it takes priority over
   *  the request-side betFormula. Scaled by response.amountScale. */
  betAmount?: string;
  /** Total win for this round/cascade. */
  totalWin?: string;
  /** Reel grid (initial drop). */
  initialReels?: string;
  /** Reel grid (after cascade) — for cascade games. */
  cascadeFrames?: string;
  /** Free-spin counter remaining in current chain. */
  freeSpinsRemaining?: string;
  /** Round index (used for buildRoundId). */
  roundIndex?: string;
  /** Round action / completion flag. */
  roundAction?: string;
  /** Round/spin ID directly emitted by API. */
  roundId?: string;
  /** Reel grid dimensions if not constant per game. */
  reelWidth?: string;
  reelHeight?: string;
};

/** Request-side field map (for parseRequest + bet computation). */
export type RequestFieldMap = {
  coin?: string;
  betLevel?: string;
  lines?: string;
  explicitBet?: string;
  /** Request-side fields combined into stable roundId */
  roundIdParts?: string[];
};

/** Shape-scoring config: weights for required + bonus fields. */
export type ShapeScoreConfig = {
  /** Each present field adds 1 to score; absence subtracts 1. */
  requiredFields: string[];
  /** Each present field adds 1 to score (no penalty for absence). */
  bonusFields?: string[];
  /** Minimum score to consider the body a spin response. */
  minScore: number;
};

/** How a provider itemizes per-combo wins (drives `winBreakdown`).
 *  "auto" = try wlc_v then cluster fallback (legacy PragmaticParser behavior). */
export type WinItemization = "auto" | "wlc_v" | "cluster" | "lines" | "none";

/** Declarative free-spin / feature-state detector, evaluated by the parser's
 *  `deriveState` IN ADDITION to the numeric `freeSpinsRemaining` field. ANY
 *  matcher firing flags the frame as a free-spin candidate — still subject to
 *  the balance-not-decreased guard, so a BUY frame (token present but wallet
 *  drops) correctly stays NORMAL.
 *
 *  Motivation: PP clones encode free-spin state differently from the vanilla
 *  top-level `fs=N` counter — e.g. vs20daydead nests it in
 *  `trail=mode~free;...;fs~N`. A plain FieldMap path can't address a
 *  `~`/`;`-delimited sub-token, so this descriptor adds substring / regex
 *  matchers. Learned by the spec-learner and arithmetic-verified by the
 *  replay-gate (INV4) before it is trusted. */
export type FreeSpinSignal = {
  /** (a) Numeric counter field (deep path allowed) — same semantics as
   *  `freeSpinsRemaining`, for a game that names its FS counter differently.
   *  Free when value > 0. */
  counterField?: string;
  /** (b) String field whose value is tested by `contains` / `pattern`. */
  field?: string;
  /** Plain substring that, when present in `field`'s value, marks free-spin
   *  (e.g. "mode~free"). */
  contains?: string;
  /** Regex (string form) tested against `field`'s value. Free when it matches. */
  pattern?: string;
  /** (c) Last-resort regex tested against the RAW response body. */
  rawBodyPattern?: string;
};

/** Round ID construction recipe. */
export type RoundIdConfig = {
  /** Source: "request" reads from parsed request fields; "response" reads from response. */
  source: "request" | "response";
  /** Field names whose values combine into the ID (e.g., ["index", "counter"]). */
  fields: string[];
  /** Template for joining (e.g., "req-{0}-{1}" or "{0}_{1}"). Default "{0}-{1}-...". */
  format?: string;
  /** Fallback when fields missing: hash of response body slice. */
  fallback?: "response_hash" | "timestamp_random" | "throw";
};

export type ProviderSpec = {
  /** Provider name (e.g., "Pragmatic", "JILI", "PG"). */
  name: string;
  /** Wire format used by request + response bodies. */
  wireFormat: WireFormat;
  /** URL patterns that identify this provider's endpoints (any-match). */
  urlPatterns: string[];
  /** URL patterns to EXCLUDE from spin detection (auth, settings, history). */
  skipUrlPatterns?: string[];
  /** Action filter — non-spin actions in body that skip parsing. */
  nonSpinActions?: string[];
  /** Body params that MUST be present for a spin (filters init/settings). */
  spinRequiredParams?: string[];
  /** Response field map. */
  response: {
    fields: FieldMap;
    reelsDecoder?: ReelsDecoder;
    /** Default reel dimensions if response doesn't specify. */
    defaultReelDimensions?: { width: number; height: number };
    /** Multiplier applied to response money fields (balanceBefore/After,
     *  totalWin, betAmount) to convert MINOR units (cents) → display units.
     *  e.g. 0.01 for a provider that reports 50 = $0.50. Default 1 (no scaling)
     *  so existing specs are unaffected. */
    amountScale?: number;
    /** When true and the response carries no balanceBefore field, derive it as
     *  `balanceAfter + bet − win` (the only deterministic reconstruction for
     *  providers that report just the current balance). Default false → null. */
    deriveBalanceBefore?: boolean;
    shapeScore: ShapeScoreConfig;
    /** How this provider itemizes per-combo wins, so the parser can populate
     *  `winBreakdown` (Σ-of-combos == total-win, no-phantom-win, per-combo
     *  paytable checks all depend on it). Omitted ⇒ "auto": try `wlc_v`
     *  (PP ways/lines) then fall back to cluster `l0,l1,…` — matches the
     *  legacy PragmaticParser, so existing specs without this field still
     *  populate winBreakdown instead of silently leaving it empty.
     *    "wlc_v"   — PP `wlc_v=sym~win~ways~count~positions` itemization
     *    "cluster" — pays-anywhere `l0,l1,…` cluster itemization
     *    "lines"   — per-payline itemization (future)
     *    "none"    — provider genuinely does not itemize (only total-win) */
    winItemization?: WinItemization;
    /** Post-parse extractions from nested string-valued fields. Each entry
     *  reads a top-level field (e.g. PP's `g={gp:{s:"..."}}` blob) and pulls
     *  a substring out via regex into a new top-level key. Lets data-driven
     *  specs cope with semi-structured embedded payloads without core-code
     *  changes. The first capture group of `pattern` becomes the value of
     *  `targetField` if it doesn't already exist (won't overwrite real fields). */
    nestedExtractions?: Array<{
      sourceField: string;
      pattern: string;
      targetField: string;
    }>;
    /** Declarative free-spin/feature state detector for clones that don't use
     *  the vanilla top-level FS counter. See {@link FreeSpinSignal}. */
    freeSpinSignal?: FreeSpinSignal;
  };
  /** Request field map. */
  request: {
    fields: RequestFieldMap;
    /** Bet formula: "coin * betLevel", "coin * lines", "coin * fixed:N", or "explicit". */
    betFormula: string;
  };
  /** Round ID construction. */
  roundId: RoundIdConfig;
  /** Response patterns the provider emits AFTER a logical round (including
   *  cascades) is fully done — "you may click spin again now". The case
   *  runner waits for one of these signals before firing the next spin
   *  action, so cascade-heavy games (PP ways/cluster) don't silently drop
   *  rapid clicks during ongoing cluster animation. Each entry matches a
   *  response by URL regex AND optional body substring/regex. Empty array
   *  (or omitted) → fall back to silence-timeout heuristic.
   *
   *  Example (PP): the gameService endpoint returns body `action=doCollect`
   *  exactly once per logical round, right at the round-end moment.
   *
   *    [{ urlPattern: "/gs2c/.*gameservice", bodyPattern: "action=doCollect" }]
   */
  roundEndSignals?: Array<{
    urlPattern: string;
    bodyPattern?: string;
  }>;
};

/** One learned/overridden aspect of a per-game parser overlay. `trusted`
 *  gates whether it is allowed to override the provider base at runtime — set
 *  true only after the replay-gate (Phase 2) reconciles it on captured
 *  samples. An untrusted aspect is recorded for audit but NOT applied, so the
 *  game falls back to the provider base instead of using an unverified guess. */
export type ParserOverlayAspect<T> = {
  value: T;
  trusted: boolean;
};

/** Per-game parser overlay: the thin, game-specific delta on top of the
 *  provider base spec (the parts that genuinely vary between games of the same
 *  provider — win itemization, and later tumble/free-spin shape). Lives at
 *  `fixtures/registry/<slug>/parser-overlay.json`. Written by the spec-learner
 *  (Phase 3) after the replay-gate validates it; can also be hand-authored.
 *  `trusted` is PER-ASPECT: a game can certify itemization while leaving
 *  another aspect unverified, instead of an all-or-nothing flag. */
/** When a game credits free-spin wins to the wallet:
 *  - "immediate": each FS round's win lands on the balance as it resolves
 *  - "deferred":  balance stays FLAT during the chain; the accumulated total
 *                 is credited once at the END of the last free spin
 *  Games differ — conservation checks MUST consult the learned value instead
 *  of assuming one model (a deferred game false-fails every mid-chain round
 *  under the immediate assumption, and vice versa). */
export type FsCreditTiming = "immediate" | "deferred";

export type ParserOverlay = {
  schemaVersion: number;
  /** Provider base this overlay layers on (e.g. "pragmatic"). */
  basedOnProvider: string;
  /** How wins are itemized for THIS game (overrides base when trusted). */
  winItemization?: ParserOverlayAspect<WinItemization>;
  /** When THIS game credits FS wins to the balance (learned from captured FS
   *  chains; trusted only when the replay-gate's coverage saw a real chain). */
  fsCreditTiming?: ParserOverlayAspect<FsCreditTiming>;
  /** Free-spin/feature state detector for THIS game (overrides/augments the
   *  base when trusted — certified by the replay-gate's INV4 discrimination
   *  check on captured samples). */
  freeSpinSignal?: ParserOverlayAspect<FreeSpinSignal>;
  /** Post-parse nested extractions for THIS game (e.g. pull `fs~N` out of a
   *  delimited `trail` field). Applied only when trusted. */
  nestedExtractions?: ParserOverlayAspect<ProviderSpec["response"]["nestedExtractions"]>;
  /** Audit trail from the replay-gate that certified this overlay. */
  validation?: {
    validatedAt?: string;
    samplesReplayed?: number;
    reconciled?: number;
    invariants?: string[];
  };
};
