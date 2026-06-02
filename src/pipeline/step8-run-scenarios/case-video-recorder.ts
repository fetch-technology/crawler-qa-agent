// Per-case screen recorder. Captures the live browser at a configurable fps
// during a case's execution window and composes the frames into an MP4 via
// ffmpeg after the case ends. Output: <case-evidence-dir>/<caseId>.mp4.
//
// Why screenshot-loop instead of Playwright's recordVideo? recordVideo is
// tied to context lifecycle — to get per-case files we'd have to recreate
// the context every case, losing the persistent slot session that all our
// assertions rely on. Periodic page.screenshot() works on the live page
// without disturbing state.
//
// Performance: 5fps default → 30s case = ~150 PNG frames × ~80-150KB each.
// CPU is dominated by ffmpeg compose at stop time (~3-8s per 30s video on a
// modern Mac). Disk: temp .frames dir is removed after compose.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Page } from "playwright-core";

export class CaseVideoRecorder {
  private framesDir: string;
  private outputPath: string;
  private fps: number;
  private frameIdx = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(opts: { caseEvidenceDir: string; caseId: string; fps?: number }) {
    this.fps = opts.fps ?? 5;
    this.framesDir = path.join(opts.caseEvidenceDir, `${opts.caseId}.frames`);
    this.outputPath = path.join(opts.caseEvidenceDir, `${opts.caseId}.mp4`);
  }

  /** Probe `ffmpeg` in PATH. Returns false if missing — caller should skip
   *  recording rather than spew errors per frame. */
  static async ffmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    });
  }

  async start(page: Page): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    const intervalMs = Math.max(50, Math.floor(1000 / this.fps));
    this.timer = setInterval(() => {
      if (this.stopped || this.inFlight) return;
      this.inFlight = true;
      page.screenshot({ type: "png", fullPage: false })
        .then(async (buf) => {
          if (this.stopped) return;
          const idx = this.frameIdx++;
          const name = `frame-${idx.toString().padStart(5, "0")}.png`;
          await writeFile(path.join(this.framesDir, name), buf);
        })
        .catch(() => {
          // Page may have navigated / closed. Swallow — caller's case logic
          // will surface the real failure; we just stop capturing here.
        })
        .finally(() => { this.inFlight = false; });
    }, intervalMs);
  }

  /** Stop the loop and compose frames into MP4. Returns the output path on
   *  success, null when nothing was captured or ffmpeg failed. Always cleans
   *  up the .frames temp dir before returning. */
  async stop(): Promise<string | null> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    // Drain any in-flight screenshot (small window — interval was 200ms).
    for (let i = 0; i < 10 && this.inFlight; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.frameIdx === 0) {
      await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    return new Promise((resolve) => {
      // -pix_fmt yuv420p + even-dimension scale: x264 needs both for broad
      // player compatibility. Browser screenshots are 1280×720 by default
      // (already even) but viewport overrides could land on odd numbers.
      const args = [
        "-y",
        "-framerate", String(this.fps),
        "-i", path.join(this.framesDir, "frame-%05d.png"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-preset", "veryfast",
        this.outputPath,
      ];
      const p = spawn("ffmpeg", args, { stdio: "ignore" });
      p.on("error", async () => {
        await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
        resolve(null);
      });
      p.on("close", async (code) => {
        await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
        resolve(code === 0 ? this.outputPath : null);
      });
    });
  }
}
