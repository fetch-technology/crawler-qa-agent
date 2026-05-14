/**
 * ApiSnapshot — provider-agnostic structured data extracted từ network traffic.
 * Mỗi provider parser (deterministic hoặc AI-driven) trả về cùng shape này.
 * Field nào provider không expose → null.
 */
export type ApiSnapshot = {
  capturedAt: string;
  provider: string;                  // "PP" | "RG" | "AI:<name>" cho AI fallback
  source_endpoints: string[];        // URLs mà extractor đã đọc
  extractor_kind: "deterministic" | "ai_generic";

  game: {
    code: string | null;             // game code/symbol từ API
    name: string | null;             // display name nếu có
  };

  balance: {
    cash: number | null;
    bonus: number | null;
    currency: string | null;
  } | null;

  bet: {
    current: number | null;          // current total bet (= coin × level × lines hoặc raw)
    default: number | null;
    coin_values: number[] | null;    // ladder các giá trị chip/coin
    bet_levels: number[] | null;     // multiplier levels (nếu khác coin)
    total_min: number | null;
    total_max: number | null;
    step_kind: "discrete_chips" | "level_x_coin" | "plus_minus" | "unknown";
  } | null;

  rtp: {
    regular: number | null;
    ante: Array<{ id: string; rtp: number; max_win_x: number | null }> | null;
    purchase: Array<{ id: string; rtp: number; max_win_x: number | null }> | null;
  } | null;

  max_win_x: number | null;          // overall max win multiplier (e.g. 25000)

  buy_feature: {
    available: boolean;
    tiers: Array<{
      id: string;                    // canonical id từ API (e.g. "purchase_0")
      label: string | null;          // human label nếu có
      rtp: number | null;
      max_win_x: number | null;
      price_multiplier: number | null;   // x current bet
      price_absolute: number | null;
    }> | null;
  } | null;

  special_bets: {                    // ante / double chance / bet boost
    available: boolean;
    variants: Array<{
      id: string;                    // e.g. "ante_a1"
      label: string | null;
      rtp: number | null;
      max_win_x: number | null;
      cost_multiplier: number | null;
    }> | null;
  } | null;

  reels: {
    width: number | null;
    height: number | null;
    paylines_or_ways: number | string | null;   // 20 / "243 ways" / "cluster"
  } | null;

  symbols: Array<{
    id: number | string;
    code: string | null;
    name: string | null;
    type: string | null;             // "WILD" | "SCATTER" | "PICTURE_SYMBOL" | …
  }> | null;

  paytable: Record<string, number[]> | null;   // symbol_id → multipliers per match count

  reel_sets_count: number | null;

  /**
   * RULE-level mechanics (cluster size, scatter rules, free-spin trigger, wild/tumble…).
   * Phần lớn không có ở API — được suy ra từ paytable text (xem paytable-features.ts).
   */
  features: {
    free_spins: {
      available: boolean;
      trigger: string | null;             // "3+ SC", "Scatter on reels 1,3,5"
      spins_awarded: number | null;
      retrigger: string | null;           // "Each 3+ SC during FS adds 5"
      multiplier_during: string | null;   // "Tumble multiplier x2 → x100 sticky"
      buy_in_available: boolean | null;
    } | null;
    tumble: {                             // cascade / avalanche / chain reaction
      available: boolean;
      max_multiplier: number | string | null;
      description: string | null;
    } | null;
    wild: {
      available: boolean;
      substitutes: string | null;         // "all symbols except scatter"
      multiplier_values: number[] | null; // for multiplier-wild games like Sweet Bonanza
      sticky: boolean | null;
      expanding: boolean | null;
    } | null;
    scatter: {
      available: boolean;
      min_count_to_pay: number | null;
      pays: string | null;                // "x3 to x100"
    } | null;
    bonus_round: {
      available: boolean;
      type: string | null;                // "free_spins", "pick", "wheel", "hold_and_win"
      description: string | null;
    } | null;
    multipliers: {
      base_game: string | null;
      free_game: string | null;
      values: number[] | null;
    } | null;
    other_features: string[] | null;       // tự do: "Megaways", "Cluster pays", "Hold & Spin"
  } | null;

  /**
   * Realtime session state — đọc từ API (PP `bonuses`/`fs`, RG `playerState`).
   * Cập nhật mỗi lần spin để verify hoặc dùng làm startup state.
   */
  session_state: {
    free_spins_remaining: number | null;
    free_spins_total: number | null;       // out of N (e.g. 5/10)
    free_spins_win_amount: number | null;  // cumulative win during current FS session
    current_multiplier: number | string | null;
    in_feature: boolean | null;            // true if free spin/bonus đang chạy
    last_bet: {
      amount: number | null;
      coin_size: number | null;
      level: number | null;
      bet_type: string | null;             // "NORMAL" | "ANTE" | "PURCHASE_0" …
      result_id: string | null;
      win_amount: number | null;
      ending_balance: number | null;
    } | null;
    engine: string | null;                 // RG: "A", PP: rt or rt_a1 etc.
  } | null;

  /**
   * UI-only options — không có ở response API thuần. Source: HTML embed của
   * launcher (PP html5Game.do), client config files, hoặc derive từ vision.
   */
  ui_options: {
    autoplay: {
      available: boolean;
      presets: number[] | null;            // [10, 25, 50, 100, 1000]
      max_rounds: number | null;
      stop_on_any_win: boolean | null;
      stop_on_feature: boolean | null;
      stop_on_balance_increase: boolean | null;
      stop_on_balance_decrease: boolean | null;
      stop_on_single_win_gt: number | null;
    } | null;
    sound: {
      available: boolean;
      default_state: "on" | "off" | null;
      separate_music_fx: boolean | null;
    } | null;
    turbo_spin: { available: boolean; default_state: "on" | "off" | null } | null;
    quick_spin: { available: boolean; default_state: "on" | "off" | null } | null;
    languages: string[] | null;
    fullscreen: { available: boolean } | null;
    other_controls: string[] | null;       // controls vision thấy nhưng chưa map
  } | null;

  raw: Record<string, unknown>;      // raw fragments giữ lại cho debug/audit
};

export function emptyApiSnapshot(provider: string, kind: ApiSnapshot["extractor_kind"]): ApiSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    provider,
    source_endpoints: [],
    extractor_kind: kind,
    game: { code: null, name: null },
    balance: null,
    bet: null,
    rtp: null,
    max_win_x: null,
    buy_feature: null,
    special_bets: null,
    reels: null,
    symbols: null,
    paytable: null,
    reel_sets_count: null,
    features: null,
    session_state: null,
    ui_options: null,
    raw: {},
  };
}
