/**
 * GameAdapter — abstraction layer that decouples per-game/per-provider logic
 * from the deterministic runtime, statistical simulator, and runner.
 *
 * Composition model (see docs/ai_powered_slot_game_testing.md §9):
 *   GameAdapter = ProviderAdapter (wire format)
 *               × MechanicAdapter (math)
 *               × GameSpec        (paytable / symbols / invariants)
 *
 * Callers should NOT instantiate adapters directly — go through
 * `resolveAdapter()` from `./registry.js`, which composes the right
 * provider + mechanic pair for a given slug.
 */

import type { GameSpec } from "../ai/authoring.js";

/** A parsed spin REQUEST sent from client to game server. */
export type SpinRequest = {
  /** Total bet for this spin (coin × lines, or stake). */
  bet: number;
  /** Per-line coin value (PP `c`, RG `coin`). May be null when game uses flat stake. */
  coin: number | null;
  /** Bet level / line count multiplier (PP `bl`, RG `level`). */
  level: number | null;
  /** Number of paylines / ways enabled for this spin. */
  lines: number | null;
  /** Optional bet type tag (vd "freeBuy", "normal"). */
  betType?: string;
  /** Raw parsed body (URL params or JSON object). */
  raw: Record<string, unknown>;
};

/** A parsed spin RESPONSE from game server. */
export type SpinResponse = {
  /** Total bet (echoed by server, may differ from request when free-spin). */
  bet: number;
  /** Total win for this spin (sum of cascade frames if cascade). */
  win: number;
  /** Player balance BEFORE this spin (if server includes; else null). */
  balanceBefore: number | null;
  /** Player balance AFTER this spin. */
  balanceAfter: number;
  /**
   * Reels matrix. For cascade games, this is the INITIAL drop; per-cascade
   * frames live in `cascadeFrames`.
   * Shape: reels[reelIndex][rowIndex] = symbol code.
   */
  reels: string[][];
  /** Reel width × height (echoed from server). */
  width: number;
  height: number;
  /** Round / spin id from server, if present. */
  roundId: string | null;
  /** True nếu spin này là free-spin (no bet deducted). */
  isFreeSpin: boolean;
  /** True nếu spin trigger bonus / free-spin award. */
  hasBonus: boolean;
  /** Number of free spins remaining (or won) after this response. */
  freeSpinsRemaining: number | null;
  /** Per-cascade reel frames for tumble games. Empty array if no cascade. */
  cascadeFrames: string[][][];
  /** Raw parsed body. */
  raw: Record<string, unknown>;
};

/** Input passed to `GameAdapter.validateSpin()`. */
export type SpinValidationInput = {
  request: SpinRequest;
  response: SpinResponse;
  spec: GameSpec;
  /** Numeric tolerance for float comparisons. Default 0.01. */
  tolerance?: number;
};

/** Single validation issue. Multiple may be returned for one spin. */
export type ValidationError = {
  code:
    | "PAYOUT_MISMATCH"
    | "BALANCE_MISMATCH"
    | "REELS_DECODE"
    | "BET_INVALID"
    | "INCONCLUSIVE";
  severity: "error" | "warn" | "info";
  detail: string;
  data?: unknown;
};

/** Test case skeleton emitted by `GameAdapter.generateTestCases()`. */
export type TestCase = {
  id: string;
  title: string;
  scenarioLabel: string;
  invariants: string[];
};

/** Route-mock filter input passed by deterministic.ts. */
export type RouteRequestSnapshot = {
  url: string;
  method: string;
  postData: string | null;
};

/**
 * The unified game-facing facade. Composed by `composeGameAdapter()` from a
 * `ProviderAdapter` + `MechanicAdapter` + `GameSpec`. Most callers only need
 * this interface.
 */
export interface GameAdapter {
  /** Stable identifier (slug). */
  gameCode: string;
  /** Provider code (PP / RG / GENERIC). */
  providerCode: string;
  /** Mechanic code (ways / paylines / cluster). */
  mechanicCode: string;

  /** True nếu raw URL+body trông giống spin REQUEST. */
  detectSpinRequest(raw: string, url?: string): boolean;
  /** True nếu raw URL+body trông giống spin RESPONSE. */
  detectSpinResponse(raw: string, url?: string): boolean;

  /** Parse raw body → SpinRequest. Throws if parse fails. */
  parseRequest(raw: string): SpinRequest;
  /** Parse raw body → SpinResponse. Throws if parse fails. */
  parseResponse(raw: string): SpinResponse;

  /** Decode reels from provider-specific symbol string. */
  decodeReels(symbols: string, width: number, height: number): string[][];

  /** Run all checks (payout, balance, reels). Returns empty array if OK. */
  validateSpin(input: SpinValidationInput): ValidationError[];

  /** Suggest test cases the harness should run for this game. */
  generateTestCases(): TestCase[];

  /**
   * Optional Playwright route-filter hook. Return:
   *   - true  → mock route normally
   *   - false → adapter wants to mock but conditionally (caller respects)
   *   - undefined → adapter has no opinion (caller default behaviour)
   * Provider-specific quirks live here (vd PP gs2c init/spin shared endpoint).
   */
  shouldMockRoute?(req: RouteRequestSnapshot): boolean | undefined;
}

/** Provider-axis adapter — wire format only, no math. */
export interface ProviderAdapter {
  providerCode: "PP" | "RG" | "GENERIC";
  /** Broad URL regex that may contain spin endpoint. */
  urlPattern: RegExp;
  /** True nếu URL nên bị skip (vd savesettings, stats, openGame). */
  skipUrl(url: string): boolean;
  /** Parse raw body (URL-encoded or JSON). */
  parseBody(raw: string): Record<string, unknown> | null;
  /** Score parsed body's spin-shape. */
  scoreSpinShape(parsed: Record<string, unknown>): {
    score: number;
    reasons: string[];
  };
  /** Convert parsed body → normalized SpinRequest. */
  parseRequest(parsed: Record<string, unknown>): SpinRequest;
  /** Convert parsed body → normalized SpinResponse. */
  parseResponse(parsed: Record<string, unknown>): SpinResponse;
  /** Optional route-mock filter (vd PP gs2c). */
  shouldMockRoute?(req: RouteRequestSnapshot): boolean | undefined;
}

/** Mechanic-specific context passed to `calculateWin`. */
export type MechanicContext = {
  coin: number;
  wildMultiplier: number;
  /** For paylines mechanic: each line is row indices (length = reel count). */
  paylines?: number[][];
  /** For cluster mechanic: min cluster size that pays (default 5). */
  minClusterSize?: number;
};

/** Mechanic-axis adapter — math only, no wire format. */
export interface MechanicAdapter {
  mechanicCode: "ways" | "paylines" | "cluster";
  /** Decode raw symbol string → matrix. */
  decodeReels(symbols: string, width: number, height: number): string[][];
  /** Calculate total win for a single frame. */
  calculateWin(
    reels: string[][],
    spec: GameSpec,
    ctx: MechanicContext,
  ): {
    total: number;
    combos: Array<{
      symbol: string;
      count: number;
      multiplier: number;
      ways?: number;
      paylineIndex?: number;
      cluster?: Array<{ reel: number; row: number }>;
      contribution: number;
    }>;
  };
}
