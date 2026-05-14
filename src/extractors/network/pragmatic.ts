import type { HttpEntry } from "./http-jsonl.js";
import { type ApiSnapshot, emptyApiSnapshot } from "./types.js";

/**
 * Pragmatic Play parser.
 *
 * PP serves all canonical config qua POST `/gs2c/ge/v4/gameService` action=doInit.
 * Response là form-encoded text với một field `gameInfo={...}` là JS-object literal
 * (unquoted keys). Plus có vài endpoint phụ:
 *   - /gs2c/html5Game.do      → bootstrap html, có gname
 *   - /gs2c/reloadBalance.do  → balance refresh
 */

function parseFormEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      out[decodeURIComponent(part)] = "";
      continue;
    }
    const k = decodeURIComponent(part.slice(0, eq));
    const v = part.slice(eq + 1);
    // Pragmatic doesn't always URL-encode body values (especially gameInfo={...})
    // — keep raw, decode only when no '%' present + simple string
    if (v.includes("%")) {
      try {
        out[k] = decodeURIComponent(v);
        continue;
      } catch {
        // fall through to raw
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * Parse JS-object literal style với unquoted keys (như `{rtps:{a:"1",b:"2"}}`).
 * Đủ dùng cho 2-tầng nested keys + primitive string values như Pragmatic dùng.
 */
function parseJsLiteralShallow(src: string): Record<string, unknown> | null {
  const trimmed = src.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    // Quote tất cả unquoted keys: `{key:` hoặc `,key:` → `{"key":` / `,"key":`
    const quoted = trimmed.replace(/([{,])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
    return JSON.parse(quoted) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toNumber(s: string | undefined | null): number | null {
  if (s == null) return null;
  // PP uses "100,000.00" — strip thousands separators, keep decimal dot.
  const cleaned = s.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseCsvNumbers(s: string | undefined): number[] | null {
  if (!s) return null;
  const arr = s.split(",").map((x) => toNumber(x)).filter((n): n is number => n != null);
  return arr.length ? arr : null;
}

/**
 * `wl_i=tbm~25000;tbm_a1~10000;tbm_a2~2084;tbm_a3~1250;tbm_a4~100`
 * → { tbm: 25000, tbm_a1: 10000, ... }
 */
function parseWinLimits(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const seg of s.split(";")) {
    const [k, v] = seg.split("~");
    const n = toNumber(v);
    if (k && n != null) out[k.trim()] = n;
  }
  return out;
}

/** Parse `paytable=row1;row2;row3` where each row = "v1,v2,...,vN". */
function parsePaytable(s: string | undefined): Record<string, number[]> | null {
  if (!s) return null;
  const out: Record<string, number[]> = {};
  const rows = s.split(";");
  rows.forEach((row, idx) => {
    const cells = row.split(",").map((x) => toNumber(x)).filter((n): n is number => n != null);
    out[`sym_${idx}`] = cells;
  });
  return Object.keys(out).length ? out : null;
}

export function isPragmaticEntry(entry: HttpEntry): boolean {
  return /pragmaticplay\.net/i.test(entry.url);
}

/** Trả về key gameService doInit response (đã có body). Có thể nhiều — pick lần đầu success. */
function findDoInitResponse(entries: HttpEntry[]): HttpEntry | null {
  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (!/\/gs2c\/ge\/v\d+\/gameService(\?|$)/i.test(e.url)) continue;
    if (e.status !== 200) continue;
    if (!e.body) continue;
    // doInit response chứa "balance=" và "gameInfo="
    if (e.body.includes("gameInfo=") && e.body.includes("balance=")) return e;
  }
  return null;
}

function findHtml5GameRequest(entries: HttpEntry[]): HttpEntry | null {
  for (const e of entries) {
    if (e.phase !== "request") continue;
    if (!/\/gs2c\/html5Game\.do/i.test(e.url)) continue;
    return e;
  }
  return null;
}

export function tryExtractPragmatic(entries: HttpEntry[]): ApiSnapshot | null {
  const doInit = findDoInitResponse(entries);
  if (!doInit || !doInit.body) return null;

  const snap = emptyApiSnapshot("PP", "deterministic");
  snap.source_endpoints.push(doInit.url);

  const fields = parseFormEncoded(doInit.body);

  // Game code/name
  const symbolMatch = doInit.url.match(/[?&]symbol=([^&]+)/i);
  if (symbolMatch) snap.game.code = decodeURIComponent(symbolMatch[1]!);
  const html5Game = findHtml5GameRequest(entries);
  if (html5Game) {
    const m = html5Game.url.match(/[?&]gname=([^&]+)/i);
    if (m) snap.game.name = decodeURIComponent(m[1]!).replace(/\+/g, " ");
    if (!snap.game.code) {
      const m2 = html5Game.url.match(/[?&]symbol=([^&]+)/i);
      if (m2) snap.game.code = decodeURIComponent(m2[1]!);
    }
  }

  // Balance
  const cash = toNumber(fields.balance_cash) ?? toNumber(fields.balance);
  const bonus = toNumber(fields.balance_bonus);
  if (cash != null || bonus != null) {
    snap.balance = { cash, bonus, currency: null };
    // currency có thể trong url query "cur=USD" hoặc html5Game request — bỏ qua nếu null
    const curMatch =
      (html5Game?.url.match(/[?&](?:cur|currency|currencyOriginal)=([A-Z]{3})/i) ??
        doInit.url.match(/[?&](?:cur|currency)=([A-Z]{3})/i));
    if (curMatch) snap.balance.currency = curMatch[1]!.toUpperCase();
  }

  // Bet config
  const coins = parseCsvNumbers(fields.sc);
  const levels = parseCsvNumbers(fields.bls);
  const currentCoin = toNumber(fields.c);
  const defaultCoin = toNumber(fields.defc);
  const totalMax = toNumber(fields.total_bet_max);
  const lines = toNumber(fields.l);
  const currentLevel = toNumber(fields.bl);  // current bet level idx
  // Total current bet ≈ coin × selectedLevelMultiplier × lines. PP doesn't expose
  // computed total directly; approximate as coin × lines if we can.
  const currentTotal =
    currentCoin != null && lines != null
      ? currentCoin * lines * (currentLevel != null && levels?.[currentLevel] ? levels[currentLevel]! : 1)
      : null;
  snap.bet = {
    current: currentTotal,
    default: defaultCoin,
    coin_values: coins,
    bet_levels: levels,
    total_min:
      coins && lines ? coins[0]! * lines * (levels?.[0] ?? 1) : null,
    total_max: totalMax,
    step_kind: coins && coins.length > 0 ? "discrete_chips" : "level_x_coin",
  };

  // gameInfo: rtps + props
  let gameInfo: Record<string, unknown> | null = null;
  if (fields.gameInfo) {
    gameInfo = parseJsLiteralShallow(fields.gameInfo);
  }
  const winLimits = parseWinLimits(fields.wl_i);

  if (gameInfo) {
    const rtps = (gameInfo.rtps as Record<string, string> | undefined) ?? {};
    const props = (gameInfo.props as Record<string, string> | undefined) ?? {};
    const regular = toNumber(rtps.regular);
    const ante: Array<{ id: string; rtp: number; max_win_x: number | null }> = [];
    const purchase: Array<{ id: string; rtp: number; max_win_x: number | null }> = [];
    for (const [k, v] of Object.entries(rtps)) {
      const rtpNum = toNumber(v as string);
      if (rtpNum == null) continue;
      if (k === "regular") continue;
      if (k.startsWith("ante_")) {
        const suffix = k.replace(/^ante_/, "");
        const maxWinKey = `max_rnd_win_${suffix}`;
        const maxWinFromProps = toNumber(props[maxWinKey]);
        const maxWinFromWl = winLimits[`tbm_${suffix}`] ?? null;
        ante.push({ id: k, rtp: rtpNum, max_win_x: maxWinFromProps ?? maxWinFromWl });
      } else if (k.startsWith("purchase_")) {
        // purchase doesn't have direct max_win in props (uses default tbm)
        purchase.push({ id: k, rtp: rtpNum, max_win_x: winLimits.tbm ?? null });
      }
    }
    snap.rtp = {
      regular,
      ante: ante.length ? ante : null,
      purchase: purchase.length ? purchase : null,
    };
    snap.max_win_x = toNumber(props.max_rnd_win) ?? winLimits.tbm ?? null;

    // Buy feature tiers
    if (purchase.length > 0) {
      snap.buy_feature = {
        available: true,
        tiers: purchase.map((p) => ({
          id: p.id,
          label: null,
          rtp: p.rtp,
          max_win_x: p.max_win_x,
          price_multiplier: null,    // PP exposes per-tier price separately (not in doInit) — null for now
          price_absolute: null,
        })),
      };
    }
    // Special bets (ante)
    if (ante.length > 0) {
      snap.special_bets = {
        available: true,
        variants: ante.map((a) => ({
          id: a.id,
          label: null,
          rtp: a.rtp,
          max_win_x: a.max_win_x,
          cost_multiplier: null,
        })),
      };
    }
  }

  // Reels / paylines
  const sw = toNumber(fields.sw);
  const sh = toNumber(fields.sh);
  if (sw != null || sh != null || lines != null) {
    snap.reels = {
      width: sw,
      height: sh,
      paylines_or_ways: lines,
    };
  }

  // Paytable
  snap.paytable = parsePaytable(fields.paytable);

  // Reel sets count: count keys reel_setN
  const reelSetKeys = Object.keys(fields).filter((k) => /^reel_set\d+$/.test(k));
  snap.reel_sets_count = reelSetKeys.length || null;

  // ── session_state ──
  // PP doInit: bonuses=0 ⇒ không có FS/bonus đang chạy. ntp = total accumulated win.
  const bonusesRaw = fields.bonuses ?? "0";
  const inFeature = bonusesRaw !== "0" && bonusesRaw !== "";
  const ntp = toNumber(fields.ntp);
  snap.session_state = {
    free_spins_remaining: inFeature ? null : 0,
    free_spins_total: null,
    free_spins_win_amount: ntp ?? null,
    current_multiplier: null,
    in_feature: inFeature,
    last_bet:
      currentTotal != null
        ? {
            amount: currentTotal,
            coin_size: currentCoin,
            level: currentLevel,
            bet_type: fields.rt === "d" ? "DEMO_NORMAL" : (fields.rt ?? null),
            result_id: null,
            win_amount: ntp ?? null,
            ending_balance: cash ?? null,
          }
        : null,
    engine: fields.rt ?? null,
  };

  // ── features (rule-mechanics) ──
  // PP doInit không expose mechanics text. Suy vài thứ chắc chắn từ structure:
  //   - tumble: mọi game cluster-pays (PP "rect" stype với scatter pays anywhere)
  //   - wild: nhìn paytable row index 0/1 (WD/SC convention) — không chắc, để null
  //   - free_spins.buy_in_available = purchase tiers tồn tại
  // Phần còn lại để paytable-features.ts AI fill từ rules text.
  const isClusterPays = fields.st === "rect" && (fields.na === "s" || fields.na?.toLowerCase().includes("scatter"));
  snap.features = {
    free_spins: {
      available: snap.buy_feature?.available ?? false,   // gián tiếp: có buy = có FS
      trigger: null,
      spins_awarded: null,
      retrigger: null,
      multiplier_during: null,
      buy_in_available: snap.buy_feature?.available ?? null,
    },
    tumble: isClusterPays
      ? { available: true, max_multiplier: null, description: "Cluster/scatter pays anywhere on the screen" }
      : { available: false, max_multiplier: null, description: null },
    wild: null,
    scatter: null,
    bonus_round: snap.buy_feature?.available
      ? { available: true, type: "free_spins", description: "Buy Feature triggers free spin round" }
      : null,
    multipliers: null,
    other_features: null,
  };

  // ui_options không có ở doInit — để null, derive từ vision sau.
  snap.ui_options = null;

  // Raw debug
  snap.raw = {
    doInit_keys: Object.keys(fields),
    gameInfo,
    win_limits: winLimits,
    purInit_e: fields.purInit_e ?? null,
    bonuses: bonusesRaw,
    rt: fields.rt ?? null,
    ver: fields.ver ?? null,
    na: fields.na ?? null,
    st: fields.st ?? null,
    ntp,
  };

  return snap;
}
