/**
 * Pre-game click recording — schema + persistence.
 *
 * A "pre-game recording" captures the sequence of clicks the harness needs to
 * perform after page.goto() to reach the play screen, plus a region-snapshot
 * baseline used to confirm the play screen is ready without re-calling the
 * LLM.
 *
 * File location: fixtures/pre-game/{slug}.json
 * Baseline image: fixtures/templates/{slug}/play-screen-ready.png
 *
 * The recording is provider-agnostic (just clicks) but per-slug (each game
 * has unique popup sequence + button coords).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PreGameClick = {
  /** Delay in milliseconds since previous click (or since pre-game start for the first click). */
  delay_ms: number;
  x: number;
  y: number;
  /** Short label (vd "age gate OK", "tutorial close") — for debugging only. */
  reason: string;
};

export type PreGameReadySignal =
  | {
      kind: "region_snapshot";
      /** Region to compare. Default: bottom-center spin button area. */
      region: { x: number; y: number; width: number; height: number };
      /** Baseline name (file: fixtures/templates/{slug}/{baseline_name}.png). */
      baseline_name: string;
      /** Max allowed pixel diff ratio (0..1). Default 0.05. */
      max_diff_ratio: number;
    }
  | {
      /** Fallback: no verification — caller trusts the click sequence completes. */
      kind: "trust_clicks";
    };

export type PreGameRecording = {
  slug: string;
  recorded_at: string;
  viewport: { width: number; height: number };
  /** Delay between clicks if not specified per-click. Default 1500ms. */
  default_post_click_wait_ms: number;
  /** Initial wait after page.goto() before first click. Default 2000ms. */
  initial_wait_ms: number;
  clicks: PreGameClick[];
  ready_signal: PreGameReadySignal;
};

const RECORDINGS_DIR = "fixtures/pre-game";

export function preGameRecordingPath(slug: string): string {
  return join(RECORDINGS_DIR, `${slug}.json`);
}

export function loadPreGameRecording(slug: string): PreGameRecording | null {
  const path = preGameRecordingPath(slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PreGameRecording;
  } catch (err) {
    console.warn(`[pre-game] Failed to load ${path}:`, (err as Error).message);
    return null;
  }
}

export function savePreGameRecording(rec: PreGameRecording): string {
  const path = preGameRecordingPath(rec.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rec, null, 2));
  return path;
}

export function hasPreGameRecording(slug: string): boolean {
  return existsSync(preGameRecordingPath(slug));
}
