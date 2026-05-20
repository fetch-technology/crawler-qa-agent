/**
 * Deterministic spin — counterpart của doAutoSpin (test-harness.ts).
 *
 * Khác biệt:
 *   - doAutoSpin: gọi LLM mỗi iteration để quyết click ở đâu → flaky, đắt, chậm.
 *   - spinDeterministic: click tại tọa độ cố định (từ region snapshot hoặc fixed coord)
 *     → response đã được mock → assertion với expected từ scenario.
 *
 * Pre-requisite:
 *   - Page đã được setup qua makeDeterministic(page, { slug, scenario })
 *   - Game đã loaded tới play screen (caller chịu trách nhiệm — vd dùng region
 *     snapshot để xác nhận "spin button ở X,Y").
 *
 * Khi nào dùng cái này thay cho doAutoSpin?
 *   - Test reproducible (CI, regression): luôn dùng spinDeterministic
 *   - Discovery / exploration với game lạ: vẫn dùng doAutoSpin
 */

import type { Page } from "playwright";
import type { DeterministicHandle } from "./deterministic.js";
import { tryParseBody } from "./spin-detect.js";
import { waitForCanvasReady } from "./wait-ready.js";

export type SpinCoord = { x: number; y: number };

export type SpinDeterministicOpts = {
  /** Tọa độ click spin button. Required — không có vision để tìm. */
  spinButton: SpinCoord;
  /**
   * Số ms wait sau click trước khi pop response từ handle. Vì response đã được
   * mock fulfill synchronously, default ngắn (200ms) là đủ.
   */
  postClickWaitMs?: number;
  /**
   * Hover trước khi click (giả lập user thật, một số game cần hover để enable
   * spin button). Default true.
   */
  hoverBeforeClick?: boolean;
  /**
   * Retry click + ms wait giữa các retry. Vì canvas game có thể vẫn đang init
   * lúc click đầu, retry tăng độ tin cậy. Default { attempts: 4, waitMs: 1500 }.
   */
  retry?: { attempts: number; waitMs: number };
};

export type SpinDeterministicResult = {
  /** Parsed body của response đã match. Null nếu body không parse được. */
  parsed: Record<string, unknown> | null;
  /** Raw body string từ scenario. */
  body: string;
  /** spinRequestCount của handle sau spin này. */
  spinRequestCount: number;
};

/**
 * Click spin button và wait cho mocked response. Return parsed body để test assert.
 *
 * @example
 *   const handle = await makeDeterministic(page, { slug, scenario: "bonus_trigger" });
 *   await page.goto(GAME_URL);
 *   await waitForPlayScreen(page);  // caller — region snapshot hoặc fixed wait
 *   const result = await spinDeterministic(page, handle, {
 *     spinButton: { x: 740, y: 820 },
 *   });
 *   expect(result.parsed.winAmount).toBe(handle.scenario.expected.win);
 */
export async function spinDeterministic(
  page: Page,
  handle: DeterministicHandle,
  opts: SpinDeterministicOpts,
): Promise<SpinDeterministicResult> {
  const beforeCount = handle.spinRequestCount;
  const postClickWait = opts.postClickWaitMs ?? 200;
  const hover = opts.hoverBeforeClick ?? true;
  const retry = opts.retry ?? { attempts: 4, waitMs: 1500 };

  // Retry click loop — canvas game thường vẫn init khi click đầu fire,
  // event handler chưa bind. Retry mỗi 1.5s tới khi response mock fire hoặc
  // hết attempts.
  const runClickAttempts = async (attempts: number): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (hover) {
        await page.mouse.move(opts.spinButton.x, opts.spinButton.y);
        await page.waitForTimeout(100);
      }
      await page.mouse.click(opts.spinButton.x, opts.spinButton.y);

      // Đợi route handler fire. Mock fulfill sync nên count tăng ngay sau request.
      const attemptDeadline = Date.now() + retry.waitMs;
      while (Date.now() < attemptDeadline) {
        if (handle.spinRequestCount > beforeCount) return true;
        await page.waitForTimeout(50);
      }
    }
    return handle.spinRequestCount > beforeCount;
  };

  let fired = await runClickAttempts(retry.attempts);

  // Recovery pass cho isolated page mới mở: đợi canvas stable rồi thử thêm.
  // Giảm false fail "no spin request" khi game chưa bind input handler kịp.
  if (!fired) {
    const ready = await waitForCanvasReady(page, {
      timeoutMs: Math.max(8_000, retry.waitMs * 2),
    });
    if (ready.ready) {
      fired = await runClickAttempts(Math.max(2, Math.floor(retry.attempts / 2)));
    }
  }

  if (!fired && handle.spinRequestCount === beforeCount) {
    throw new Error(
      `spinDeterministic: no spin request fired after ${retry.attempts} click(s) at (${opts.spinButton.x},${opts.spinButton.y}). ` +
        `Khả năng: (1) canvas chưa load xong — dùng waitForCanvasReady(page) trước; ` +
        `(2) spin button bị popup che (age gate / tutorial / login chưa qua); ` +
        `(3) tọa độ sai — inspect fixtures/recordings/{slug}__.../iterations.json để lấy AI-clicked coords.`,
    );
  }

  await page.waitForTimeout(postClickWait);

  // Read body from the EFFECTIVE sequence — what the mock actually returned to
  // the game (responseOverrides + cascade chain + free-spin chain applied).
  // Falls back to raw scenario if effectiveSequence is empty (defensive).
  const idx = Math.min(beforeCount, handle.effectiveSequence.length - 1);
  const fixture =
    handle.effectiveSequence[idx] ??
    handle.scenario.spin_sequence?.[idx] ??
    handle.scenario.spin_response;
  const parsed = tryParseBody(fixture.body);

  return {
    parsed,
    body: fixture.body,
    spinRequestCount: handle.spinRequestCount,
  };
}

