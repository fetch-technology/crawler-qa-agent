/**
 * Deterministic pre-game replay — replace LLM-driven pre-game dismissal with
 * recorded click sequence.
 *
 * Usage:
 *   const result = await replayPreGameClicks(page, { slug: "fiesta-magenta" });
 *   if (!result.ready) {
 *     // Fallback to vision flow
 *     await waitForGamePlayScreen(page, { ... });
 *   }
 *
 * Verification: after all clicks fire, region-snapshot the play-screen-ready
 * area and pixel-diff against the baseline captured during the original
 * vision-driven recording. If diff > max_diff_ratio → ready=false, caller
 * should fall back to vision.
 */

import type { Page } from "playwright";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import {
  loadPreGameRecording,
  savePreGameRecording,
  type PreGameClick,
  type PreGameRecording,
} from "./pre-game-recording.js";
import { applyMask, baselinePath, loadMaskRegions, type MaskRegion } from "./region-snapshot.js";
import { logPreGameAttempt } from "./pre-game-stats.js";
import type { SpinButtonBbox } from "../ai/vision.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { waitForCanvasReady } from "./wait-ready.js";

export type ReplayResult = {
  ready: boolean;
  clicksFired: number;
  verifyDiffRatio: number | null;
  reason: string;
};

export type ReplayOpts = {
  slug: string;
  /** Cap on total replay time (safety). Default 60s. */
  timeoutMs?: number;
  /** Skip ready-signal verification. Default false. */
  skipVerify?: boolean;
};

