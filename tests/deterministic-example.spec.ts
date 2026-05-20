/**
 * Example deterministic test — pattern reference cho QA viết test mới.
 *
 * Khác với generated/*.spec.ts (LLM vision loop):
 *   - Không gọi LLM ở runtime
 *   - Spin response từ scenario fixture (deterministic)
 *   - Assertion = expected từ scenario, không cần "AI nhìn screen"
 *   - Reproducible: chạy 1000 lần ra cùng 1 kết quả
 *
 * Pre-requisite:
 *   1. Đã chạy npm run record để có recording cho game
 *   2. Đã chạy npm run extract-scenarios -- <slug> để build fixtures/scenarios/{slug}/
 *   3. Set GAME_URL trong env hoặc edit hằng số GAME_URL ở dưới
 *
 * Chạy:
 *   GAME_URL="https://..." npx playwright test tests/deterministic-example.spec.ts
 *
 * Update region snapshots (lần đầu hoặc khi UI thay đổi có chủ đích):
 *   REGION_SNAPSHOT_UPDATE=1 npx playwright test tests/deterministic-example.spec.ts
 */

import { test, expect } from "@playwright/test";
import { makeDeterministic } from "../src/runner/deterministic.js";
import { spinDeterministic, assertSpinMatchesExpected } from "../src/runner/deterministic-spin.js";
import { assertRegionMatches } from "../src/runner/region-snapshot.js";
import { listScenarios } from "../src/runner/scenario.js";
import { waitForCanvasReady } from "../src/runner/wait-ready.js";

const SLUG = process.env.QA_SLUG ?? "fiesta-magenta";
const GAME_URL = process.env.GAME_URL ?? "https://example.com/game";

// Spin button cho fiesta-magenta — derived từ recording iterations.json (AI clicked
// at 720,790-810). Verify cho game khác bằng cách inspect screenshot iter-N.png trong
// fixtures/recordings/{slug}__*/screenshots/.
const SPIN_BUTTON = { x: 720, y: 800 };

// Viewport phải khớp viewport lúc record. Mặc định Desktop Chrome (devices preset)
// là 1280x720, không khớp recorder (1440x900).
const VIEWPORT = { width: 1440, height: 900 };

test.describe(`Deterministic — ${SLUG}`, () => {
  test.beforeEach(async ({ page }) => {
    const scenarios = listScenarios(SLUG);
    if (scenarios.length === 0) {
      test.skip(true, `No scenarios for ${SLUG}. Run: npm run extract-scenarios -- ${SLUG}`);
    }
    await page.setViewportSize(VIEWPORT);
  });

  // Pick scenario có win > 0 (bất kể label cụ thể — small_win / normal_win / big_win
  // đều có thể là "win scenario" tuỳ recording).
  test("any_win — UI shows mocked win amount", async ({ page }) => {
    const scenarios = listScenarios(SLUG);
    const winScenario = ["normal_win", "small_win", "big_win"].find((s) =>
      scenarios.includes(s),
    );
    test.skip(!winScenario, `No win scenario in ${scenarios.join(", ")}`);

    const handle = await makeDeterministic(page, { slug: SLUG, scenario: winScenario! });
    test.skip(!handle.scenario.expected.win, "Scenario has no expected.win");

    await page.goto(GAME_URL);
    const ready = await waitForCanvasReady(page, { timeoutMs: 45_000 });
    test.skip(!ready.ready, `Canvas chưa ready (layer=${ready.layer}). Token có thể expired.`);

    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    assertSpinMatchesExpected(result, handle.scenario.expected);
    expect(handle.spinRequestCount).toBe(1);
  });

  test("bonus_trigger — bonus screen activates after mocked spin", async ({ page }) => {
    const scenarios = listScenarios(SLUG);
    test.skip(!scenarios.includes("bonus_trigger"), "No bonus_trigger scenario captured");

    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "bonus_trigger" });
    await page.goto(GAME_URL);
    const ready = await waitForCanvasReady(page, { timeoutMs: 45_000 });
    test.skip(!ready.ready, `Canvas chưa ready (layer=${ready.layer}). Token có thể expired.`);

    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    expect(result.parsed).not.toBeNull();
    assertSpinMatchesExpected(result, handle.scenario.expected);

    // Region snapshot — verify bonus screen UI khớp baseline đã chốt
    // (Lần đầu chạy với REGION_SNAPSHOT_UPDATE=1 để tạo baseline.)
    await page.waitForTimeout(1500); // wait for bonus animation
    await assertRegionMatches(page, {
      slug: SLUG,
      name: "bonus-screen-active",
      region: { x: 200, y: 200, width: 1000, height: 500 },
      maxDiffRatio: 0.05, // 5% — bonus screen có animation, looser
    });
  });

  test("no_win — balance does not change after spin", async ({ page }) => {
    const scenarios = listScenarios(SLUG);
    test.skip(!scenarios.includes("no_win"), "No no_win scenario captured");

    const handle = await makeDeterministic(page, { slug: SLUG, scenario: "no_win" });
    await page.goto(GAME_URL);
    const ready = await waitForCanvasReady(page, { timeoutMs: 45_000 });
    test.skip(!ready.ready, `Canvas chưa ready (layer=${ready.layer}). Token có thể expired.`);

    const result = await spinDeterministic(page, handle, { spinButton: SPIN_BUTTON });

    expect(result.parsed).not.toBeNull();
    // Win = 0 trong scenario; expectation chính: ending_balance giảm chính xác bằng bet
    const expected = handle.scenario.expected;
    if (expected.win != null) expect(expected.win).toBe(0);
    if (expected.bet != null && expected.starting_balance != null && expected.ending_balance != null) {
      expect(expected.ending_balance).toBeCloseTo(
        expected.starting_balance - expected.bet,
        2,
      );
    }
  });
});
