// Pre-game recorder — captures click sequence + final baseline screenshot during
// cold-start, so subsequent warm-starts can replay deterministically. No AI.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { dirForGame } from "../registry/paths.js";

export type PreGameClick = {
  x: number;
  y: number;
  label: string;
  delayBeforeMs: number;     // wait this long BEFORE clicking
  delayAfterMs: number;       // wait this long AFTER clicking
};

export type PreGameRecording = {
  schemaVersion: 1;
  recordedAt: string;
  gameSlug: string;
  initialWaitMs: number;
  clicks: PreGameClick[];
  finalSettleMs: number;
  baselineFile: string;       // relative to pregame dir
};

const PREGAME_DIR = "pregame";

export class PreGameRecorder {
  private clicks: PreGameClick[] = [];
  private startTs: number;
  private lastClickTs: number;
  private initialWaitMs: number;

  constructor(initialWaitMs = 4000) {
    this.startTs = Date.now();
    this.lastClickTs = this.startTs;
    this.initialWaitMs = initialWaitMs;
  }

  recordClick(x: number, y: number, label: string): void {
    const now = Date.now();
    const delayBeforeMs = now - this.lastClickTs;
    this.clicks.push({ x, y, label, delayBeforeMs, delayAfterMs: 0 });
    this.lastClickTs = now;
  }

  closeLastClickWith(durationMs: number): void {
    if (this.clicks.length === 0) return;
    this.clicks[this.clicks.length - 1]!.delayAfterMs = durationMs;
  }

  async save(page: Page, gameSlug: string, finalSettleMs = 2000): Promise<PreGameRecording> {
    const dir = path.join(dirForGame(gameSlug), PREGAME_DIR);
    await mkdir(dir, { recursive: true });

    // Capture final baseline
    const baselineFile = "baseline.png";
    const baselineBuf = await page.screenshot({ type: "png" });
    await writeFile(path.join(dir, baselineFile), baselineBuf);

    const recording: PreGameRecording = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      gameSlug,
      initialWaitMs: this.initialWaitMs,
      clicks: this.clicks,
      finalSettleMs,
      baselineFile,
    };
    await writeFile(
      path.join(dir, "recording.json"),
      JSON.stringify(recording, null, 2) + "\n",
      "utf8",
    );
    return recording;
  }
}
