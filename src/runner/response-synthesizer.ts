/**
 * Response synthesizer — modify spin response body để test custom outcomes
 * không cần re-record.
 *
 * Approach: lấy 1 response thật làm template → đổi các field cần đổi → giữ
 * nguyên phần còn lại (matrix, winlines, cascade structure). Game client
 * trust server, không re-compute math → hiển thị theo response.
 *
 * Hỗ trợ 2 format:
 *   - URL-encoded (PP gs2c): c=0.2&tw=2.4&balance=...
 *   - JSON (RG, PG, NetEnt): {"betAmount": 0.2, "winAmount": 2.4, ...}
 *
 * Phase 1: single-spin override (bet, win, balance, isFreeSpin)
 * Phase 2: multi-response chain (cascade, free spin chain)
 */

export type SpinOverrides = {
  /** Total bet amount (USD). Tự động compute coin từ level hiện tại. */
  bet?: number;
  /** Total win amount. Tự động sync `rs_iw`, `rs_win` cho PP cascade. */
  win?: number;
  /** Starting balance trước spin. */
  startingBalance?: number;
  /** Ending balance sau spin. Nếu không set + bet/win đã set → tự compute. */
  endingBalance?: number;
  /** Set free spin mode (PP: reel_set=1, JSON: isFreeSpin=true). */
  isFreeSpin?: boolean;
  /** Set winFreeSpins (PP cascade) hoặc bonusTriggered flag. */
  hasBonusTrigger?: boolean;
  /** Free spin count for bonus trigger (default 10). */
  freeSpinCount?: number;
};

export type ResponseFormat = "url-encoded" | "json";

export function detectFormat(body: string): ResponseFormat {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/^[\w._-]+=/.test(trimmed)) return "url-encoded";
  return "url-encoded"; // default fallback (PP-style)
}

/**
 * Main entry: synthesize body với overrides. Trả về string mới.
 */
export function synthesizeBody(originalBody: string, overrides: SpinOverrides): string {
  const format = detectFormat(originalBody);
  if (format === "json") {
    return synthesizeJson(originalBody, overrides);
  }
  return synthesizeUrlEncoded(originalBody, overrides);
}

// ===== URL-encoded format (PP gs2c) =====

function synthesizeUrlEncoded(body: string, ov: SpinOverrides): string {
  const params = new URLSearchParams(body);

  // Compute auto-balance nếu có bet+win nhưng không có endingBalance
  let computedEnding: number | undefined;
  if (ov.endingBalance == null && ov.startingBalance != null && ov.bet != null && ov.win != null) {
    computedEnding = ov.startingBalance - ov.bet + ov.win;
  } else if (ov.endingBalance == null && ov.bet != null && ov.win != null) {
    // Use current balance as starting reference
    const currentBalance = Number(params.get("balance") ?? params.get("balance_cash") ?? 0);
    computedEnding = currentBalance - ov.bet + ov.win;
  }

  // BET: PP dùng `c` (coin) × `l` (level)
  if (ov.bet != null) {
    const currentLevel = Number(params.get("l") || params.get("bl") || "25");
    const level = currentLevel > 0 ? currentLevel : 25;
    const coin = ov.bet / level;
    params.set("c", coin.toFixed(4));
    // Nếu game có totalBet field
    if (params.has("totalBet")) params.set("totalBet", ov.bet.toFixed(2));
  }

  // WIN: PP có nhiều win field — sync tất cả
  if (ov.win != null) {
    params.set("tw", ov.win.toFixed(2));
    if (params.has("rs_iw")) params.set("rs_iw", ov.win.toFixed(2));
    if (params.has("rs_win")) params.set("rs_win", "0.00"); // cumulative trước cascade này = 0
    if (params.has("w")) params.set("w", ov.win.toFixed(2));
  }

  // STARTING BALANCE: PP thường không có field riêng, dùng balance cũ
  // (caller có thể set nếu cần)

  // ENDING BALANCE: sync balance, balance_cash
  const finalEnding = ov.endingBalance ?? computedEnding;
  if (finalEnding != null) {
    params.set("balance", finalEnding.toFixed(2));
    if (params.has("balance_cash")) params.set("balance_cash", finalEnding.toFixed(2));
  }

  // FREE SPIN flag: PP dùng reel_set=1 cho free spin
  if (ov.isFreeSpin === true) {
    params.set("reel_set", "1");
    // PP free spin: bet thường = 0
    if (ov.bet == null) {
      params.set("c", "0");
    }
  } else if (ov.isFreeSpin === false) {
    params.set("reel_set", "0");
  }

  // BONUS TRIGGER: set winFreeSpins / fs_won
  if (ov.hasBonusTrigger === true) {
    const fsCount = ov.freeSpinCount ?? 10;
    params.set("fs_won", String(fsCount));
    if (params.has("winFreeSpins")) params.set("winFreeSpins", String(fsCount));
  }

  return params.toString();
}

