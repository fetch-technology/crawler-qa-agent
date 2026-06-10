import { test, expect, type Page, type Response } from "@playwright/test";
import {
  decideNextAction,
  decideHistoryFlow,
  transcribeHistoryRows,
  transcribePlayScreenValues,
  type TranscribedHistoryRow,
  type TranscribedScreenValues,
} from "../ai/vision.js";
import { ScreenshotStore, getScreenshotStore } from "./screenshot-store.js";
import { preGameWithReplayOrVision } from "./pre-game-replay.js";
import {
  tryParseBody,
  scoreSpinShape,
  getSpinUrlPattern,
  shouldSkipUrl,
} from "./spin-detect.js";
import { applyFieldMapping, type FieldMapping } from "../ai/network-detect.js";
import { resolveSpinButton } from "./spin-button-resolve.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadHintsMapping(): FieldMapping | null {
  const hintsFile = process.env.QA_HINTS_FILE ?? inferHintsFileFromGameUrl();
  if (!hintsFile) return null;
  try {
    if (!existsSync(hintsFile)) return null;
    const data = JSON.parse(readFileSync(hintsFile, "utf8"));
    if (data?.field_mapping) return data.field_mapping as FieldMapping;
  } catch {}
  return null;
}

function inferHintsFileFromGameUrl(): string | null {
  const gameUrl = process.env.GAME_URL;
  if (!gameUrl) return null;
  try {
    const slug = new URL(gameUrl).pathname.split("/").filter(Boolean)[0];
    if (!slug) return null;
    const p = join("fixtures", "specs", slug, "network-hints.json");
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export { test, expect };
export { getScreenshotStore } from "./screenshot-store.js";

/**
 * Set screenshot subfolder cho test case hiện tại. Gọi ở đầu mỗi test() block,
 * mọi screenshot tiếp theo sẽ vào `screenshots/{caseId}/`. Truyền null để clear.
 *
 * Cũng emit EVENT:case_start để dashboard mark case là "running" ngay khi test
 * bắt đầu (Playwright list reporter chỉ in status sau khi test xong).
 */
export function setActiveCase(caseId: string | null): void {
  getScreenshotStore().setCaseScope(caseId);
  if (caseId) {
    console.log(
      `EVENT:case_start ${JSON.stringify({ caseId, timestamp: new Date().toISOString() })}`,
    );
  }
}

/**
 * Cascade/tumble helper. Trong các game như Sweet Bonanza, mỗi UI spin tạo
 * NHIỀU API spin responses (mỗi cascade = 1 entry). Hàm này lọc về những spin
 * đại diện cho END của 1 round (UI spin thực sự kết thúc).
 *
 * Heuristic ưu tiên (theo thứ tự):
 *  1. Field `isEndRound === true` (provider cung cấp).
 *  2. Khi không có flag: lấy spin có `endingBalance` thay đổi so với spin trước,
 *     hoặc `round`/`id` chuyển — fallback giữ index cuối cùng của mỗi nhóm cùng round.
 *  3. Nếu không xác định được, return tất cả spins (xem như mỗi spin = 1 round).
 */
export function getRoundEndSpins(spins: SpinResponse[]): SpinResponse[] {
  if (spins.length === 0) return [];

  // Case 1: có isEndRound rõ ràng
  const flagged = spins.filter((s) => s.isEndRound === true);
  if (flagged.length > 0) return flagged;

  // Case 2: dùng round/roundId field để group, lấy entry cuối mỗi group
  const roundKey = (s: SpinResponse): string | null => {
    const r = (s as Record<string, unknown>).round ?? (s as Record<string, unknown>).roundId;
    return typeof r === "string" || typeof r === "number" ? String(r) : null;
  };
  const haveRoundKey = spins.some((s) => roundKey(s) != null);
  if (haveRoundKey) {
    const out: SpinResponse[] = [];
    let prevKey: string | null = null;
    for (let i = 0; i < spins.length; i++) {
      const cur = roundKey(spins[i]!);
      const next = i + 1 < spins.length ? roundKey(spins[i + 1]!) : null;
      // Entry cuối của 1 group → push
      if (cur !== next) out.push(spins[i]!);
      prevKey = cur;
    }
    if (out.length > 0) return out;
  }

  // Case 3: fallback — không phân biệt được, return all
  return spins;
}

/**
 * Trả về endingBalance của round NGAY TRƯỚC vị trí `beforeIndex` trong spins[].
 * Dùng cho balance-chain assertion: "startingBalance của round hiện tại phải bằng
 * endingBalance của round trước đó". Cascade-safe.
 *
 * Trả null nếu chưa có round nào trước đó (vd round đầu tiên).
 */
export function getPreviousRoundEndingBalance(
  spins: SpinResponse[],
  beforeIndex: number,
): number | null {
  if (beforeIndex <= 0) return null;
  const prior = spins.slice(0, beforeIndex);
  const ends = getRoundEndSpins(prior);
  if (ends.length === 0) return null;
  const last = ends[ends.length - 1];
  const v = last?.endingBalance;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Tiện cho assertion: kiểm tra `current.startingBalance` chain với round trước.
 * Trả true nếu match (hoặc nếu là round đầu / không xác định được round trước).
 */
export function balanceChainsFromPreviousRound(
  spins: SpinResponse[],
  current: SpinResponse,
  tolerance = 0.01,
): boolean {
  const idx = spins.indexOf(current);
  const prevEnd = getPreviousRoundEndingBalance(spins, idx >= 0 ? idx : spins.length - 1);
  if (prevEnd == null) return true; // không có round trước → bỏ qua chain check
  const start = current.startingBalance;
  if (typeof start !== "number" || !Number.isFinite(start)) return true;
  return Math.abs(start - prevEnd) <= tolerance;
}

/**
 * Đợi tới khi feature/bonus chain (vd buy feature → free spins) hoàn tất.
 * Khác với waitForAutoplayRounds — không biết trước bao nhiêu free spin sẽ
 * trigger. Đợi tới khi:
 *   - Có ít nhất `minRounds` round-end (default 1) — chain đã thực sự bắt đầu
 *   - VÀ không có round-end mới trong `quietMs` (default 8s) — chain đã settled
 *
 * Throws nếu chain không bắt đầu trong `startTimeoutMs` (default 30s) —
 * có nghĩa setup buy chưa thực sự confirm.
 */
export async function waitForFeatureComplete(
  collector: SpinCollector,
  opts: {
    minRounds?: number;
    quietMs?: number;
    startTimeoutMs?: number;
    maxTotalMs?: number;
    pollIntervalMs?: number;
    /**
     * Index trong collector.spins (đo TRƯỚC khi setup chạy). Buy response
     * thường tới TRONG setup (khi AI click Confirm), nên cần baseline trước
     * setup để tính "new rounds". Nếu null → dùng count hiện tại (legacy).
     */
    sinceIndex?: number;
  } = {},
): Promise<void> {
  const minRounds = opts.minRounds ?? 1;
  const quietMs = opts.quietMs ?? 8_000;
  // Default tăng 30 → 60s. Buy feature popup ở Pragmatic Play có thể có 2-3 step
  // (chọn option → BUY button → confirm dialog) → applyCaseSetup có thể return
  // sau khi mới chỉ chọn option, AI cần thêm thời gian / spin chậm nổi lên.
  const startTimeoutMs = opts.startTimeoutMs ?? 60_000;
  const maxTotalMs = opts.maxTotalMs ?? 5 * 60_000;
  const poll = opts.pollIntervalMs ?? 500;

  const initialSpinCount =
    opts.sinceIndex != null ? opts.sinceIndex : collector.spins.length;
  const initialEnds = getRoundEndSpins(collector.spins.slice(0, initialSpinCount)).length;
  const startedAt = Date.now();
  let lastNewRoundAt = Date.now();
  let lastEndCount = initialEnds;

  while (Date.now() - startedAt < maxTotalMs) {
    const ends = getRoundEndSpins(collector.spins);
    const newRounds = ends.length - initialEnds;

    if (ends.length > lastEndCount) {
      lastEndCount = ends.length;
      lastNewRoundAt = Date.now();
    }

    // Chain chưa start sau startTimeoutMs → setup chưa trigger feature
    if (newRounds === 0 && Date.now() - startedAt > startTimeoutMs) {
      const captured = collector.spins.length - initialSpinCount;
      throw new Error(
        `waitForFeatureComplete: feature chain didn't start within ${startTimeoutMs}ms (${captured} new responses captured but none counted as round-end). Setup likely clicked "select option" but missed the final BUY/CONFIRM button. Check the screenshot for the case to see the popup state when setup ended.`,
      );
    }

    // Có ≥minRounds rounds VÀ đã quiet quietMs → chain đã settled
    if (newRounds >= minRounds && Date.now() - lastNewRoundAt >= quietMs) {
      return;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  const ends = getRoundEndSpins(collector.spins);
  throw new Error(
    `waitForFeatureComplete: timeout — captured ${ends.length - initialEnds} new rounds in ${maxTotalMs}ms, chain never settled.`,
  );
}

/**
 * Verify "buy feature đã được mua" qua balance trajectory.
 *
 * Strategy: so sánh balance TRƯỚC setup (last balance khi setup bắt đầu) với
 * balance SAU round buy đầu tiên. Deduction = balance_before − balance_after_first
 * + winAmount_first. Tổng = số tiền player thực sự trả cho buy.
 *
 * Khác formula cũ (single-round start − end + win) — formula đó không hoạt động
 * với provider chỉ trả 1 field balance (PP, etc.) vì startingBalance ≡ endingBalance
 * trong cùng response.
 *
 * @param spins  collector.spins
 * @param startIndex  index trước setup (đo lúc test bắt đầu)
 * @param balanceBefore  balance lúc startIndex (caller cung cấp; nếu không có,
 *                       hàm sẽ thử lấy từ spin trước startIndex hoặc trả null)
 */
export function detectBuyFeatureDeduction(
  spins: SpinResponse[],
  startIndex = 0,
  balanceBefore?: number | null,
): { deduction: number; baseBet: number; ratio: number; spin: SpinResponse } | null {
  const after = spins.slice(startIndex);
  const ends = getRoundEndSpins(after);
  if (ends.length === 0) return null;
  const first = ends[0]!;
  const baseBet = typeof first.betAmount === "number" ? first.betAmount : 0;
  const win = typeof first.winAmount === "number" ? first.winAmount : 0;

  // Resolve balance trước buy: ưu tiên caller; fallback dùng endingBalance
  // của spin ngay trước startIndex (nếu có).
  let before = typeof balanceBefore === "number" ? balanceBefore : null;
  if (before == null && startIndex > 0) {
    const prior = spins[startIndex - 1];
    const v = (prior as any)?.endingBalance ?? (prior as any)?.balance;
    if (typeof v === "number") before = v;
  }

  // Balance sau round buy (từ chính response đầu)
  const after1 = (first as any).endingBalance ?? (first as any).balance;
  if (before == null || typeof after1 !== "number") return null;

  // Only add back a CREDITED (positive) win. A negative winAmount means the
  // parser folded the buy cost into `win` (PP buy spins emit -(buyCost-baseBet));
  // that outflow is already in (before - after1), so adding it back cancels it
  // and yields ratio ≈ 1, false-failing buy-cost assertions. Keep in sync with
  // assertion-helpers.ts detectBuyFeatureDeduction.
  const winCredit = win > 0 ? win : 0;
  const deduction = before - after1 + winCredit;
  return {
    deduction,
    baseBet,
    ratio: baseBet > 0 ? deduction / baseBet : 0,
    spin: first,
  };
}

/**
 * Lấy balance hiện tại đang được track bởi collector (last seen). Dùng để
 * snapshot trước khi setup chạy, rồi pass vào detectBuyFeatureDeduction.
 */
export function getCurrentBalance(collector: SpinCollector): number | null {
  // SpinCollector lưu lastBalance private; expose qua spins[last] hoặc authorize.
  if (collector.spins.length > 0) {
    const last = collector.spins[collector.spins.length - 1] as any;
    if (typeof last?.endingBalance === "number") return last.endingBalance;
    if (typeof last?.balance === "number") return last.balance;
  }
  if (collector.authorize) {
    const auth = collector.authorize as any;
    if (typeof auth?.balance === "number") return auth.balance;
    if (typeof auth?.balance_cash === "number") return auth.balance_cash;
  }
  return null;
}

/**
 * Đợi tới khi đã thu thập đủ N round-end responses trong collector.
 * Dùng cho autoplay/buy-feature: setup đã click Start, game tự spin → ta chỉ chờ
 * network responses thay vì loop click Spin từng lần.
 *
 * Giúp tránh timeout khi cascade game (vd Sweet Bonanza) có 25 round mà mỗi
 * round AI-loop sẽ tốn 25-30s — autoplay native của game nhanh hơn nhiều.
 *
 * @param collector  SpinCollector từ openGame
 * @param expectedRounds  số round mong đợi (test_case.spin_count)
 * @param opts.perRoundTimeoutMs  giới hạn time cho mỗi round (default 30s)
 * @param opts.totalTimeoutMs  giới hạn time tổng (default = perRoundTimeoutMs × expected)
 */
export async function waitForAutoplayRounds(
  collector: SpinCollector,
  expectedRounds: number,
  opts: { perRoundTimeoutMs?: number; totalTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const perRound = opts.perRoundTimeoutMs ?? 30_000;
  const totalMs = opts.totalTimeoutMs ?? perRound * expectedRounds;
  const poll = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + totalMs;
  let lastSeen = -1;
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
    const ends = getRoundEndSpins(collector.spins);
    if (ends.length >= expectedRounds) return;
    if (ends.length > lastSeen) {
      lastSeen = ends.length;
      lastProgressAt = Date.now();
    }
    // Stall detection: nếu không thấy round mới trong 2× perRound → autoplay đã dừng
    // sớm (vì stop condition như loss limit hit hoặc bonus trigger).
    if (Date.now() - lastProgressAt > perRound * 2) {
      throw new Error(
        `waitForAutoplayRounds: stall — chỉ ${ends.length}/${expectedRounds} rounds, không có round mới trong ${Math.round((Date.now() - lastProgressAt) / 1000)}s. Autoplay có thể đã tự dừng (stop condition).`,
      );
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  const ends = getRoundEndSpins(collector.spins);
  throw new Error(
    `waitForAutoplayRounds: timeout — chỉ thu được ${ends.length}/${expectedRounds} rounds trong ${totalMs}ms.`,
  );
}
export { applyCaseSetup, type SetupResult } from "./setup-driver.js";
export type HistoryRow = TranscribedHistoryRow;

export type SpinResponse = Record<string, unknown> & {
  id?: string;
  round?: string;
  betAmount?: number;
  winAmount?: number;
  startingBalance?: number;
  endingBalance?: number;
  updatedBalance?: number;
  status?: string;
  isFreeSpin?: boolean;
  isEndRound?: boolean;
  isMaxWin?: boolean;
  isMaxCap?: boolean;
  currency?: string;
  totalBet?: number;
  multiplier?: number;
  freeSpins?: number;
  winFreeSpins?: number;
  matrix?: Array<Array<{ symbol: number; value: number; type: number }>>;
  result?: {
    winlines?: Array<Record<string, unknown>>;
    totalWinAmount?: number;
    [key: string]: unknown;
  };
  type?: string;
  baseBet?: number;
  betSize?: number;
  betLevel?: number;
};

const VIEWPORT = { width: 1440, height: 900 };
const SPIN_URL_PATTERN = getSpinUrlPattern();

function inferFallbackSpinButton(url: string): { x: number; y: number } {
  // Pragmatic layouts are right-bottom and often drift near +/- controls.
  if (/\/\/pp\.|pragmatic/i.test(url)) return { x: 1120, y: 840 };
  // Legacy generic fallback.
  return { x: 720, y: 810 };
}

function isSpinIntent(reason: string): boolean {
  return /\bspin\b|start spin|start the next spin|reels?.*spin|single spin|press spin/i.test(
    reason,
  );
}

async function probeSpinAroundHint(
  page: Page,
  hint: { x: number; y: number } | null,
  maxAttempts = 6,
): Promise<boolean> {
  if (!hint) return false;
  const offsets = [
    { dx: 0, dy: 0 },
    { dx: -36, dy: 0 },
    { dx: 36, dy: 0 },
    { dx: 0, dy: -36 },
    { dx: 0, dy: 36 },
    { dx: -28, dy: -28 },
    { dx: 28, dy: -28 },
    { dx: -28, dy: 28 },
    { dx: 28, dy: 28 },
  ];
  for (const o of offsets.slice(0, Math.max(1, maxAttempts))) {
    const px = Math.max(1, Math.min(VIEWPORT.width - 1, hint.x + o.dx));
    const py = Math.max(1, Math.min(VIEWPORT.height - 1, hint.y + o.dy));
    await page.mouse.move(px, py);
    await page.waitForTimeout(70);
    await page.mouse.click(px, py);
    const got = await page
      .waitForResponse(
        (r) =>
          SPIN_URL_PATTERN.test(r.url()) &&
          (r.request().method() === "POST" || r.request().method() === "GET"),
        { timeout: 1_200 },
      )
      .then(() => true)
      .catch(() => false);
    if (got) return true;
  }
  return false;
}

export type SpinEvent = {
  kind: "spin";
  taskId: string | null;
  spinNumber: number;
  timestamp: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  betAmount: number | null;
  winAmount: number | null;
  netChange: number | null;
  status: string | null;
  spinId: string | null;
  currency: string | null;
};

function emitEvent(kind: string, data: Record<string, unknown>) {
  console.log(`EVENT:${kind} ${JSON.stringify(data)}`);
}

export class SpinCollector {
  spins: SpinResponse[] = [];
  authorize: SpinResponse | null = null;
  private taskId: string | null = null;
  private lastBalance: number | null = null;
  private fieldMapping: FieldMapping | null = null;
  spinButtonHint: { x: number; y: number } | null = null;

  constructor(public page: Page) {
    this.taskId = process.env.QA_TASK_ID ?? null;
    this.fieldMapping = loadHintsMapping();
    if (this.fieldMapping) {
      console.log(
        `[SpinCollector] ✔ field mapping loaded (bet=${this.fieldMapping.bet}, win=${this.fieldMapping.win}, balance=${this.fieldMapping.balance})`,
      );
    }
    page.on("response", async (res: Response) => {
      const url = res.url();
      const method = res.request().method();
      if (shouldSkipUrl(url)) return;

      // Ứng viên spin: URL match + method POST (đa số case). Một số PP gọi
      // spin qua GET nên thử cả hai.
      const urlMatches = SPIN_URL_PATTERN.test(url);
      if (!urlMatches && !/authorize-game|\/balance\b|\/wallet\b/i.test(url)) return;

      try {
        const text = await res.text();
        const parsed = tryParseBody(text);
        if (!parsed) return;

        // Score body shape — phải pass threshold để được coi là spin
        if (urlMatches && (method === "POST" || method === "GET")) {
          const shape = scoreSpinShape(parsed);
          if (shape.score >= 5) {
            // Áp field mapping (từ QA_HINTS_FILE) → normalized shape có
            // betAmount/winAmount/endingBalance/startingBalance chuẩn.
            const normalized: SpinResponse = this.fieldMapping
              ? (applyFieldMapping(parsed, this.fieldMapping) as SpinResponse)
              : (parsed as SpinResponse);
            this.spins.push(normalized);

            const spinEvent: SpinEvent = {
              kind: "spin",
              taskId: this.taskId,
              spinNumber: this.spins.length,
              timestamp: new Date().toISOString(),
              balanceBefore:
                asNumberOrNull(normalized.startingBalance) ?? this.lastBalance,
              balanceAfter:
                asNumberOrNull(normalized.endingBalance) ??
                asNumberOrNull((normalized as any).updatedBalance) ??
                asNumberOrNull((parsed as any).balance) ??
                asNumberOrNull((parsed as any).balance_cash),
              betAmount:
                asNumberOrNull(normalized.betAmount) ??
                asNumberOrNull((parsed as any).c),
              winAmount:
                asNumberOrNull(normalized.winAmount) ??
                asNumberOrNull((parsed as any).tw) ??
                asNumberOrNull((parsed as any).rs_iw),
              netChange: null,
              status: typeof normalized.status === "string" ? normalized.status : null,
              spinId:
                (typeof normalized.id === "string" ? normalized.id : null) ??
                (typeof (parsed as any).index === "string" ? (parsed as any).index : null),
              currency: typeof normalized.currency === "string" ? normalized.currency : null,
            };
            if (spinEvent.betAmount != null && spinEvent.winAmount != null) {
              spinEvent.netChange = spinEvent.winAmount - spinEvent.betAmount;
            }
            emitEvent("spin", spinEvent as unknown as Record<string, unknown>);
            if (spinEvent.balanceAfter != null) this.lastBalance = spinEvent.balanceAfter;
            return;
          }
        }

        // authorize / balance / wallet endpoint
        if (/authorize-game|\/balance\b|\/wallet\b/i.test(url)) {
          if (!this.authorize && /authorize-game/.test(url)) {
            this.authorize = parsed as SpinResponse;
            emitEvent("authorize", {
              taskId: this.taskId,
              balance: asNumberOrNull((parsed as any).balance),
              currency: (parsed as any).currency,
            });
          }
          const bal =
            asNumberOrNull((parsed as any).balance) ??
            asNumberOrNull((parsed as any).balance_cash);
          if (bal != null) this.lastBalance = bal;
        }
      } catch {
        // response body unreadable
      }
    });
  }

  last(): SpinResponse {
    const s = this.spins[this.spins.length - 1];
    if (!s) throw new Error("Chưa có spin response nào");
    return s;
  }
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function openGame(page: Page, url: string): Promise<SpinCollector> {
  emitEvent("open_game", { url });
  const collector = new SpinCollector(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Replay-first pre-game by default, vision as fallback.
  await page.waitForTimeout(2_500);
  const slug = (() => {
    try {
      const p = new URL(url).pathname.split("/").filter(Boolean)[0];
      return p || "unknown";
    } catch {
      return "unknown";
    }
  })();
  const res = await preGameWithReplayOrVision(page, {
    slug,
    viewport: VIEWPORT,
    label: "pre-game",
    forceVision: process.env.PRE_GAME_FORCE_VISION === "1",
  });
  if (!res.ready) {
    console.warn(
      `[openGame] WARNING: play screen chưa ready (source=${res.source}). Test có thể fail.`,
    );
  }

  const sb = resolveSpinButton(res, inferFallbackSpinButton(url));
  collector.spinButtonHint = sb.coord;
  console.log(
    `[openGame] spin button hint (${sb.coord.x},${sb.coord.y}) source=${sb.source}`,
  );

  const store = getScreenshotStore();
  await store.take(page, "game-ready");
  emitEvent("game_ready", {
    url,
    source: res.source,
    autoHealed: res.autoHealed,
    ready: res.ready,
    screenshotDir: store.dir,
  });
  return collector;
}

export async function doAutoSpin(
  page: Page,
  collector: SpinCollector,
  opts: { maxIterations?: number; perIterTimeoutMs?: number } = {},
): Promise<SpinResponse> {
  // Default tăng lên 20 (từ 12) để tolerate cascade games + post-setup popups.
  // Override qua env DO_AUTO_SPIN_MAX_ITER nếu cần.
  const maxIter =
    opts.maxIterations ?? Number(process.env.DO_AUTO_SPIN_MAX_ITER ?? 20);
  const startCount = collector.spins.length;
  const store = getScreenshotStore();
  const snum = String(startCount + 1).padStart(2, "0");
  const waitForRoundSettled = async (): Promise<SpinResponse> => {
    const timeoutMs = Number(process.env.DO_AUTO_SPIN_SETTLE_TIMEOUT_MS ?? 20_000);
    const quietMs = Number(process.env.DO_AUTO_SPIN_SETTLE_QUIET_MS ?? 700);
    const started = Date.now();
    let lastLen = collector.spins.length;
    let lastGrowthAt = Date.now();

    while (Date.now() - started < timeoutMs) {
      const len = collector.spins.length;
      if (len > lastLen) {
        lastLen = len;
        lastGrowthAt = Date.now();
      }
      if (len > startCount) {
        const latest = collector.spins[len - 1] as Record<string, unknown>;
        const na = String(latest?.na ?? "");
        const rsMore = Number(latest?.rs_more ?? 0);
        const chainContinuing = na === "c" || (Number.isFinite(rsMore) && rsMore > 0);
        if (!chainContinuing && Date.now() - lastGrowthAt >= quietMs) {
          return collector.last();
        }
      }
      await page.waitForTimeout(120);
    }

    // Timeout fallback: still return the latest captured spin instead of hard-failing.
    return collector.last();
  };
  const finalizeSpin = async (): Promise<SpinResponse> => {
    const settled = await waitForRoundSettled();
    await store.take(page, `spin-${snum}-after`);
    return settled;
  };

  // Trace lại các action AI đã thử để in chi tiết khi throw
  const actionTrace: string[] = [];
  await store.take(page, `spin-${snum}-before`);
  let lastAction: { action: string; reason: string } | null = null;

  // Fast path: probe spin around resolved hint before entering AI loop.
  if (await probeSpinAroundHint(page, collector.spinButtonHint, 5)) {
    await page.waitForTimeout(2_000);
    if (collector.spins.length > startCount) {
      return await finalizeSpin();
    }
  }

  for (let i = 0; i < maxIter; i++) {
    // Nếu đã có spin mới thì return luôn
    if (collector.spins.length > startCount) {
      await page.waitForTimeout(400);
      return await finalizeSpin();
    }

    // If still no progress, periodically try deterministic probe first to
    // avoid spending many expensive vision turns on a drifting click target.
    if (i >= 2 && i % 2 === 0) {
      const hit = await probeSpinAroundHint(page, collector.spinButtonHint, 4);
      actionTrace.push(`[${i}] probe-first hit=${hit}`);
      if (hit) {
        await page.waitForTimeout(2_000);
        if (collector.spins.length > startCount) {
          return await finalizeSpin();
        }
      }
    }

    const shotPath = await store.take(page, `spin-${snum}-iter-${String(i).padStart(2, "0")}`);

    const decision = await decideNextAction({
      screenshotPath: shotPath,
      viewport: VIEWPORT,
      spinsCompleted: startCount,
      spinsTarget: startCount + 1,
      lastAction,
    });
    actionTrace.push(
      `[${i}] ${decision.action}@(${decision.x},${decision.y}) state=${decision.spin_state} — ${decision.reason.slice(0, 100)}`,
    );

    if (decision.action === "click") {
      const spinIntent = isSpinIntent(decision.reason);
      const spinPromise = spinIntent
        ? page
            .waitForResponse(
              (r) =>
                SPIN_URL_PATTERN.test(r.url()) &&
                (r.request().method() === "POST" || r.request().method() === "GET"),
              { timeout: 8_000 },
            )
            .catch(() => null)
        : null;

      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(150);
      await page.mouse.click(decision.x, decision.y);

      if (spinPromise) {
        await spinPromise;
      } else {
        await page.waitForTimeout(1_500);
      }

      // Fallback probe: nếu đây là spin-intent click nhưng chưa thấy spin mới,
      // thử click quanh spin hint để giảm no-spin-response do lệch tọa độ.
      if (spinIntent && collector.spins.length <= startCount && collector.spinButtonHint) {
        const h = collector.spinButtonHint;
        const probeOffsets = [
          { dx: 0, dy: 0 },
          { dx: -36, dy: 0 },
          { dx: 36, dy: 0 },
          { dx: 0, dy: -36 },
          { dx: 0, dy: 36 },
          { dx: -28, dy: -28 },
          { dx: 28, dy: -28 },
          { dx: -28, dy: 28 },
          { dx: 28, dy: 28 },
        ];
        for (const p of probeOffsets) {
          if (collector.spins.length > startCount) break;
          const px = Math.max(1, Math.min(VIEWPORT.width - 1, h.x + p.dx));
          const py = Math.max(1, Math.min(VIEWPORT.height - 1, h.y + p.dy));
          actionTrace.push(`  ↪ probe_spin@(${px},${py})`);
          await page.mouse.move(px, py);
          await page.waitForTimeout(80);
          await page.mouse.click(px, py);
          await page
            .waitForResponse(
              (r) =>
                SPIN_URL_PATTERN.test(r.url()) &&
                (r.request().method() === "POST" || r.request().method() === "GET"),
              { timeout: 1_200 },
            )
            .catch(() => null);
        }
      }

      await page.waitForTimeout(2_000);

      if (collector.spins.length > startCount) {
        return await finalizeSpin();
      }
    } else if (decision.action === "wait") {
      await page.waitForTimeout(2_000);
    } else if (decision.action === "spin_done") {
      if (collector.spins.length > startCount) {
        return await finalizeSpin();
      }
    } else if (decision.action === "error") {
      await store.take(page, `spin-${snum}-error`);
      throw new Error(`AI báo error state: ${decision.reason}`);
    }

    lastAction = { action: decision.action, reason: decision.reason };
  }

  await store.take(page, `spin-${snum}-stuck`);
  throw new Error(
    `doAutoSpin: Hết ${maxIter} iterations mà chưa bắt được spin response. Action trace:\n${actionTrace.join("\n")}\n\nKhả năng: (1) popup chưa đóng che spin button, (2) bet vượt balance, (3) AI click sai vị trí. Xem screenshot 'spin-${snum}-stuck.png' để debug.`,
  );
}

// ===== History verification =====

/**
 * Dùng AI vision để navigate tới History / Rounds / Transactions panel của game.
 * Throws nếu không tìm được history UI trong timeout.
 */
export async function openHistoryPanel(
  page: Page,
  _collector: SpinCollector,
  opts: { maxIterations?: number } = {},
): Promise<void> {
  const maxIter = opts.maxIterations ?? 15;
  const store = getScreenshotStore();
  let lastAction: { action: string; reason: string; phase: string } | null = null;
  let sameStateCount = 0;
  let lastStateKey = "";

  for (let i = 0; i < maxIter; i++) {
    const shotPath = await store.take(page, `history-nav-${String(i).padStart(2, "0")}`);
    const decision = await decideHistoryFlow({
      screenshotPath: shotPath,
      viewport: VIEWPORT,
      iteration: i,
      lastAction,
    });

    if (decision.history_visible && decision.action === "done") {
      await store.take(page, "history-open");
      return;
    }

    if (decision.action === "click") {
      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(150);
      await page.mouse.click(decision.x, decision.y);
      await page.waitForTimeout(1_500);
    } else if (decision.action === "scroll") {
      const dir = decision.scroll_direction ?? "down";
      const amount = decision.scroll_amount ?? 400;
      const delta = dir === "up" ? -amount : amount;
      const sx = decision.x > 0 ? decision.x : Math.floor(VIEWPORT.width / 2);
      const sy = decision.y > 0 ? decision.y : Math.floor(VIEWPORT.height / 2);
      await page.mouse.move(sx, sy);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(1_200);
    } else if (decision.action === "wait") {
      await page.waitForTimeout(2_000);
    } else if (decision.action === "error") {
      throw new Error(`openHistoryPanel: AI report error — ${decision.reason}`);
    }

    const stateKey = `${decision.phase}|visible=${decision.history_visible}`;
    if (stateKey === lastStateKey) {
      sameStateCount++;
      if (sameStateCount >= 4) {
        throw new Error(`openHistoryPanel: stuck in state ${stateKey}`);
      }
    } else {
      sameStateCount = 0;
      lastStateKey = stateKey;
    }
    lastAction = { action: decision.action, reason: decision.reason, phase: decision.phase };
  }
  throw new Error(`openHistoryPanel: không mở được history trong ${maxIter} iterations`);
}

export async function readHistoryRows(page: Page): Promise<HistoryRow[]> {
  const store = getScreenshotStore();
  const shotPath = await store.take(page, "history-transcribe");
  return transcribeHistoryRows({ screenshotPath: shotPath });
}

export type ScreenValues = TranscribedScreenValues;

/**
 * OCR play-screen sau 1 spin để đọc các số UI (balance, bet, last_win, total_win, …).
 * Dùng để cross-check với API response (collector.spins).
 *
 * Lưu ý: canvas games render text qua WebGL/Canvas nên không thể grab DOM.
 * Vision AI là cách duy nhất; chấp nhận latency ~3-5s/call và confidence < 100%.
 */
export async function readScreenValues(page: Page, label = "screen-values"): Promise<ScreenValues> {
  const store = getScreenshotStore();
  const shotPath = await store.take(page, label);
  return transcribePlayScreenValues({ screenshotPath: shotPath });
}

export type ScreenMismatch = {
  field: "balance" | "bet" | "last_win";
  apiValue: number | null;
  uiValue: number | null;
  delta: number | null;
  tolerance: number;
  explanation: string;
};

export type ScreenAssertOptions = {
  /** Tolerance tuyệt đối khi so giá trị float (default 0.01 — chấp nhận sai số rounding 1 cent). */
  tolerance?: number;
  /** Bỏ check balance UI vs API.endingBalance. Đặt true cho game không hiển thị balance trên play screen. */
  skipBalance?: boolean;
  /** Bỏ check bet UI vs API.betAmount. Đặt true nếu UI bet đã thay đổi giữa lúc spin và lúc đọc screen. */
  skipBet?: boolean;
  /** Bỏ check last_win UI vs API.winAmount (vd cascade game UI hiển thị accumulated, không phải per-spin). */
  skipLastWin?: boolean;
};

/**
 * Cross-check 1 spin response (API ground truth) vs UI screen values (vision OCR).
 * Throw chi tiết với delta + tolerance nếu lệch.
 *
 * Use case: sau khi `doAutoSpin` xong, gọi `readScreenValues` rồi assert khớp.
 *
 *   const spin = await doAutoSpin(page, collector);
 *   const screen = await readScreenValues(page);
 *   assertScreenMatchesAPI(spin, screen, { tolerance: 0.01 });
 *
 * Logic:
 * - balance UI ≈ spin.endingBalance (if displayed)
 * - bet UI ≈ spin.betAmount (if displayed and unchanged since spin)
 * - last_win UI ≈ spin.winAmount (if displayed; null=skip)
 *
 * Mỗi field được skip nếu UI null (không hiển thị) HOẶC opts.skipXxx = true.
 */
export function assertScreenMatchesAPI(
  spin: SpinResponse,
  screen: ScreenValues,
  opts: ScreenAssertOptions = {},
): { ok: boolean; mismatches: ScreenMismatch[] } {
  const tol = opts.tolerance ?? 0.01;
  const mismatches: ScreenMismatch[] = [];

  const checkField = (
    field: "balance" | "bet" | "last_win",
    apiVal: unknown,
    uiVal: number | null,
    skip: boolean | undefined,
  ) => {
    if (skip) return;
    if (uiVal === null || uiVal === undefined) return; // UI không hiển thị → skip
    const apiNum = typeof apiVal === "number" ? apiVal : null;
    if (apiNum === null) return; // API không có → skip
    const delta = Math.abs(uiVal - apiNum);
    if (delta > tol) {
      mismatches.push({
        field,
        apiValue: apiNum,
        uiValue: uiVal,
        delta,
        tolerance: tol,
        explanation: `${field}: UI shows ${uiVal} but API says ${apiNum} (delta=${delta.toFixed(4)} > tolerance=${tol})`,
      });
    }
  };

  checkField("balance", spin.endingBalance, screen.balance, opts.skipBalance);
  checkField("bet", spin.betAmount, screen.bet, opts.skipBet);
  checkField("last_win", spin.winAmount, screen.last_win, opts.skipLastWin);

  if (mismatches.length === 0) {
    return { ok: true, mismatches: [] };
  }

  // Save diagnostic
  const store = getScreenshotStore();
  try {
    writeFileSync(
      join(store.dir, "screen-mismatch.json"),
      JSON.stringify({ spin, screen, mismatches, tolerance: tol }, null, 2),
    );
  } catch {}

  const detail = mismatches.map((m) => `  - ${m.explanation}`).join("\n");
  throw new Error(
    `assertScreenMatchesAPI: ${mismatches.length} field(s) mismatch between UI display and API response:\n${detail}\n\nDiagnostic: ${join(store.dir, "screen-mismatch.json")}`,
  );
}

export type HistoryMismatch = {
  kind: "missing" | "bet" | "win" | "balance";
  spinId: string | null;
  spinIndex: number; // 0-based position in captured
  apiBet: number | null;
  apiWin: number | null;
  apiBalance: number | null;
  apiStatus: string | null;
  uiBet: number | null;
  uiWin: number | null;
  uiBalance: number | null;
  uiRoundId: string | null;
  uiRawText: string | null;
  uiColumnHeaders: string[] | null;
  field: "bet" | "win" | "balance" | null;
  apiValue: number | null;
  uiValue: number | null;
  delta: number | null;
  explanation: string;
};

export type HistoryReport = {
  ok: boolean;
  capturedCount: number;
  rowCount: number;
  matchedCount: number;
  mismatches: HistoryMismatch[];
  screenshotDir: string;
  diagnosticFiles: {
    capturedSpins: string;
    historyRows: string;
    mismatch: string;
  };
};

/**
 * Cross-check history UI rows vs captured spin responses (ground truth).
 * Dumps 3 diagnostic JSON files vào screenshot dir (captured-spins, history-rows, history-mismatch)
 * và throw error chi tiết với per-mismatch context nếu có sai lệch.
 */
export function assertHistoryMatches(
  captured: SpinResponse[],
  rows: HistoryRow[],
  opts: { tolerance?: number; skipBalanceCheck?: boolean } = {},
): HistoryReport {
  const tol = opts.tolerance ?? 0.01;
  const store = getScreenshotStore();

  const spinsPath = join(store.dir, "captured-spins.json");
  const rowsPath = join(store.dir, "history-rows.json");
  const mismatchPath = join(store.dir, "history-mismatch.json");

  try {
    writeFileSync(spinsPath, JSON.stringify(captured, null, 2));
    writeFileSync(rowsPath, JSON.stringify(rows, null, 2));
  } catch {}

  const mismatches: HistoryMismatch[] = [];
  const usedRows = new Set<HistoryRow>();
  let matched = 0;

  const makeBase = (spin: SpinResponse, idx: number, row: HistoryRow | null): Omit<HistoryMismatch, "kind" | "field" | "apiValue" | "uiValue" | "delta" | "explanation"> => ({
    spinId:
      typeof spin.id === "string" ? spin.id : typeof spin.round === "string" ? spin.round : null,
    spinIndex: idx,
    apiBet: toNum(spin.betAmount),
    apiWin: toNum(spin.winAmount),
    apiBalance: toNum(spin.endingBalance),
    apiStatus: typeof spin.status === "string" ? spin.status : null,
    uiBet: row?.bet ?? null,
    uiWin: row?.win ?? null,
    uiBalance: row?.balance_after ?? null,
    uiRoundId: row?.round_id ?? null,
    uiRawText: row?.raw_text ?? null,
    uiColumnHeaders: row?.column_headers_detected ?? null,
  });

  if (rows.length === 0) {
    const report: HistoryReport = {
      ok: false,
      capturedCount: captured.length,
      rowCount: 0,
      matchedCount: 0,
      mismatches: [],
      screenshotDir: store.dir,
      diagnosticFiles: { capturedSpins: spinsPath, historyRows: rowsPath, mismatch: mismatchPath },
    };
    try {
      writeFileSync(mismatchPath, JSON.stringify(report, null, 2));
    } catch {}
    throw new Error(
      `History transcription returned 0 rows; expected at least ${captured.length}.\n` +
        `  The AI could not extract any row data from the history panel.\n` +
        `  Inspect the latest 'history-transcribe' screenshot in: ${store.dir}\n` +
        `  If the panel is visible, the rule-transcription prompt may need tuning for this game's layout.`,
    );
  }

  for (let i = 0; i < captured.length; i++) {
    const spin = captured[i]!;
    const spinId =
      typeof spin.id === "string" ? spin.id : typeof spin.round === "string" ? spin.round : null;
    const betA = toNum(spin.betAmount);
    const winA = toNum(spin.winAmount);
    const balA = toNum(spin.endingBalance);

    let row: HistoryRow | undefined;

    if (spinId) {
      row = rows.find((r) => {
        if (usedRows.has(r) || r.round_id == null) return false;
        return r.round_id === spinId || spinId.includes(r.round_id) || r.round_id.includes(spinId);
      });
    }
    if (!row && betA != null && winA != null) {
      row = rows.find(
        (r) =>
          !usedRows.has(r) &&
          r.bet != null &&
          Math.abs(r.bet - betA) <= tol &&
          r.win != null &&
          Math.abs(r.win - winA) <= tol,
      );
    }

    if (!row) {
      mismatches.push({
        ...makeBase(spin, i, null),
        kind: "missing",
        field: null,
        apiValue: null,
        uiValue: null,
        delta: null,
        explanation: `Spin ${spinId ?? `#${i + 1}`} has no matching row in the transcribed history UI. The AI either missed this row, the game didn't show it yet, or the history UI was paginated and this entry was below the fold.`,
      });
      continue;
    }
    usedRows.add(row);
    matched++;

    if (row.bet != null && betA != null && Math.abs(row.bet - betA) > tol) {
      mismatches.push({
        ...makeBase(spin, i, row),
        kind: "bet",
        field: "bet",
        apiValue: betA,
        uiValue: row.bet,
        delta: row.bet - betA,
        explanation: `Bet amount in UI (${row.bet}) does not equal API value (${betA}) within tolerance ${tol}. Either a display bug, or the AI transcribed the wrong column — check raw_text and column_headers below.`,
      });
    }
    if (row.win != null && winA != null && Math.abs(row.win - winA) > tol) {
      const suspicious =
        row.win < 0 ||
        (row.bet != null && Math.abs(row.win + row.bet - winA) <= tol) ||
        (row.bet != null && Math.abs(row.win - (winA - row.bet)) <= tol);
      const hint = suspicious
        ? ` SUSPICIOUS: uiWin looks like a 'net change' (win - bet) rather than raw win. AI may have read the wrong column.`
        : "";
      mismatches.push({
        ...makeBase(spin, i, row),
        kind: "win",
        field: "win",
        apiValue: winA,
        uiValue: row.win,
        delta: row.win - winA,
        explanation: `Win amount in UI (${row.win}) does not equal API value (${winA}).${hint}`,
      });
    }
    if (
      !opts.skipBalanceCheck &&
      row.balance_after != null &&
      balA != null &&
      !Number.isNaN(balA) &&
      Math.abs(row.balance_after - balA) > tol
    ) {
      mismatches.push({
        ...makeBase(spin, i, row),
        kind: "balance",
        field: "balance",
        apiValue: balA,
        uiValue: row.balance_after,
        delta: row.balance_after - balA,
        explanation: `Balance after spin in UI (${row.balance_after}) differs from API endingBalance (${balA}).`,
      });
    }
  }

  const report: HistoryReport = {
    ok: mismatches.length === 0,
    capturedCount: captured.length,
    rowCount: rows.length,
    matchedCount: matched,
    mismatches,
    screenshotDir: store.dir,
    diagnosticFiles: { capturedSpins: spinsPath, historyRows: rowsPath, mismatch: mismatchPath },
  };
  try {
    writeFileSync(mismatchPath, JSON.stringify(report, null, 2));
  } catch {}

  if (mismatches.length > 0) {
    throw new Error(formatHistoryMismatchError(report));
  }
  return report;
}

function formatHistoryMismatchError(report: HistoryReport): string {
  const lines: string[] = [];
  lines.push(
    `History mismatch: ${report.mismatches.length} issues across ${report.capturedCount} captured spins (${report.matchedCount}/${report.capturedCount} matched, UI had ${report.rowCount} rows).`,
  );
  lines.push("");

  const byKind = new Map<string, HistoryMismatch[]>();
  for (const m of report.mismatches) {
    byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  }

  for (const [kind, items] of byKind) {
    lines.push(`─── ${items.length}× ${kind.toUpperCase()} ───`);
    for (const m of items) {
      lines.push("");
      lines.push(`  [spin #${m.spinIndex + 1}]  id=${m.spinId ?? "(none)"}`);
      lines.push(
        `    API:  bet=${fmtNum(m.apiBet)}  win=${fmtNum(m.apiWin)}  endingBalance=${fmtNum(m.apiBalance)}  status=${m.apiStatus ?? "(none)"}`,
      );
      if (m.uiRoundId != null || m.uiBet != null || m.uiWin != null || m.uiBalance != null) {
        lines.push(
          `    UI :  bet=${fmtNum(m.uiBet)}  win=${fmtNum(m.uiWin)}  balance=${fmtNum(m.uiBalance)}  id=${m.uiRoundId ?? "(none)"}`,
        );
      } else {
        lines.push(`    UI :  (row not found)`);
      }
      if (m.field) {
        lines.push(
          `    Diff: ${m.field.toUpperCase()} UI=${fmtNum(m.uiValue)} vs API=${fmtNum(m.apiValue)}  delta=${fmtNum(m.delta)}`,
        );
      }
      if (m.uiRawText) {
        lines.push(`    Raw UI text: ${truncate(m.uiRawText, 160)}`);
      }
      if (m.uiColumnHeaders && m.uiColumnHeaders.length) {
        lines.push(`    UI columns:  [${m.uiColumnHeaders.join(", ")}]`);
      }
      lines.push(`    Why: ${m.explanation}`);
    }
  }

  lines.push("");
  lines.push("─── Diagnostics ───");
  lines.push(`  Screenshots dir : ${report.screenshotDir}`);
  lines.push(`  Captured spins  : ${report.diagnosticFiles.capturedSpins}`);
  lines.push(`  Transcribed rows: ${report.diagnosticFiles.historyRows}`);
  lines.push(`  Mismatch report : ${report.diagnosticFiles.mismatch}`);
  lines.push(
    `  Tip: open the latest '*-history-transcribe.png' screenshot and compare it against history-rows.json to see if the AI read the wrong column (net change vs win is a common failure mode).`,
  );
  return lines.join("\n");
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtNum(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(4);
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `…`;
}

// Worker-level counter: chỉ keep browser khi đây là test CUỐI trong batch.
// QA_TOTAL_TESTS được generate-and-run set = số test() block trong file.
// Với workers=1 (mặc định của pipeline), counter module-level đủ dùng.
let _testsFinishedInWorker = 0;

/**
 * Nếu QA_KEEP_BROWSER_OPEN=1, giữ browser mở — NHƯNG CHỈ sau test case cuối cùng
 * trong batch (không block giữa 18 test). Các test trước đó: no-op, đóng bình thường.
 * Gọi ở cuối MỖI test; hàm tự biết mình có phải lần cuối hay không dựa vào QA_TOTAL_TESTS.
 * Nếu QA_TOTAL_TESTS không set → fallback: giữ mỗi test (hành vi cũ).
 */
export async function keepBrowserOpenIfRequested(page: Page): Promise<void> {
  _testsFinishedInWorker++;
  const keep = process.env.QA_KEEP_BROWSER_OPEN;
  if (keep !== "1" && keep !== "true") return;

  const total = Number(process.env.QA_TOTAL_TESTS ?? 0);
  const isLast = total > 0 ? _testsFinishedInWorker >= total : true;
  if (!isLast) {
    console.log(
      `>>> QA_KEEP_BROWSER_OPEN set nhưng đây là test ${_testsFinishedInWorker}/${total} — đóng để chạy test kế tiếp.`,
    );
    return;
  }

  test.setTimeout(0);
  console.log("\n>>> QA_KEEP_BROWSER_OPEN: Test cuối cùng — browser ở lại. Đóng cửa sổ (X) để finish.");
  await page.waitForEvent("close", { timeout: 0 });
  console.log("<<< Browser closed by user, test finishing.");
}

export function summarizeSpins(spins: SpinResponse[]): {
  count: number;
  totalBet: number;
  totalWin: number;
  rtp: number | null;
  wins: number;
  losses: number;
} {
  const count = spins.length;
  let totalBet = 0;
  let totalWin = 0;
  let wins = 0;
  let losses = 0;
  for (const s of spins) {
    totalBet += Number(s.betAmount ?? 0);
    totalWin += Number(s.winAmount ?? 0);
    if (Number(s.winAmount ?? 0) > 0) wins++;
    else losses++;
  }
  return {
    count,
    totalBet,
    totalWin,
    rtp: totalBet > 0 ? totalWin / totalBet : null,
    wins,
    losses,
  };
}
