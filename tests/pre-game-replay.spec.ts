/**
 * Synthetic smoke test for pre-game replay engine.
 *
 * Builds a mock HTML "game" with 3 layered popups + a "play screen". A
 * pre-recorded click sequence dismisses the popups in order. After replay
 * the spin button area should pixel-match the baseline → ready=true.
 *
 * Doesn't need a real game URL or token — pure DOM mock.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  savePreGameRecording,
  preGameRecordingPath,
  type PreGameRecording,
} from "../src/runner/pre-game-recording.js";
import {
  replayPreGameClicks,
  preGameWithReplayOrVision,
} from "../src/runner/pre-game-replay.js";
import { baselinePath } from "../src/runner/region-snapshot.js";
import { aggregatePreGameStats, readAllAttempts } from "../src/runner/pre-game-stats.js";

const SLUG = "__synthetic-pregame";

const MOCK_HTML = `<!doctype html>
<html><body style="margin:0;background:#0b1220;color:#fff;font:14px sans-serif">
<div id="popup1" style="position:fixed;inset:0;background:#000c;display:flex;align-items:center;justify-content:center">
  <button id="ok1" style="position:absolute;left:680px;top:430px;width:80px;height:40px">Age OK</button>
</div>
<div id="popup2" style="position:fixed;inset:0;background:#000c;display:none;align-items:center;justify-content:center">
  <button id="ok2" style="position:absolute;left:680px;top:480px;width:80px;height:40px">Continue</button>
</div>
<div id="popup3" style="position:fixed;inset:0;background:#000c;display:none;align-items:center;justify-content:center">
  <button id="ok3" style="position:absolute;left:680px;top:530px;width:80px;height:40px">Got it</button>
</div>
<div id="playscreen" style="position:fixed;inset:0;display:none;background:#0b1220">
  <div style="position:absolute;left:620px;top:760px;width:200px;height:120px;background:linear-gradient(180deg,#3b82f6,#1e40af);border-radius:60px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold">SPIN</div>
</div>
<script>
  document.getElementById('ok1').onclick = () => {
    document.getElementById('popup1').style.display = 'none';
    document.getElementById('popup2').style.display = 'flex';
  };
  document.getElementById('ok2').onclick = () => {
    document.getElementById('popup2').style.display = 'none';
    document.getElementById('popup3').style.display = 'flex';
  };
  document.getElementById('ok3').onclick = () => {
    document.getElementById('popup3').style.display = 'none';
    document.getElementById('playscreen').style.display = 'block';
  };
</script>
</body></html>`;

test.describe("Pre-game replay (synthetic)", () => {
  test.beforeAll(() => {
    // Clean any leftover fixtures
    const recPath = preGameRecordingPath(SLUG);
    const basePath = baselinePath(SLUG, "play-screen-ready");
    if (existsSync(recPath)) rmSync(recPath);
    if (existsSync(basePath)) rmSync(basePath);
  });

  test.afterAll(() => {
    // Tidy up — leave no artifacts for the synthetic slug
    const recPath = preGameRecordingPath(SLUG);
    const basePath = baselinePath(SLUG, "play-screen-ready");
    if (existsSync(recPath)) rmSync(recPath);
    if (existsSync(basePath)) rmSync(basePath);
  });

  test("captures baseline + replays clicks → ready", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Step 1: simulate the "recording" pass. We manually click each popup
    // and snapshot the play-screen-ready region as the baseline.
    await page.setContent(MOCK_HTML);
    await page.waitForTimeout(200);
    await page.mouse.click(720, 450);
    await page.waitForTimeout(150);
    await page.mouse.click(720, 500);
    await page.waitForTimeout(150);
    await page.mouse.click(720, 550);
    await page.waitForTimeout(250);

    const baselineRegion = { x: 620, y: 760, width: 200, height: 120 };
    const basePath = baselinePath(SLUG, "play-screen-ready");
    mkdirSync(dirname(basePath), { recursive: true });
    await page.screenshot({ path: basePath, clip: baselineRegion });
    expect(existsSync(basePath)).toBe(true);

    // Save the recording with the same click sequence
    const rec: PreGameRecording = {
      slug: SLUG,
      recorded_at: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      initial_wait_ms: 200,
      default_post_click_wait_ms: 150,
      clicks: [
        { delay_ms: 0, x: 720, y: 450, reason: "age gate OK" },
        { delay_ms: 150, x: 720, y: 500, reason: "continue" },
        { delay_ms: 150, x: 720, y: 550, reason: "got it" },
      ],
      ready_signal: {
        kind: "region_snapshot",
        region: baselineRegion,
        baseline_name: "play-screen-ready",
        max_diff_ratio: 0.05,
      },
    };
    savePreGameRecording(rec);

    // Step 2: simulate a fresh test session — load page anew, run replay.
    await page.setContent(MOCK_HTML);
    const result = await replayPreGameClicks(page, { slug: SLUG });
    expect(result.ready, `reason=${result.reason} diff=${result.verifyDiffRatio}`).toBe(true);
    expect(result.clicksFired).toBe(3);
    expect(result.verifyDiffRatio).toBeLessThanOrEqual(0.05);
  });

  test("missing recording → ready=false + reason", async ({ page }) => {
    const r = await replayPreGameClicks(page, { slug: "__definitely-not-recorded" });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("no_recording");
  });

  test("stats: replay success is logged with source=replay", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Re-save baseline + recording for a known-good replay
    const baselineRegion = { x: 620, y: 760, width: 200, height: 120 };
    await page.setContent(MOCK_HTML);
    await page.waitForTimeout(200);
    await page.mouse.click(720, 450);
    await page.waitForTimeout(150);
    await page.mouse.click(720, 500);
    await page.waitForTimeout(150);
    await page.mouse.click(720, 550);
    await page.waitForTimeout(250);
    const basePath = baselinePath(SLUG, "play-screen-ready");
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(basePath), { recursive: true });
    await page.screenshot({ path: basePath, clip: baselineRegion });
    savePreGameRecording({
      slug: SLUG,
      recorded_at: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      initial_wait_ms: 200,
      default_post_click_wait_ms: 150,
      clicks: [
        { delay_ms: 0, x: 720, y: 450, reason: "age" },
        { delay_ms: 150, x: 720, y: 500, reason: "continue" },
        { delay_ms: 150, x: 720, y: 550, reason: "got it" },
      ],
      ready_signal: {
        kind: "region_snapshot",
        region: baselineRegion,
        baseline_name: "play-screen-ready",
        max_diff_ratio: 0.05,
      },
    });

    const beforeCount = readAllAttempts().filter((a) => a.slug === SLUG).length;

    // Force vision to be impossible — clear creds; combo helper should still
    // succeed via replay alone (the fallback path is skipped on replay success).
    await page.setContent(MOCK_HTML);
    const result = await preGameWithReplayOrVision(page, {
      slug: SLUG,
      viewport: { width: 1440, height: 900 },
    });

    expect(result.ready).toBe(true);
    expect(result.source).toBe("replay");

    const after = readAllAttempts().filter((a) => a.slug === SLUG);
    expect(after.length).toBe(beforeCount + 1);
    const last = after[after.length - 1]!;
    expect(last.source).toBe("replay");
    expect(last.ready).toBe(true);
    expect(last.is_fallback).toBe(false);
    expect(typeof last.duration_ms).toBe("number");

    // Aggregate visible
    const agg = aggregatePreGameStats(SLUG);
    expect(agg.length).toBe(1);
    expect(agg[0]!.bySource.replay).toBeGreaterThanOrEqual(1);
  });

  test("baseline mismatch → ready=false (caller can fall back)", async ({ page }) => {
    // Reuse the recording from the first test — but skip the popup clicks so
    // the play screen never renders. Region snapshot should disagree with baseline.
    await page.setViewportSize({ width: 1440, height: 900 });

    // Re-save recording (afterAll might have wiped between tests; safer to re-init)
    const baselineRegion = { x: 620, y: 760, width: 200, height: 120 };
    const basePath = baselinePath(SLUG, "play-screen-ready");
    if (!existsSync(basePath)) {
      // Quick re-capture
      await page.setContent(MOCK_HTML);
      await page.waitForTimeout(200);
      await page.mouse.click(720, 450);
      await page.waitForTimeout(150);
      await page.mouse.click(720, 500);
      await page.waitForTimeout(150);
      await page.mouse.click(720, 550);
      await page.waitForTimeout(250);
      mkdirSync(dirname(basePath), { recursive: true });
      await page.screenshot({ path: basePath, clip: baselineRegion });
    }
    // Unconditionally overwrite — test 1 saved a working recording that we
    // don't want here.
    savePreGameRecording({
      slug: SLUG,
      recorded_at: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      initial_wait_ms: 200,
      default_post_click_wait_ms: 150,
      clicks: [
        // Point clicks at empty space — popups won't dismiss
        { delay_ms: 0, x: 10, y: 10, reason: "noop" },
      ],
      ready_signal: {
        kind: "region_snapshot",
        region: baselineRegion,
        baseline_name: "play-screen-ready",
        max_diff_ratio: 0.05,
      },
    });

    await page.setContent(MOCK_HTML);
    const r = await replayPreGameClicks(page, { slug: SLUG });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/region_mismatch/);
  });
});
