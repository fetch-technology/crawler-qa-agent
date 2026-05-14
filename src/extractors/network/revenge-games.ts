import type { HttpEntry } from "./http-jsonl.js";
import { type ApiSnapshot, emptyApiSnapshot } from "./types.js";

/**
 * Revenge Games parser.
 *
 * Endpoints:
 *   - GET  /{gameCode}/config?brandCode=...&gameCode=...   (api host) → betSizes, betLevels, config{symbols, baseBet, matrixDefault}
 *   - POST /client/player/authorize-game                              → balance, currency, playerState
 *   - GET  /api/v1/wallet/play?...                                    → balance, totalBet, totalWin
 *   - GET  /api/v2/balance?...                                        → balance, bonus, currency
 */

type GameConfigBody = {
  betSizes?: Array<{ value: number; default?: boolean }>;
  betLevels?: Array<{ value: number; default?: boolean }>;
  config?: {
    profile?: string;
    code?: string;
    baseBet?: number;
    symbols?: Array<{ id: number; code: string; type: string; name?: string }>;
    matrixDefault?: Array<{ symbol: number; value: number; type: number }>;
    paytable?: Record<string, number[]>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

type AuthorizeGameBody = {
  game?: string;
  playerNickname?: string;
  brandCode?: string;
  currency?: { code: string; name?: string; symbol?: string };
  balance?: number;
  bonus?: number;
  playerState?: {
    freeSpins?: number;
    engine?: string;
    lastBet?: {
      betAmount?: number;
      betSize?: number;
      betLevel?: number;
      baseBet?: number;
      currency?: string;
    };
  };
};

function tryParseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function findResponseByUrl(entries: HttpEntry[], pattern: RegExp): HttpEntry | null {
  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (e.status !== 200) continue;
    if (!e.body) continue;
    if (!pattern.test(e.url)) continue;
    return e;
  }
  return null;
}

export function isRevengeGamesEntry(entry: HttpEntry): boolean {
  return /revenge-games\.com/i.test(entry.url);
}

export function tryExtractRevengeGames(entries: HttpEntry[]): ApiSnapshot | null {
  // Game config (chứa bet sizes, symbols, matrix). Match rộng theo "{game}/config".
  const cfg = findResponseByUrl(entries, /\/[a-z0-9-]+\/config\?[^"]*brandCode=/i);
  const auth = findResponseByUrl(entries, /\/client\/player\/authorize-game(\?|$)/i);
  const wallet = findResponseByUrl(entries, /\/api\/v\d+\/wallet\/play\?/i);
  const balance = findResponseByUrl(entries, /\/api\/v\d+\/balance\?/i);

  if (!cfg && !auth) return null; // không có endpoint nào nhận diện được → giao cho AI

  const snap = emptyApiSnapshot("RG", "deterministic");

  let cfgBody: GameConfigBody | null = null;
  if (cfg) {
    snap.source_endpoints.push(cfg.url);
    cfgBody = tryParseJson<GameConfigBody>(cfg.body);
  }

  let authBody: AuthorizeGameBody | null = null;
  if (auth) {
    snap.source_endpoints.push(auth.url);
    authBody = tryParseJson<AuthorizeGameBody>(auth.body);
  }

  // Game code/name
  if (cfgBody?.config?.code) snap.game.code = cfgBody.config.code;
  if (authBody?.game) snap.game.code = snap.game.code ?? authBody.game;

  // Balance — prefer authorize-game vì có balance + currency. Fallback wallet/balance.
  if (authBody) {
    snap.balance = {
      cash: authBody.balance ?? null,
      bonus: authBody.bonus ?? null,
      currency: authBody.currency?.code ?? null,
    };
  } else if (balance) {
    const b = tryParseJson<{ balance: number; bonus: number; currency: string }>(balance.body);
    if (b) {
      snap.source_endpoints.push(balance.url);
      snap.balance = { cash: b.balance ?? null, bonus: b.bonus ?? null, currency: b.currency ?? null };
    }
  } else if (wallet) {
    const w = tryParseJson<{ balance: number; totalBet?: number; totalWin?: number }>(wallet.body);
    if (w) {
      snap.source_endpoints.push(wallet.url);
      snap.balance = { cash: w.balance ?? null, bonus: null, currency: null };
    }
  }

  // Bet config từ config endpoint
  if (cfgBody) {
    const coinValues = cfgBody.betSizes?.map((b) => b.value) ?? null;
    const betLevels = cfgBody.betLevels?.map((b) => b.value) ?? null;
    const defaultCoin = cfgBody.betSizes?.find((b) => b.default)?.value ?? null;
    const defaultLevel = cfgBody.betLevels?.find((b) => b.default)?.value ?? null;
    const baseBet = cfgBody.config?.baseBet ?? null;

    const lastBet = authBody?.playerState?.lastBet;
    const currentTotal = lastBet?.betAmount ?? null;

    snap.bet = {
      current: currentTotal,
      default:
        defaultCoin != null && defaultLevel != null && baseBet != null
          ? defaultCoin * defaultLevel * baseBet
          : (defaultCoin ?? null),
      coin_values: coinValues,
      bet_levels: betLevels,
      total_min:
        coinValues && betLevels && baseBet != null
          ? Math.min(...coinValues) * Math.min(...betLevels) * baseBet
          : null,
      total_max:
        coinValues && betLevels && baseBet != null
          ? Math.max(...coinValues) * Math.max(...betLevels) * baseBet
          : null,
      step_kind: "level_x_coin",
    };

    // Symbols
    if (cfgBody.config?.symbols) {
      snap.symbols = cfgBody.config.symbols.map((s) => ({
        id: s.id,
        code: s.code ?? null,
        name: s.name ?? null,
        type: s.type ?? null,
      }));
    }

    // Reels — RG dùng matrixDefault flat array, suy ra width/height nếu có thể
    if (cfgBody.config?.matrixDefault) {
      const len = cfgBody.config.matrixDefault.length;
      // Common shapes: 3×5=15, 4×5=20, 5×3=15, 6×5=30, 5×4=20. Default to flat.
      const guesses: Array<[number, number]> = [
        [5, 3],
        [5, 4],
        [3, 5],
        [4, 5],
        [6, 5],
        [5, 5],
      ];
      const match = guesses.find(([w, h]) => w * h === len) ?? null;
      snap.reels = {
        width: match?.[0] ?? null,
        height: match?.[1] ?? null,
        paylines_or_ways: null,
      };
    }

    // Paytable nếu config có
    if (cfgBody.config?.paytable) {
      snap.paytable = cfgBody.config.paytable;
    }
  }

  // ── session_state ──
  if (authBody?.playerState) {
    const ps = authBody.playerState;
    const lb = ps.lastBet ?? {};
    const fs = ps.freeSpins ?? null;
    const fsWin = (ps as { freeSpinsWinAmount?: number }).freeSpinsWinAmount ?? null;
    snap.session_state = {
      free_spins_remaining: fs,
      free_spins_total: null,
      free_spins_win_amount: fsWin,
      current_multiplier: null,
      in_feature: typeof fs === "number" && fs > 0,
      last_bet:
        Object.keys(lb).length > 0
          ? {
              amount: (lb as { betAmount?: number }).betAmount ?? null,
              coin_size: (lb as { betSize?: number }).betSize ?? null,
              level: (lb as { betLevel?: number }).betLevel ?? null,
              bet_type: (lb as { betType?: string }).betType ?? null,
              result_id: (lb as { id?: string }).id ?? null,
              win_amount: (lb as { earn?: number }).earn ?? null,
              ending_balance: (lb as { endingBalance?: number }).endingBalance ?? null,
            }
          : null,
      engine: ps.engine ?? null,
    };
  }

  // ── features ──
  // RG /config không có mechanics text — để paytable-features.ts AI fill.
  // Vẫn khởi tạo skeleton để consumer biết block tồn tại.
  snap.features = {
    free_spins: {
      available: snap.symbols?.some((s) => s.type === "SCATTER") ?? false,
      trigger: snap.symbols?.some((s) => s.type === "SCATTER")
        ? "Likely scatter-triggered (SC symbol present in config)"
        : null,
      spins_awarded: null,
      retrigger: null,
      multiplier_during: null,
      buy_in_available: snap.buy_feature?.available ?? null,
    },
    tumble: null,
    wild: snap.symbols?.some((s) => s.type === "WILD")
      ? { available: true, substitutes: null, multiplier_values: null, sticky: null, expanding: null }
      : { available: false, substitutes: null, multiplier_values: null, sticky: null, expanding: null },
    scatter: snap.symbols?.some((s) => s.type === "SCATTER")
      ? { available: true, min_count_to_pay: null, pays: null }
      : { available: false, min_count_to_pay: null, pays: null },
    bonus_round: null,
    multipliers: null,
    other_features: null,
  };

  // ui_options: từ /{game}/config (rc host) đôi khi có SHOW_GAME_RULE etc.
  // Tìm response từ rc host
  const rcCfg = findResponseByUrl(entries, /rc\.[^/]*revenge-games\.com\/[a-z0-9-]+\/[a-z0-9-]+\/config/i)
    ?? findResponseByUrl(entries, /\/[a-z0-9-]+\/config\?/i);
  if (rcCfg) {
    const rcBody = tryParseJson<Record<string, unknown>>(rcCfg.body);
    if (rcBody) {
      snap.ui_options = {
        autoplay: { available: true, presets: null, max_rounds: null, stop_on_any_win: null, stop_on_feature: null, stop_on_balance_increase: null, stop_on_balance_decrease: null, stop_on_single_win_gt: null },
        sound: { available: true, default_state: null, separate_music_fx: null },
        turbo_spin: { available: true, default_state: null },
        quick_spin: null,
        languages: typeof rcBody.language === "string" ? [rcBody.language as string] : null,
        fullscreen: { available: true },
        other_controls: rcBody.SHOW_GAME_RULE === false ? ["rules_button_hidden"] : null,
      };
      snap.raw.rc_config_keys = Object.keys(rcBody);
    }
  }

  // Raw debug
  snap.raw.config_body = cfgBody;
  snap.raw.authorize_keys = authBody ? Object.keys(authBody) : null;
  snap.raw.last_bet = authBody?.playerState?.lastBet ?? null;

  return snap;
}
