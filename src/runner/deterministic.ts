/**
 * Deterministic test runtime — biến canvas slot game flaky thành test
 * reproducible. Là LỚP NỀN MÓNG cho snapshot, statistical, codegen layers.
 *
 * Cách dùng:
 *   import { makeDeterministic } from "../src/runner/deterministic.js";
 *   await makeDeterministic(page, { slug: "fiesta-magenta", scenario: "bonus_trigger" });
 *   await page.goto(GAME_URL);
 *   await page.click("#spinBtn");
 *   // → spin response luôn là response đã ghi trong scenario "bonus_trigger".
 *
 * Đảm bảo determinism trên 4 mặt:
 *   1. Date.now / new Date() → frozen_time_ms
 *   2. Math.random → mulberry32(seed)
 *   3. performance.now → simulated 60fps clock
 *   4. Network /spin /config /authorize → recorded response
 *
 * KHÔNG động tới existing flow (auto-play.ts, test-harness.ts). Tests cũ vẫn chạy
 * như cũ; tests mới opt-in bằng cách gọi makeDeterministic.
 */

import type { Page, Route } from "playwright";
import { loadScenario, type Scenario, type SpinResponseFixture } from "./scenario.js";
import {
  synthesizeBody,
  synthesizeCascadeChain,
  synthesizeFreeSpinChain,
  type SpinOverrides,
} from "./response-synthesizer.js";
import type { GameAdapter } from "../adapters/types.js";

export type MakeDeterministicOpts = {
  slug: string;
  /** Tên scenario (vd "bonus_trigger") — load từ fixtures/scenarios/{slug}/{scenario}.json. */
  scenario: string;
  /** Override frozen time (ms). Default lấy từ scenario.frozen_time_ms. */
  frozenTimeMs?: number;
  /** Override seed cho Math.random. Default lấy từ scenario.random_seed. */
  randomSeed?: number;
  /** Tắt freeze performance.now (giữ real timing, vẫn freeze Date/Math). */
  freezePerformanceNow?: boolean;
  /**
   * Chỉ mock /spin endpoint, để authorize/config/balance đi qua server thật.
   * Default false (mock cả prelude).
   *
   * Dùng cho hybrid flow: game cần authorize/config thật để load tới play screen,
   * chỉ spin response mới deterministic. Prelude mock cũ có thể trả response
   * stale (token cũ, balance cũ) → game không qua nổi pre-game.
   */
  spinOnly?: boolean;
  /**
   * Skip injecting Date/Math/performance freeze script. Default false (freeze).
   *
   * Set true khi game session validation phụ thuộc realtime timestamp
   * (frozen time → server reject "stale request" / canvas event handler
   * không bind do anti-cheat). Trade-off: spin response vẫn deterministic
   * nhưng timing UI có thể vary.
   */
  noFreeze?: boolean;
  /**
   * Override fields trong spin response body. Template = scenario.spin_response.body,
   * synthesizer modify các field listed (bet, win, balance, isFreeSpin, ...)
   * giữ nguyên phần còn lại (matrix, winlines, etc.).
   *
   * Use case:
   *   - Test custom bet level mà recording không có
   *   - Force outcome (vd test max win cap = win bet × 5000)
   *   - Test free spin từ scenario base game
   */
  responseOverrides?: SpinOverrides;
  /**
   * Generate cascade chain: 1 click Spin → N response cascade.
   * Đè lên spin_response — replace với N synthesized responses.
   *
   * Format: array of win amount per cascade step.
   * Vd [0.5, 1.2, 2.0] = 3 cascade với win lần lượt, total = 3.7.
   */
  cascadeWins?: number[];
  /**
   * Generate free spin chain: emit N responses cho free spin rounds.
   * Mỗi click sau cascadeWins (hoặc spin chính) sẽ trả 1 free spin response.
   *
   * Format: array of win amount per free spin.
   * Vd [0, 5, 0, 12, 50] = 5 free spin với win lần lượt.
   */
  freeSpinWins?: number[];
  /**
   * Optional Wild multiplier per free spin (accumulate). Tương ứng index của freeSpinWins.
   */
  freeSpinMultipliers?: number[];
  /**
   * Snapshot balance khi bắt đầu spin chain (dùng để compute ending balance).
   * Auto-detect từ template nếu không set.
   */
  startingBalance?: number;
  /**
   * Optional GameAdapter. If provided, adapter.shouldMockRoute() decides
   * whether each route gets mocked or falls through to real server.
   * Falls back to legacy `fallbackIfNonSpinPpRequest` heuristic when null.
   */
  adapter?: GameAdapter | null;
};

