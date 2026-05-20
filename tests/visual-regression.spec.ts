import { test, expect } from "@playwright/test";
import { makeDeterministic } from "../src/runner/deterministic.js";
import { spinDeterministic } from "../src/runner/deterministic-spin.js";
import { preGameWithReplayOrVision } from "../src/runner/pre-game-replay.js";
import { listScenarios } from "../src/runner/scenario.js";
import { resolveSpinButton } from "../src/runner/spin-button-resolve.js";
import { assertRegionMatches } from "../src/runner/region-snapshot.js";

const GAME_URL = process.env.GAME_URL;
const VIEWPORT = { width: 1440, height: 900 };

async function getViewport(page: import("playwright").Page): Promise<{ width: number; height: number }> {
  const v = page.viewportSize();
  if (v && v.width > 0 && v.height > 0) return v;
  const fromWindow = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return {
    width: Math.max(320, Math.floor(fromWindow.width || 1440)),
    height: Math.max(320, Math.floor(fromWindow.height || 900)),
  };
}

function buildRegions(vp: { width: number; height: number }) {
  const spinButton = {
    x: Math.max(0, vp.width - Math.round(vp.width * 0.14)),
    y: Math.max(0, vp.height - Math.round(vp.height * 0.22)),
    width: Math.round(vp.width * 0.12),
    height: Math.round(vp.height * 0.18),
  };
  const reels = {
    x: Math.round(vp.width * 0.19),
    y: Math.round(vp.height * 0.1),
    width: Math.round(vp.width * 0.62),
    height: Math.round(vp.height * 0.69),
  };
  return { spinButton, reels };
}

function slugFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (p) return p;
  } catch {}
  throw new Error("Unable to infer slug from GAME_URL");
}

function pickScenario(slug: string): string | null {
  const names = listScenarios(slug);
  if (names.length === 0) return null;
  if (names.includes("no_win")) return "no_win";
  return names[0] ?? null;
}

test.describe("visual regression critical", () => {
  test.setTimeout(180_000);
  test.skip(!GAME_URL, "Set GAME_URL to run visual regression suite");

  test("critical-idle-spin-button-region", async ({ page }) => {
    const slug = slugFromUrl(GAME_URL!);
    const scenario = pickScenario(slug);
    test.skip(!scenario, `No scenario found for ${slug}`);

    await makeDeterministic(page, {
      slug,
      scenario: scenario!,
      spinOnly: true,
      noFreeze: true,
    });

    await page.goto(GAME_URL!);
    const ready = await preGameWithReplayOrVision(page, {
      slug,
      viewport: VIEWPORT,
      label: "visual-idle",
    });
    expect(ready.ready, `pre-game not ready (source=${ready.source})`).toBe(true);

    const vp = await getViewport(page);
    const regions = buildRegions(vp);

    await assertRegionMatches(page, {
      slug,
      name: "critical-idle-spin-button-v2",
      region: regions.spinButton,
      maxDiffRatio: 0.03,
      maskRegions: [],
    });
  });

  test("critical-post-spin-reels-region", async ({ page }) => {
    const slug = slugFromUrl(GAME_URL!);
    const scenario = pickScenario(slug);
    test.skip(!scenario, `No scenario found for ${slug}`);

    const handle = await makeDeterministic(page, {
      slug,
      scenario: scenario!,
      spinOnly: true,
      noFreeze: true,
    });

    await page.goto(GAME_URL!);
    const ready = await preGameWithReplayOrVision(page, {
      slug,
      viewport: VIEWPORT,
      label: "visual-post-spin",
    });
    expect(ready.ready, `pre-game not ready (source=${ready.source})`).toBe(true);

    const sb = resolveSpinButton(ready, { x: 1120, y: 840 });
    await spinDeterministic(page, handle, {
      spinButton: sb.coord,
      retry: { attempts: 4, waitMs: 1500 },
    });

    await page.waitForTimeout(1200);

    const vp = await getViewport(page);
    const regions = buildRegions(vp);

    await assertRegionMatches(page, {
      slug,
      name: "critical-post-spin-reels-v2",
      region: regions.reels,
      maxDiffRatio: 0.05,
      maskRegions: [],
    });
  });
});