// ===== JSON format (RG, PG, NetEnt) =====

function synthesizeJson(body: string, ov: SpinOverrides): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body);
  } catch {
    return body; // unparseable → return as-is
  }

  // Compute auto-balance
  let computedEnding: number | undefined;
  if (ov.endingBalance == null && ov.startingBalance != null && ov.bet != null && ov.win != null) {
    computedEnding = ov.startingBalance - ov.bet + ov.win;
  }

  // BET
  if (ov.bet != null) {
    obj.betAmount = ov.bet;
    if ("totalBet" in obj) obj.totalBet = ov.bet;
  }

  // WIN
  if (ov.win != null) {
    obj.winAmount = ov.win;
    if (obj.result && typeof obj.result === "object") {
      (obj.result as Record<string, unknown>).totalWinAmount = ov.win;
    }
  }

  // STARTING BALANCE
  if (ov.startingBalance != null) {
    obj.startingBalance = ov.startingBalance;
  }

  // ENDING BALANCE
  const finalEnding = ov.endingBalance ?? computedEnding;
  if (finalEnding != null) {
    obj.endingBalance = finalEnding;
    if ("updatedBalance" in obj) obj.updatedBalance = finalEnding;
    if ("balance" in obj) obj.balance = finalEnding;
  }

  // FREE SPIN
  if (ov.isFreeSpin != null) {
    obj.isFreeSpin = ov.isFreeSpin;
    if (ov.isFreeSpin && ov.bet == null) {
      obj.betAmount = 0;
    }
  }

  // BONUS TRIGGER
  if (ov.hasBonusTrigger != null) {
    const fsCount = ov.freeSpinCount ?? 10;
    obj.winFreeSpins = ov.hasBonusTrigger ? fsCount : 0;
    if ("freeSpins" in obj) obj.freeSpins = ov.hasBonusTrigger ? fsCount : 0;
  }

  return JSON.stringify(obj);
}

// ===== Phase 2: Multi-response chains =====

/**
 * Synthesize cascade chain — generate N responses cho 1 UI spin cascade.
 *
 * Game tumble flow: spin → win → tumble → check win → ... lặp N lần → end.
 * Mỗi tumble = 1 response với rs_c tăng dần, rs_more=1 trừ response cuối.
 *
 * @param template Body của 1 response thật (làm khuôn)
 * @param cascadeWins Array of win amount per cascade step
 *                   Ví dụ [0.5, 1.2, 2.0] = 3 cascade với win 0.5, 1.2, 2.0
 *                   Tổng win = 3.7. Response cuối có rs_more=0, isEndRound=true.
 * @param bet Total bet (cho balance compute)
 * @param startingBalance Balance trước cascade chain
 */
export function synthesizeCascadeChain(
  template: string,
  cascadeWins: number[],
  bet: number,
  startingBalance: number,
): string[] {
  if (cascadeWins.length === 0) return [];
  const format = detectFormat(template);
  const totalWin = cascadeWins.reduce((a, b) => a + b, 0);
  const endingBalance = startingBalance - bet + totalWin;
  const responses: string[] = [];

  for (let i = 0; i < cascadeWins.length; i++) {
    const isLast = i === cascadeWins.length - 1;
    const stepWin = cascadeWins[i]!;
    const cumulativeWin = cascadeWins.slice(0, i + 1).reduce((a, b) => a + b, 0);

    if (format === "url-encoded") {
      const params = new URLSearchParams(template);
      params.set("rs_c", String(i));
      params.set("rs_iw", stepWin.toFixed(2));
      params.set("rs_win", cumulativeWin.toFixed(2));
      params.set("rs_more", isLast ? "0" : "1");
      params.set("tw", totalWin.toFixed(2));
      params.set("c", (bet / Number(params.get("l") || "25")).toFixed(4));
      // Balance: chỉ update ở response cuối (server commit khi round end)
      if (isLast) {
        params.set("balance", endingBalance.toFixed(2));
        if (params.has("balance_cash")) params.set("balance_cash", endingBalance.toFixed(2));
        if (params.has("isEndRound")) params.set("isEndRound", "true");
      }
      responses.push(params.toString());
    } else {
      // JSON format (cascade trong RG/PG ít phổ biến hơn — best-effort)
      const obj = JSON.parse(template) as Record<string, unknown>;
      obj.betAmount = bet;
      obj.winAmount = isLast ? totalWin : cumulativeWin;
      if (isLast) {
        obj.endingBalance = endingBalance;
        obj.isEndRound = true;
      } else {
        obj.isEndRound = false;
      }
      responses.push(JSON.stringify(obj));
    }
  }

  return responses;
}

