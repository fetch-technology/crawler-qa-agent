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
 *  separated by `|` are tried in order (e.g. "bb|balanceBefore"). */
export type FieldMap = {
  /** Wallet balance BEFORE bet was deducted. */
  balanceBefore?: string;
  /** Wallet balance AFTER spin completes (win credited). */
  balanceAfter: string;
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
    shapeScore: ShapeScoreConfig;
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