export type DeterministicHandle = {
  scenario: Scenario;
  /** Số request đã match trên spin endpoint. */
  spinRequestCount: number;
  /**
   * Effective response sequence after responseOverrides / cascadeWins / freeSpinWins
   * were applied. Mock route returns from this array. `spinDeterministic` reads
   * from here to get the body the GAME actually saw (not the raw scenario file).
   */
  effectiveSequence: SpinResponseFixture[];
  /** Cleanup: gỡ tất cả route handlers đã đăng ký. */
  dispose: () => Promise<void>;
};

const PRELUDE_PATTERNS = {
  authorize: /authorize-game|\/authorize\b/i,
  config: /\/config\b|\/gs2c\/.*Settings|\/init\b/i,
  balance: /\/balance\b|\/wallet\b/i,
};

/**
 * Mount deterministic runtime lên page. PHẢI gọi TRƯỚC page.goto(GAME_URL)
 * để init script kịp inject vào trang.
 */
export async function makeDeterministic(
  page: Page,
  opts: MakeDeterministicOpts,
): Promise<DeterministicHandle> {
  const scenario = loadScenario(opts.slug, opts.scenario);
  const frozenTime = opts.frozenTimeMs ?? scenario.frozen_time_ms;
  const seed = opts.randomSeed ?? scenario.random_seed;
  const freezePerf = opts.freezePerformanceNow ?? true;

  if (!opts.noFreeze) {
    await page.addInitScript(buildInitScript({ frozenTime, seed, freezePerf }));
  }

  // Build response sequence theo priority:
  // 1. cascadeWins → synthesize N cascade responses
  // 2. freeSpinWins → synthesize N free spin responses (sau cascade nếu có)
  // 3. responseOverrides → modify 1 spin response
  // 4. fallback: scenario.spin_sequence ?? [scenario.spin_response]
  const sequence = buildResponseSequence(scenario, opts);

  const handle: DeterministicHandle = {
    scenario,
    spinRequestCount: 0,
    effectiveSequence: sequence,
    dispose: async () => {
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    },
  };

  // Prelude — authorize/config/balance trả response đã ghi. Phải register
  // TRƯỚC spin endpoint vì routes match theo thứ tự đăng ký gần nhất trước.
  // SKIP nếu spinOnly=true (hybrid flow cần real authorize/config).
  if (!opts.spinOnly) {
    if (scenario.prelude?.authorize) {
      await page.route(PRELUDE_PATTERNS.authorize, makeRouteHandler(scenario.prelude.authorize));
    }
    if (scenario.prelude?.config) {
      await page.route(PRELUDE_PATTERNS.config, makeRouteHandler(scenario.prelude.config));
    }
    if (scenario.prelude?.balance) {
      await page.route(PRELUDE_PATTERNS.balance, makeRouteHandler(scenario.prelude.balance));
    }
  }

  // Spin endpoint — dùng url_pattern từ scenario (regex string).
  const spinPattern = new RegExp(scenario.spin_response.url_pattern, "i");

  await page.route(spinPattern, async (route: Route) => {
    if (await fulfillPreflightIfNeeded(route)) return;
    // Cross-provider quirk: PP gs2c/gameService endpoint dùng cho BOTH init + spin.
    // Mock spin response cho init request → game crash (null paytable → null[0]).
    // Adapter-aware path (preferred); legacy fn as fallback.
    if (opts.adapter?.shouldMockRoute) {
      const decision = opts.adapter.shouldMockRoute({
        url: route.request().url(),
        method: route.request().method(),
        postData: route.request().postData() ?? null,
      });
      if (decision === false) {
        await route.fallback();
        return;
      }
    } else if (await fallbackIfNonSpinPpRequest(route)) {
      return;
    }
    const idx = Math.min(handle.spinRequestCount, sequence.length - 1);
    const fixture = sequence[idx]!;
    handle.spinRequestCount++;
    await fulfillRoute(route, fixture);
  });

  return handle;
}