export async function replayPreGameClicks(page: Page, opts: ReplayOpts): Promise<ReplayResult> {
  const rec = loadPreGameRecording(opts.slug);
  if (!rec) {
    return {
      ready: false,
      clicksFired: 0,
      verifyDiffRatio: null,
      reason: "no_recording",
    };
  }

  console.log(
    `[pre-game-replay] ${opts.slug}: ${rec.clicks.length} click(s) to replay (recorded ${rec.recorded_at})`,
  );

  // Zero-click recording means play-screen was already ready during capture.
  // Do not force region-verify here because some masks can fully cover the
  // snapshot area and trigger false negatives (mask_too_aggressive).
  // Still require a deterministic canvas-ready check to avoid false positives
  // on fresh isolated pages that are still on the loading screen.
  if (rec.clicks.length === 0) {
    await page.waitForTimeout(Math.min(rec.initial_wait_ms, 1_500));

    // Zero-click path has no interaction signal, so sanity-check the recorded
    // ready region directly (unmasked) to reject obvious loading screens.
    if (rec.ready_signal.kind === "region_snapshot") {
      const baselineFile = baselinePath(opts.slug, rec.ready_signal.baseline_name);
      if (existsSync(baselineFile)) {
        try {
          const actualBuf = await page.screenshot({ clip: rec.ready_signal.region });
          const actual = PNG.sync.read(actualBuf);
          const baseline = PNG.sync.read(readFileSync(baselineFile));
          if (actual.width === baseline.width && actual.height === baseline.height) {
            const diffPng = new PNG({ width: actual.width, height: actual.height });
            const diffCount = pixelmatch(
              actual.data,
              baseline.data,
              diffPng.data,
              actual.width,
              actual.height,
              { threshold: 0.1 },
            );
            const diffRatio = diffCount / Math.max(1, actual.width * actual.height);
            if (diffRatio > Math.max(rec.ready_signal.max_diff_ratio, 0.12)) {
              return {
                ready: false,
                clicksFired: 0,
                verifyDiffRatio: diffRatio,
                reason: `zero_click_region_mismatch: diff=${(diffRatio * 100).toFixed(2)}%`,
              };
            }
          }
        } catch {
          // Ignore snapshot sanity errors and continue with canvas-ready check.
        }
      }
    }

    const ready = await waitForCanvasReady(page, {
      timeoutMs: 20_000,
      skipNetworkIdle: true,
    });
    if (!ready.ready) {
      return {
        ready: false,
        clicksFired: 0,
        verifyDiffRatio: null,
        reason: `zero_click_canvas_not_ready:${ready.layer}`,
      };
    }
    return {
      ready: true,
      clicksFired: 0,
      verifyDiffRatio: null,
      reason: "zero_click_recording",
    };
  }

  // Initial wait — let page settle before first click
  await page.waitForTimeout(rec.initial_wait_ms);

  let fired = 0;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  for (const click of rec.clicks) {
    if (Date.now() - started > timeoutMs) {
      return {
        ready: false,
        clicksFired: fired,
        verifyDiffRatio: null,
        reason: "timeout",
      };
    }
    // Honor the per-click delay (relative to previous click).
    // Skip the first click's initial delay since we already waited initial_wait_ms above.
    if (fired > 0 && click.delay_ms > 0) {
      await page.waitForTimeout(Math.min(click.delay_ms, 30_000));
    }
    try {
      await page.mouse.move(click.x, click.y);
      await page.waitForTimeout(80);
      await page.mouse.click(click.x, click.y);
      fired++;
      console.log(
        `[pre-game-replay] click ${fired}/${rec.clicks.length} @ (${click.x}, ${click.y}) — ${click.reason}`,
      );
    } catch (err) {
      console.warn(`[pre-game-replay] click ${fired + 1} failed:`, (err as Error).message);
      return {
        ready: false,
        clicksFired: fired,
        verifyDiffRatio: null,
        reason: `click_failed: ${(err as Error).message}`,
      };
    }
    await page.waitForTimeout(rec.default_post_click_wait_ms);
  }

  if (opts.skipVerify) {
    return { ready: true, clicksFired: fired, verifyDiffRatio: null, reason: "skipped_verify" };
  }

  // Verify via ready_signal
  if (rec.ready_signal.kind === "trust_clicks") {
    return { ready: true, clicksFired: fired, verifyDiffRatio: null, reason: "trust_clicks" };
  }

  const baselineFile = baselinePath(opts.slug, rec.ready_signal.baseline_name);
  if (!existsSync(baselineFile)) {
    return {
      ready: false,
      clicksFired: fired,
      verifyDiffRatio: null,
      reason: `baseline_missing: ${baselineFile}`,
    };
  }

  const actualBuf = await page.screenshot({ clip: rec.ready_signal.region });
  const actual = PNG.sync.read(actualBuf);
  const baseline = PNG.sync.read(readFileSync(baselineFile));

  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      ready: false,
      clicksFired: fired,
      verifyDiffRatio: null,
      reason: `size_mismatch: actual=${actual.width}x${actual.height} baseline=${baseline.width}x${baseline.height}`,
    };
  }

  // Apply mask: volatile area (reels random / balance text) → loại khỏi diff.
  // Mask coords in viewport space → adjust about region origin trước khi apply.
  // (Đã check ready_signal.kind === "region_snapshot" ở trên nên region exist.)
  const region = rec.ready_signal.kind === "region_snapshot"
    ? rec.ready_signal.region
    : { x: 0, y: 0, width: actual.width, height: actual.height };
  const rawMask = loadMaskRegions(opts.slug);
  const adjustedMask: MaskRegion[] = rawMask.map((m) => ({
    ...m,
    x: m.x - region.x,
    y: m.y - region.y,
  }));
  if (adjustedMask.length > 0) {
    applyMask(actual, adjustedMask);
    applyMask(baseline, adjustedMask);
  }

  const diffPng = new PNG({ width: actual.width, height: actual.height });
  const diffCount = pixelmatch(
    actual.data,
    baseline.data,
    diffPng.data,
    actual.width,
    actual.height,
    { threshold: 0.1 },
  );
  const totalPixels = actual.width * actual.height;
  // Exclude masked area khỏi denominator để ratio reflect chỉ vùng so sánh thật.
  let maskedArea = 0;
  for (const r of adjustedMask) {
    const w = Math.max(
      0,
      Math.min(actual.width, Math.floor(r.x + r.width)) - Math.max(0, Math.floor(r.x)),
    );
    const h = Math.max(
      0,
      Math.min(actual.height, Math.floor(r.y + r.height)) - Math.max(0, Math.floor(r.y)),
    );
    maskedArea += w * h;
  }
  const effectivePixels = totalPixels - maskedArea;
  // Mask quá aggressive (>95% region masked) → verification trống → declare
  // not-verified để caller fallback vision. Tránh false-positive "ready=true"
  // khi game thực ra đang ở modal hoặc loading.
  if (effectivePixels < totalPixels * 0.05) {
    return {
      ready: false,
      clicksFired: fired,
      verifyDiffRatio: null,
      reason: `mask_too_aggressive: ${(((totalPixels - effectivePixels) / totalPixels) * 100).toFixed(0)}% region masked (< 5% effective area) — cần shrink mask hoặc dời pre-game region khỏi masked zone (vd spin button icon stable)`,
    };
  }
  const diffRatio = diffCount / Math.max(1, effectivePixels);

  const ok = diffRatio <= rec.ready_signal.max_diff_ratio;
  return {
    ready: ok,
    clicksFired: fired,
    verifyDiffRatio: diffRatio,
    reason: ok
      ? "verified"
      : `region_mismatch: diff=${(diffRatio * 100).toFixed(2)}% > max=${(rec.ready_signal.max_diff_ratio * 100).toFixed(2)}%`,
  };
}

/**
 * Combined pre-game helper: try replay first, fall back to vision if no
 * recording or replay fails verification.
 *
 * Logs every attempt to `fixtures/pre-game/_stats.jsonl` for analysis.
 *
 * Auto-heal: if `PRE_GAME_AUTO_HEAL=1` and replay failed with
 * `region_mismatch` but vision succeeded, re-captures the baseline + clicks
 * so the next run goes straight to replay again. Default off — guarded
 * because a one-off vision success during a flaky state could otherwise
 * poison the baseline.
 */