/**
 * Synthesize free spin chain — generate N responses cho free spin rounds.
 *
 * Player trigger free spins (vd 10 spin) → game tự spin N lần → mỗi spin
 * KHÔNG trừ bet (bet=0) nhưng giữ win.
 *
 * Optionally include a TRIGGER response trước (response cuối base game)
 * với cờ bonus.
 *
 * @param template Body của 1 spin thật làm khuôn
 * @param freeSpinWins Array of win per free spin
 *                    Vd [0, 5, 0, 12, 50] = 5 free spin với win lần lượt
 * @param baseBet Bet thật trước khi vào free spin (dùng cho display)
 * @param startingBalance Balance khi bắt đầu free spin chain
 * @param multipliers Optional: Wild multiplier accumulate per spin
 */
export function synthesizeFreeSpinChain(
  template: string,
  freeSpinWins: number[],
  baseBet: number,
  startingBalance: number,
  multipliers?: number[],
): string[] {
  if (freeSpinWins.length === 0) return [];
  const format = detectFormat(template);
  const responses: string[] = [];
  let currentBalance = startingBalance;
  let cumulativeMul = 0;

  for (let i = 0; i < freeSpinWins.length; i++) {
    const win = freeSpinWins[i]!;
    const mul = multipliers?.[i] ?? 0;
    cumulativeMul += mul;
    currentBalance += win; // Free spin: chỉ cộng win, không trừ bet

    if (format === "url-encoded") {
      const params = new URLSearchParams(template);
      params.set("reel_set", "1"); // free spin reel set
      params.set("c", "0"); // bet=0 trong free spin
      params.set("tw", win.toFixed(2));
      if (params.has("rs_iw")) params.set("rs_iw", win.toFixed(2));
      params.set("balance", currentBalance.toFixed(2));
      if (params.has("balance_cash")) params.set("balance_cash", currentBalance.toFixed(2));
      // Free spin chain remaining
      params.set("fs_left", String(freeSpinWins.length - i - 1));
      params.set("fs_total", String(freeSpinWins.length));
      if (cumulativeMul > 0) params.set("total_mul", String(cumulativeMul));
      // Last response = end of free spin chain
      if (i === freeSpinWins.length - 1) {
        params.set("isEndRound", "true");
        params.set("rs_more", "0");
      }
      responses.push(params.toString());
    } else {
      const obj = JSON.parse(template) as Record<string, unknown>;
      obj.betAmount = 0;
      obj.winAmount = win;
      obj.isFreeSpin = true;
      obj.endingBalance = currentBalance;
      if ("freeSpinsLeft" in obj) obj.freeSpinsLeft = freeSpinWins.length - i - 1;
      if (i === freeSpinWins.length - 1) obj.isEndRound = true;
      responses.push(JSON.stringify(obj));
    }
  }

  return responses;
}

/**
 * Synthesize 1 response trigger bonus (response cuối base game trước khi vào FS).
 *
 * @param template Body thật làm khuôn
 * @param bet Bet của spin trigger
 * @param triggerWin Win của spin trigger (thường 0)
 * @param freeSpinCount Số free spin awarded (10 default)
 * @param startingBalance Balance trước trigger
 */
export function synthesizeBonusTriggerResponse(
  template: string,
  bet: number,
  triggerWin: number,
  freeSpinCount: number,
  startingBalance: number,
): string {
  const endingBalance = startingBalance - bet + triggerWin;
  return synthesizeBody(template, {
    bet,
    win: triggerWin,
    startingBalance,
    endingBalance,
    hasBonusTrigger: true,
    freeSpinCount,
  });
}