/**
 * Pragmatic Play (gs2c) endpoint quirk: `gameService` serves init + spin + settings + bonus.
 * Body param `a=doSpin` cho spin; `a=doInit` / `a=doSettings` / `a=doBonus` cho non-spin.
 *
 * Nếu non-spin request → fallback() để pass through tới real server. Game init
 * sẽ nhận response đúng, không crash.
 */
async function fallbackIfNonSpinPpRequest(route: Route): Promise<boolean> {
  const req = route.request();
  const url = req.url();
  if (!/\/gs2c\//i.test(url)) return false; // không phải PP — original behavior

  const body = req.postData() ?? "";
  // PP request markers cho non-spin action
  const isNonSpin = /[?&]a=do(Init|Settings|Bonus|Auth|History|Logout|Heartbeat)/i.test(body)
    || /[?&]a=do(Init|Settings|Bonus|Auth|History|Logout|Heartbeat)/i.test(url);
  // Hoặc: thiếu spin-specific params (c=bet, bl=betlevel)
  const hasSpinParams = /[?&]c=[\d.]/i.test(body) && /[?&]bl=\d/i.test(body);

  if (isNonSpin || !hasSpinParams) {
    // Pass through to real server. Mock không động.
    await route.fallback();
    return true;
  }
  return false;
}

function makeRouteHandler(fixture: SpinResponseFixture) {
  return async (route: Route) => {
    if (await fulfillPreflightIfNeeded(route)) return;
    await fulfillRoute(route, fixture);
  };
}

/**
 * Browser gửi CORS preflight (OPTIONS) trước cross-origin POST với
 * content-type không phải simple-type. Route handler phải trả 200 với
 * Access-Control-Allow-* headers cho OPTIONS, không thì preflight fail,
 * POST không bao giờ fire.
 *
 * Return true nếu route đã được fulfill (caller skip phần POST handling).
 */
async function fulfillPreflightIfNeeded(route: Route): Promise<boolean> {
  const req = route.request();
  if (req.method() !== "OPTIONS") return false;
  await route.fulfill({
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "86400",
    },
    body: "",
  });
  return true;
}

async function fulfillRoute(route: Route, fixture: SpinResponseFixture): Promise<void> {
  // Đảm bảo CORS headers có trong response — game pages từ origin khác (CDN)
  // sẽ gặp CORS block nếu thiếu, dù recorded response đã có thì caller upstream
  // cũng có khi strip. Inject defensive.
  const headers = { ...fixture.headers };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "access-control-allow-origin")) {
    headers["access-control-allow-origin"] = "*";
  }
  await route.fulfill({
    status: fixture.status,
    headers,
    body: fixture.body,
  });
}

/**
 * Inject vào main world của trang qua addInitScript. Chạy TRƯỚC mọi script của
 * game → game thấy Date/Math/performance đã bị override.
 *
 * mulberry32: PRNG 32-bit nhỏ gọn, period 2^32. Đủ cho test (không phải crypto).
 */
