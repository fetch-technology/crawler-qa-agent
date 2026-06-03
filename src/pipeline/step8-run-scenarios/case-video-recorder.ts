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

  /** Start recording. Pass a `getActivePage` callback when the case may
   *  switch focus between multiple pages (e.g. external history tab opened
   *  via window.open) — the recorder re-resolves the source page each frame
   *  so the video follows whichever page the case is interacting with.
   *  When omitted, frames come from the original `page` always (legacy
   *  single-page behavior). */
  async start(page: Page, getActivePage?: () => Page): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    const intervalMs = Math.max(50, Math.floor(1000 / this.fps));
    console.log(`[case-video] start recording → ${this.framesDir} (fps=${this.fps}, interval=${intervalMs}ms)`);
    this.timer = setInterval(() => {
      if (this.stopped || this.inFlight) return;
      this.inFlight = true;
      // Resolve the source page each frame so external-tab activity gets
      // recorded too. Fallback to the original page when the callback
      // returns a closed/null page.
      let src: Page = page;
      try {
        const candidate = getActivePage?.();
        if (candidate && !candidate.isClosed()) src = candidate;
      } catch { /* getActivePage threw — fall back to original */ }
      src.screenshot({ type: "png", fullPage: false })
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
      console.warn(`[case-video] stop: 0 frames captured (page may have closed early) → skipping compose`);
      await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    console.log(`[case-video] stop: ${this.frameIdx} frames captured → composing MP4 via ffmpeg…`);
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
      // Capture stderr so failure reason surfaces in server logs — ffmpeg
      // writes diagnostics to stderr (codec missing, file unreadable, etc.).
      // When ffmpeg isn't on PATH for the Node process (common on launchd-
      // managed servers where /opt/homebrew/bin isn't injected), spawn emits
      // ENOENT via the 'error' event.
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      p.on("error", async (err) => {
        console.error(`[case-video] ffmpeg spawn failed: ${err.message}. Is ffmpeg on the Node process PATH? Try: \`which ffmpeg\` in the same shell that starts the server.`);
        await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
        resolve(null);
      });
      p.on("close", async (code) => {
        await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
        if (code === 0) {
          console.log(`[case-video] composed → ${this.outputPath}`);
          resolve(this.outputPath);
        } else {
          // Surface the last 1000 chars of stderr — full output can be huge
          // for codec issues but the trailing lines usually carry the cause.
          const tail = stderr.slice(-1000).trim();
          console.error(`[case-video] ffmpeg exited with code ${code}. stderr tail:\n${tail}`);
          resolve(null);
        }
      });
    });
  }
}
