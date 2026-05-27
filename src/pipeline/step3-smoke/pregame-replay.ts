// Pre-game replayer — read recorded click sequence + verify final state matches
// baseline via pixel-diff. Falls back to vision-driven re-record if baseline
// drifts too much (game updated). Used by warm-start to skip ~30s of vision
// iteration when game UI is stable.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { dirForGame } from "../registry/paths.js";
import { snapshot } from "../utils/pixel-diff/index.js";
import { pixelDiff } from "../utils/pixel-diff/diff.js";
import type { PreGameRecording } from "./pregame-record.js";

const PREGAME_DIR = "pregame";
const BASELINE_MATCH_THRESHOLD = 0.08;

export type ReplayResult =
  | { ok: true; clicksReplayed: number; finalDiffRatio: number }
  | { ok: false; reason: string; finalDiffRatio?: number };

export async function loadRecording(gameSlug: string): Promise<PreGameRecording | null> {
  const file = path.join(dirForGame(gameSlug), PREGAME_DIR, "recording.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as PreGameRecording;
  } catch {
    return null;
  }
}

export async function replayPreGame(
  page: Page,
  gameSlug: string,
): Promise<ReplayResult> {
  const recording = await loadRecording(gameSlug);
  if (!recording) return { ok: false, reason: "no recording.json found" };

  // Initial wait (browser loads assets)
  await page.waitForTimeout(recording.initialWaitMs);

  // Replay clicks
  for (const click of recording.clicks) {
    if (click.delayBeforeMs > 0) await page.waitForTimeout(click.delayBeforeMs);
    try {
      await page.mouse.click(click.x, click.y);
    } catch (err) {
      return {
        ok: false,
        reason: `click ${click.label} at (${click.x},${click.y}) failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (click.delayAfterMs > 0) await page.waitForTimeout(click.delayAfterMs);
  }

  await page.waitForTimeout(recording.finalSettleMs);

  // Verify against baseline
  const baselinePath = path.join(dirForGame(gameSlug), PREGAME_DIR, recording.baselineFile);
  let baseline: PNG;
  try {
    const buf = await readFile(baselinePath);
    baseline = PNG.sync.read(buf);
  } catch (err) {
    return {
      ok: false,
      reason: `baseline read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const current = await snapshot(page);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      ok: false,
      reason: `viewport mismatch: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
    };
  }

  const { ratio } = pixelDiff(baseline, current);
  if (ratio >= BASELINE_MATCH_THRESHOLD) {
    return {
      ok: false,
      reason: `baseline drift: pixel diff ${ratio.toFixed(3)} >= ${BASELINE_MATCH_THRESHOLD}`,
      finalDiffRatio: ratio,
    };
  }

  return { ok: true, clicksReplayed: recording.clicks.length, finalDiffRatio: ratio };
}