/**
 * Assert spin result match expected từ scenario. Convenience wrapper —
 * thay vì viết nhiều expect() rời, gọi 1 lần.
 *
 * Throws nếu một field expected ≠ actual (tolerance 0.01 cho float).
 */
export function assertSpinMatchesExpected(
  result: SpinDeterministicResult,
  expected: {
    bet?: number;
    win?: number;
    ending_balance?: number;
    starting_balance?: number;
    has_bonus?: boolean;
    is_free_spin?: boolean;
  },
  tolerance = 0.01,
): void {
  const p = result.parsed;
  if (!p) {
    throw new Error("assertSpinMatchesExpected: response body did not parse");
  }
  const mismatches: string[] = [];

  // Bet priority: explicit betAmount/bet (RG) → c × l (PP/ways/cluster) → c (fallback).
  // Reading c alone = coin-per-line, NOT total bet — phải đồng bộ với
  // scenario-extractor.ts và statistical/simulate.ts (cùng pattern).
  const extractedBet = (() => {
    const explicit = firstNumber(p, ["betAmount", "bet", "totalBet"]);
    if (explicit != null) return explicit;
    const c = firstNumber(p, ["c"]);
    const l = firstNumber(p, ["l"]);
    if (c != null && l != null && c > 0 && l > 0) return c * l;
    return c;
  })();

  const fieldMap = [
    {
      key: "bet" as const,
      apiKeys: ["__computed__"],  // marker — actual value lấy từ extractedBet
      expected: expected.bet,
      actualOverride: extractedBet,
    },
    {
      key: "win" as const,
      apiKeys: ["winAmount", "win", "tw", "totalWin"],
      expected: expected.win,
      actualOverride: undefined,
    },
    {
      key: "ending_balance" as const,
      apiKeys: ["endingBalance", "updatedBalance", "balance"],
      expected: expected.ending_balance,
      actualOverride: undefined,
    },
    {
      key: "starting_balance" as const,
      apiKeys: ["startingBalance"],
      expected: expected.starting_balance,
      actualOverride: undefined,
    },
  ];

  for (const f of fieldMap) {
    if (f.expected == null) continue;
    const actual = f.actualOverride !== undefined ? f.actualOverride : firstNumber(p, f.apiKeys);
    if (actual == null) {
      mismatches.push(`  ${f.key}: expected ${f.expected}, got null (no field ${f.apiKeys.join("|")})`);
      continue;
    }
    if (Math.abs(actual - f.expected) > tolerance) {
      mismatches.push(`  ${f.key}: expected ${f.expected}, got ${actual} (delta=${Math.abs(actual - f.expected).toFixed(4)})`);
    }
  }

  if (expected.is_free_spin != null) {
    const actual = p.isFreeSpin === true;
    if (actual !== expected.is_free_spin) {
      mismatches.push(`  is_free_spin: expected ${expected.is_free_spin}, got ${actual}`);
    }
  }
  if (expected.has_bonus != null) {
    const winFree = firstNumber(p, ["winFreeSpins"]);
    const actual = p.isFreeSpin === true || (winFree ?? 0) > 0;
    if (actual !== expected.has_bonus) {
      mismatches.push(`  has_bonus: expected ${expected.has_bonus}, got ${actual}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`assertSpinMatchesExpected: ${mismatches.length} mismatch(es):\n${mismatches.join("\n")}`);
  }
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
