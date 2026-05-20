/**
 * Integration test cho deterministic layer — không cần game thật, không cần token.
 *
 * Tự host 1 trang HTML mini giả lập slot game UI:
 *   - <button id="spin"> để click
 *   - fetch('/spin') khi click → kết quả render vào DOM
 *   - Date.now() / Math.random() được dùng để verify freeze hoạt động
 *
 * Mục tiêu test:
 *   1. makeDeterministic() inject init script TRƯỚC page.goto
 *   2. Spin route được mock → response từ scenario
 *   3. spinDeterministic() click → fire request → return parsed
 *   4. assertSpinMatchesExpected() validate
 *   5. JSON snapshot lưu + verify response shape
 *   6. Region snapshot tạo baseline lần đầu, match lần sau
 *
 * Đây là test cho TOOL, không phải test cho game cụ thể. Pass = deterministic
 * layer đã wire đúng. Game thật là 1 layer khác.
 *
 * Chạy:
 *   npx playwright test tests/deterministic-integration.spec.ts
 *
 * Lần đầu sẽ tạo region + JSON snapshot baselines. Lần sau verify.
 */

import { test, expect } from "@playwright/test";
import { makeDeterministic } from "../src/runner/deterministic.js";
import {
  spinDeterministic,
  assertSpinMatchesExpected,
} from "../src/runner/deterministic-spin.js";
import { assertRegionMatches } from "../src/runner/region-snapshot.js";
import { assertJsonSnapshot } from "../src/runner/json-snapshot.js";

const SLUG = "fiesta-magenta";

// Mini HTML giả lập game canvas — set via page.setContent() để có origin
// thực tế (about:blank) thay vì data: URL (origin "null" gây quirk với fetch).
const MOCK_HTML = `<!doctype html>
<html><body style="margin:0;background:#222;color:#fff;font:14px sans-serif">
  <div id="reels" style="width:1440px;height:600px;background:#444;text-align:center;padding-top:280px">REELS</div>
  <div style="text-align:center;padding:20px">
    <div>Balance: <span id="balance">—</span></div>
    <div>Last win: <span id="win">—</span></div>
    <div>Bet: <span id="bet">—</span></div>
  </div>
  <button id="spin" style="position:absolute;left:680px;top:780px;width:80px;height:80px;border-radius:40px;background:gold">SPIN</button>
  <pre id="log" style="position:absolute;left:10px;top:850px;font-size:11px"></pre>
  <script>
    const log = (s) => { document.getElementById('log').textContent += s + "\\n"; console.log(s); };
    log('time=' + Date.now());
    log('rand=' + Math.random().toFixed(6));
    document.getElementById('spin').addEventListener('click', async () => {
      log('click');
      try {
        const res = await fetch('https://api.dev.revenge-games.com/fiesta-magenta/spin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        log('response: win=' + data.winAmount + ' bal=' + data.endingBalance);
        document.getElementById('balance').textContent = data.endingBalance;
        document.getElementById('win').textContent = data.winAmount;
        document.getElementById('bet').textContent = data.betAmount;
      } catch (e) {
        log('fetch error: ' + e.message);
      }
    });
  </script>
</body></html>`;

async function loadMockPage(page: import("playwright").Page) {
  // Viewport phải đủ lớn cho button at y=780. Default Desktop Chrome chỉ 1280x720.
  await page.setViewportSize({ width: 1440, height: 900 });
  // about:blank trước → addInitScript chạy → setContent inject HTML.
  // Tránh data: URL vì origin "null" có quirk với CORS.
  await page.goto("about:blank");
  await page.setContent(MOCK_HTML);
}

const SPIN_BUTTON = { x: 720, y: 820 };

test.describe("Deterministic layer integration", () => {
  test("freeze: Date.now() returns scenario.frozen_time_ms", async ({ page }) => {
    await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    const t = await page.evaluate(() => Date.now());
    expect(t).toBe(1_735_689_600_000); // scenario.frozen_time_ms default
  });

  test("freeze: Math.random() reproducible across runs", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    const r1 = await page.evaluate(() =>
      Array.from({ length: 5 }, () => Math.random()),
    );

    await page.goto("about:blank");
    await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    const r2 = await page.evaluate(() =>
      Array.from({ length: 5 }, () => Math.random()),
    );

    expect(r1).toEqual(r2); // cùng seed → cùng dãy
    expect(handle.scenario.random_seed).toBe(42);
  });

  test("mock: fetch('/spin') returns scenario response", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);

    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    expect(result.parsed).not.toBeNull();
    expect(handle.spinRequestCount).toBe(1);
    expect((result.parsed as any).winAmount).toBe(handle.scenario.expected.win);
  });

  test("assertion: spin matches expected from scenario", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);

    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });
    assertSpinMatchesExpected(result, handle.scenario.expected);
  });

  test("UI propagation: balance/win/bet rendered từ mocked response", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    // UI đã render value từ response → đọc DOM
    const balance = await page.locator("#balance").innerText();
    const win = await page.locator("#win").innerText();
    const bet = await page.locator("#bet").innerText();

    expect(Number(balance)).toBeCloseTo(handle.scenario.expected.ending_balance!, 2);
    expect(Number(win)).toBe(handle.scenario.expected.win);
    expect(Number(bet)).toBe(handle.scenario.expected.bet);
  });

  test("JSON snapshot: response shape stable across runs", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    // Mask field thay đổi mỗi run (id, round, timestamp, player). Mode "structural"
    // chỉ check shape — ok với value khác miễn type khớp.
    assertJsonSnapshot(result.parsed, {
      slug: SLUG,
      name: "spin-response-shape-no-win",
      mask: ["id", "round", "player", "playerNickname"],
      mode: "structural",
    });
  });

  test("region snapshot: spin button area stable", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);
    await page.waitForLoadState("networkidle");

    // Capture spin button vùng — vì game synthetic và determinism freeze,
    // pixel-perfect identical across runs.
    await assertRegionMatches(page, {
      slug: `${SLUG}-integration`,
      name: "spin-button-idle",
      region: { x: 680, y: 780, width: 100, height: 100 },
      maxDiffRatio: 0.01,
    });
  });

  test("sequence: multiple spins return same response (no rotation)", async ({ page }) => {
    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await loadMockPage(page);

    const r1 = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });
    const r2 = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });
    const r3 = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    expect(handle.spinRequestCount).toBe(3);
    // Cùng scenario, không có spin_sequence → mỗi request trả response duy nhất
    expect((r1.parsed as any).winAmount).toBe((r2.parsed as any).winAmount);
    expect((r2.parsed as any).winAmount).toBe((r3.parsed as any).winAmount);
  });
});