function buildInitScript(args: {
  frozenTime: number;
  seed: number;
  freezePerf: boolean;
}): string {
  return `
(() => {
  const FROZEN = ${args.frozenTime};
  let _seed = ${args.seed} >>> 0;
  const mulberry32 = () => {
    _seed = (_seed + 0x6D2B79F5) >>> 0;
    let t = _seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Date.now()
  const _origDateNow = Date.now;
  Date.now = () => FROZEN;
  // new Date() / new Date(undefined)
  const _OrigDate = Date;
  function FrozenDate(...args) {
    if (args.length === 0) return new _OrigDate(FROZEN);
    return new _OrigDate(...args);
  }
  FrozenDate.now = () => FROZEN;
  FrozenDate.parse = _OrigDate.parse;
  FrozenDate.UTC = _OrigDate.UTC;
  FrozenDate.prototype = _OrigDate.prototype;
  // @ts-ignore
  globalThis.Date = new Proxy(_OrigDate, {
    construct(target, args) {
      if (args.length === 0) return new target(FROZEN);
      return new target(...args);
    },
    apply(target, thisArg, args) {
      if (args.length === 0) return new target(FROZEN).toString();
      return target.apply(thisArg, args);
    },
    get(target, prop) {
      if (prop === 'now') return () => FROZEN;
      return target[prop];
    },
  });

  // Math.random
  Math.random = mulberry32;

  ${args.freezePerf
    ? `
  // performance.now() — simulate 60fps
  let _perfNow = 0;
  const _origPerfNow = performance.now.bind(performance);
  performance.now = () => {
    _perfNow += 16.6667;
    return _perfNow;
  };

  // requestAnimationFrame → fire ngay với simulated timestamp
  const _origRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    return setTimeout(() => cb(performance.now()), 0);
  };
  `
    : ""}

  // Đánh dấu để code app có thể check (vd skip thật analytics)
  globalThis.__DETERMINISTIC__ = true;
})();
`;
}

/**
 * Build response sequence từ scenario + opts. Priority:
 *  1. cascadeWins → synthesize cascade chain
 *  2. freeSpinWins → append free spin responses
 *  3. responseOverrides → apply lên spin_response
 *  4. Fallback: scenario.spin_sequence ?? [scenario.spin_response]
 */
function buildResponseSequence(
  scenario: Scenario,
  opts: MakeDeterministicOpts,
): SpinResponseFixture[] {
  const template = scenario.spin_response;
  const seq: SpinResponseFixture[] = [];

  // Detect starting balance từ body nếu chưa set
  const startingBalance =
    opts.startingBalance ?? extractBalance(template.body) ?? 0;

  // Phase 2: Cascade chain
  if (opts.cascadeWins && opts.cascadeWins.length > 0) {
    const bet = opts.responseOverrides?.bet ?? 5; // sensible default
    const bodies = synthesizeCascadeChain(template.body, opts.cascadeWins, bet, startingBalance);
    for (const body of bodies) {
      seq.push({ ...template, body });
    }
  } else if (opts.responseOverrides) {
    // Phase 1: Single-spin override
    const body = synthesizeBody(template.body, opts.responseOverrides);
    seq.push({ ...template, body });
  } else {
    // Fallback: scenario as-is
    const base = scenario.spin_sequence ?? [scenario.spin_response];
    seq.push(...base);
  }

  // Phase 2: Free spin chain appended
  if (opts.freeSpinWins && opts.freeSpinWins.length > 0) {
    const baseBet = opts.responseOverrides?.bet ?? 5;
    const balanceAfterCascade = startingBalance +
      (opts.responseOverrides?.win ?? 0) -
      (opts.responseOverrides?.bet ?? 0);
    const fsBodies = synthesizeFreeSpinChain(
      template.body,
      opts.freeSpinWins,
      baseBet,
      balanceAfterCascade,
      opts.freeSpinMultipliers,
    );
    for (const body of fsBodies) {
      seq.push({ ...template, body });
    }
  }

  return seq;
}

function extractBalance(body: string): number | null {
  const m = body.match(/[?&]?balance=([\d.]+)/);
  if (m) return Number(m[1]);
  try {
    const obj = JSON.parse(body);
    if (typeof obj?.balance === "number") return obj.balance;
    if (typeof obj?.endingBalance === "number") return obj.endingBalance;
    if (typeof obj?.startingBalance === "number") return obj.startingBalance;
  } catch {}
  return null;
}

/**
 * Helper: chờ tới khi đã có N spin request match. Dùng thay page.waitForResponse
 * khi mock — vì response trả synchronously, listener bình thường vẫn fire.
 */
export async function waitForMockedSpins(
  handle: DeterministicHandle,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (handle.spinRequestCount >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForMockedSpins: timeout — got ${handle.spinRequestCount}/${count} spin requests in ${timeoutMs}ms`,
  );
}