export async function preGameWithReplayOrVision(
  page: Page,
  opts: {
    slug: string;
    viewport?: { width: number; height: number };
    label?: string;
    forceVision?: boolean;
  },
): Promise<{
  source: "replay" | "vision";
  ready: boolean;
  details: unknown;
  /** True nếu baseline đã được auto-re-captured. */
  autoHealed: boolean;
  /**
   * Spin button bbox AI trả về khi vision call succeeded (cùng hệ viewport
   * px với screenshot tại thời điểm vision). Null khi:
   *   - Replay succeed → vision không được gọi → không có bbox
   *   - Vision called nhưng AI không locate được spin button
   *   - Vision fail (ready=false)
   *
   * Caller dùng bbox khi có (live coord, không stale) → fallback về
   * SPIN_BUTTON hardcode khi null.
   */
  spinButtonBbox: SpinButtonBbox | null;
}> {
  // Default ON: auto-heal baseline when replay's pixel-diff fails but vision
  // recovers. Safe because heal only fires on `region_mismatch` (not on
  // click_failed), and only when vision confirms ready. Disable with
  // PRE_GAME_AUTO_HEAL=0 for strict reproducibility audits.
  const autoHealEnabled = process.env.PRE_GAME_AUTO_HEAL !== "0";

  // Force-vision opt-out (vd khi cố tình re-record).
  if (!opts.forceVision) {
    const replayStart = Date.now();
    const replay = await replayPreGameClicks(page, { slug: opts.slug });
    const replayDuration = Date.now() - replayStart;
    if (replay.ready) {
      logPreGameAttempt({
        ts: new Date().toISOString(),
        slug: opts.slug,
        source: "replay",
        ready: true,
        reason: replay.reason,
        duration_ms: replayDuration,
        replay_diff_ratio: replay.verifyDiffRatio,
        replay_clicks_fired: replay.clicksFired,
        is_fallback: false,
      });
      return { source: "replay", ready: true, details: replay, autoHealed: false, spinButtonBbox: null };
    }
    console.log(
      `[pre-game] replay failed (${replay.reason}) — falling back to vision flow`,
    );

    // Vision fallback path
    const visionStart = Date.now();
    const { waitForGamePlayScreen } = await import("./pre-game.js");
    const vision = await waitForGamePlayScreen(page, {
      viewport: opts.viewport,
      label: opts.label ?? "pre-game",
      captureSlug: opts.slug,
    });
    const visionDuration = Date.now() - visionStart;

    // Auto-heal: replay's verify failed but vision succeeded → baseline stale.
    // Only re-capture when the failure was due to image mismatch (not click
    // failures, which would imply the click sequence itself is wrong and a
    // recapture-from-replay-state would still be wrong).
    let autoHealed = false;
    if (
      autoHealEnabled &&
      vision.ready &&
      replay.reason.startsWith("region_mismatch")
    ) {
      try {
        await rebaseLineFromCurrentPage(page, opts.slug);
        autoHealed = true;
        console.log(`[pre-game] auto-healed baseline for ${opts.slug}`);
      } catch (err) {
        console.warn(`[pre-game] auto-heal failed:`, (err as Error).message);
      }
    }

    logPreGameAttempt({
      ts: new Date().toISOString(),
      slug: opts.slug,
      source: "vision",
      ready: vision.ready,
      reason: `${vision.reason} (after replay ${replay.reason})`,
      duration_ms: visionDuration,
      vision_iterations: vision.iterations,
      vision_dismissed: vision.dismissed,
      is_fallback: true,
      auto_healed: autoHealed,
    });
    return {
      source: "vision",
      ready: vision.ready,
      details: vision,
      autoHealed,
      spinButtonBbox: vision.ready ? vision.spinButtonBbox : null,
    };
  }

  // Pure vision path (forceVision=true)
  const visionStart = Date.now();
  const { waitForGamePlayScreen } = await import("./pre-game.js");
  const vision = await waitForGamePlayScreen(page, {
    viewport: opts.viewport,
    label: opts.label ?? "pre-game",
    captureSlug: opts.slug,
  });
  const visionDuration = Date.now() - visionStart;
  logPreGameAttempt({
    ts: new Date().toISOString(),
    slug: opts.slug,
    source: "vision",
    ready: vision.ready,
    reason: vision.reason,
    duration_ms: visionDuration,
    vision_iterations: vision.iterations,
    vision_dismissed: vision.dismissed,
    is_fallback: false,
  });
  return {
    source: "vision",
    ready: vision.ready,
    details: vision,
    autoHealed: false,
    spinButtonBbox: vision.ready ? vision.spinButtonBbox : null,
  };
}

/**
 * Re-capture the play-screen-ready baseline using the current page state.
 * Called when replay verification failed but vision succeeded — the click
 * sequence still works, just the baseline image needs refreshing.
 */
async function rebaseLineFromCurrentPage(page: Page, slug: string): Promise<void> {
  const rec = loadPreGameRecording(slug);
  if (!rec || rec.ready_signal.kind !== "region_snapshot") return;
  const path = baselinePath(slug, rec.ready_signal.baseline_name);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: rec.ready_signal.region });
  // Re-stamp recording with new timestamp so users can see baseline was refreshed.
  const updated: PreGameRecording = {
    ...rec,
    recorded_at: new Date().toISOString(),
  };
  savePreGameRecording(updated);
}

export type PreGameSourceTag = "replay" | "vision";
export type PreGameClickRecord = PreGameClick;
