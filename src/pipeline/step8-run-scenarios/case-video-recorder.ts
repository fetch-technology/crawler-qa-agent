// Per-case screen recorder. Two capture modes, same output contract
// (<case-evidence-dir>/<caseId>.mp4, VFR — playback matches wall-clock):
//
//   SCREENCAST (default) — CDP Page.startScreencast. The BROWSER pushes a
//   jpeg frame whenever the compositor renders new content: static screens
//   (waits, popups) cost ~zero, fast animations are captured at their real
//   cadence (throttled to `fps` max), and each frame carries the compositor's
//   own timestamp. This is the same mechanism Playwright's recordVideo uses
//   internally — used directly so recording can start/stop PER CASE on the
//   persistent session (recordVideo finalizes only on context close).
//
//   POLL (fallback, QA_SCREENCAST=0 or screencast setup failure) — interval
//   page.screenshot() loop. Forces a capture every tick even when nothing
//   changed; kept as the safety net since it has zero CDP-session deps.
//
// Why not Playwright's recordVideo? It is tied to context lifecycle — per-case
// files would require recreating the context every case, losing the
// persistent slot session all assertions rely on.
//
// Performance: frames are JPEG (quality 60) — the per-frame encode runs
// INSIDE the browser process (the only part of recording that can touch game
// rendering) and JPEG is ~5-10× cheaper than PNG. ffmpeg compose at stop is
// Node-side (~3-8s per 30s video). Temp .frames dir removed after compose.
//
// Timing: every frame records a capture timestamp and the video is composed
// via ffmpeg's concat demuxer with REAL per-frame durations (VFR). A fixed
// -framerate compose assumed uniform capture — but poll captures get skipped
// under load and screencast frames arrive only on change, so fixed-rate
// playback distorted duration badly.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Page, CDPSession } from "playwright-core";

export class CaseVideoRecorder {
  private framesDir: string;
  private outputPath: string;
  private fps: number;
  private frameIdx = 0;
  /** Capture log — filename + wall-clock capture time, in capture order.
   *  Drives the VFR compose. */
  private frames: Array<{ name: string; atMs: number }> = [];
  private timer: NodeJS.Timeout | null = null;
  private pageWatchTimer: NodeJS.Timeout | null = null;
  private cdp: CDPSession | null = null;
  private cdpPage: Page | null = null;
  private mode: "screencast" | "poll" = "poll";
  private inFlight = false;
  private pendingWrites = 0;
  private lastKeptMs = 0;
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
   *  via window.open) — the recorder follows whichever page the case is
   *  interacting with. Screencast mode unless QA_SCREENCAST=0; any setup
   *  failure falls back to the poll loop automatically. */
  async start(page: Page, getActivePage?: () => Page): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    if (process.env.QA_SCREENCAST !== "0") {
      try {
        await this.startScreencast(page, getActivePage);
        this.mode = "screencast";
        console.log(`[case-video] start recording → ${this.framesDir} (mode=screencast, maxFps=${this.fps})`);
        return;
      } catch (err) {
        console.warn(`[case-video] screencast setup failed (${err instanceof Error ? err.message : String(err)}) — falling back to poll mode`);
      }
    }
    this.startPoll(page, getActivePage);
    this.mode = "poll";
    console.log(`[case-video] start recording → ${this.framesDir} (mode=poll, fps=${this.fps})`);
  }

  // ─── SCREENCAST mode ─────────────────────────────────────────────────────

  private async startScreencast(page: Page, getActivePage?: () => Page): Promise<void> {
    // Seed frame: a fully static case would otherwise produce ZERO pushed
    // frames → empty video. One forced capture guarantees ≥1.
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      this.keepFrame(buf, Date.now(), /*force*/ true);
    } catch { /* page busy — pushed frames will cover it */ }

    await this.attachScreencast(page);

    // Follow the active page: screencast is bound to ONE target, so when the
    // case switches to an external tab, re-attach there. Cheap 1s poll of the
    // callback — no captures involved.
    if (getActivePage) {
      this.pageWatchTimer = setInterval(() => {
        if (this.stopped) return;
        let next: Page | null = null;
        try {
          const candidate = getActivePage();
          if (candidate && !candidate.isClosed()) next = candidate;
        } catch { /* keep current */ }
        if (next && next !== this.cdpPage) {
          this.attachScreencast(next).catch((err) => {
            console.warn(`[case-video] screencast re-attach failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }, 1000);
    }
  }

  /** (Re)attach the screencast stream to `page`, detaching any previous one. */
  private async attachScreencast(page: Page): Promise<void> {
    const old = this.cdp;
    this.cdp = null;
    if (old) {
      try { await old.send("Page.stopScreencast"); } catch { /* target gone */ }
      try { await old.detach(); } catch { /* already detached */ }
    }
    const session = await page.context().newCDPSession(page);
    session.on("Page.screencastFrame", (ev: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
      // ACK FIRST, unconditionally — screencast flow control stops delivering
      // frames until the previous one is acknowledged.
      session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
      if (this.stopped) return;
      // Throttle to `fps` max: bursts during heavy animation would otherwise
      // write 15-30 frames/s for minutes (autoplay batches), bloating disk +
      // compose time. Idle stays free — no frames arrive at all.
      const atMs = ev.metadata?.timestamp != null ? Math.round(ev.metadata.timestamp * 1000) : Date.now();
      this.keepFrame(Buffer.from(ev.data, "base64"), atMs, false);
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 2 });
    this.cdp = session;
    this.cdpPage = page;
  }

  /** Persist a frame if it passes the max-fps throttle (or force=true). */
  private keepFrame(buf: Buffer, atMs: number, force: boolean): void {
    const minGapMs = Math.floor(1000 / this.fps);
    if (!force && atMs - this.lastKeptMs < minGapMs) return;
    this.lastKeptMs = atMs;
    const idx = this.frameIdx++;
    const name = `frame-${idx.toString().padStart(5, "0")}.jpg`;
    this.pendingWrites++;
    writeFile(path.join(this.framesDir, name), buf)
      .then(() => { this.frames.push({ name, atMs }); })
      .catch(() => { /* disk error — frame lost, compose uses what landed */ })
      .finally(() => { this.pendingWrites--; });
  }

  // ─── POLL mode (fallback) ────────────────────────────────────────────────

  private startPoll(page: Page, getActivePage?: () => Page): void {
    const intervalMs = Math.max(50, Math.floor(1000 / this.fps));
    this.timer = setInterval(() => {
      if (this.stopped || this.inFlight) return;
      this.inFlight = true;
      let src: Page = page;
      try {
        const candidate = getActivePage?.();
        if (candidate && !candidate.isClosed()) src = candidate;
      } catch { /* getActivePage threw — fall back to original */ }
      const capturedAt = Date.now();
      src.screenshot({ type: "jpeg", quality: 60, fullPage: false })
        .then((buf) => {
          if (this.stopped) return;
          this.keepFrame(buf, capturedAt, /*force*/ true);
        })
        .catch(() => {
          // Page may have navigated / closed. Swallow — caller's case logic
          // will surface the real failure; we just stop capturing here.
        })
        .finally(() => { this.inFlight = false; });
    }, intervalMs);
  }

  // ─── stop + compose ──────────────────────────────────────────────────────

  /** Stop capture and compose frames into MP4. Returns the output path on
   *  success, null when nothing was captured or ffmpeg failed. Always cleans
   *  up the .frames temp dir before returning. */
  async stop(): Promise<string | null> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pageWatchTimer) clearInterval(this.pageWatchTimer);
    this.pageWatchTimer = null;
    if (this.cdp) {
      try { await this.cdp.send("Page.stopScreencast"); } catch { /* target gone */ }
      try { await this.cdp.detach(); } catch { /* already detached */ }
      this.cdp = null;
    }

    // Drain in-flight capture + pending frame writes.
    for (let i = 0; i < 20 && (this.inFlight || this.pendingWrites > 0); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.frames.length === 0) {
      console.warn(`[case-video] stop: 0 frames captured (page may have closed early) → skipping compose`);
      await rm(this.framesDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    // Frames were pushed asynchronously — order by capture time before
    // building the playlist (writes can complete out of submission order).
    this.frames.sort((a, b) => a.atMs - b.atMs);

    // Build the concat playlist with REAL inter-frame durations so playback
    // matches wall-clock. The last frame is listed twice (concat-demuxer
    // convention: the final entry's duration is otherwise ignored).
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i]!;
      const next = this.frames[i + 1];
      const durSec = next ? Math.max(0.02, (next.atMs - f.atMs) / 1000) : 1 / this.fps;
      lines.push(`file '${f.name}'`, `duration ${durSec.toFixed(3)}`);
    }
    lines.push(`file '${this.frames[this.frames.length - 1]!.name}'`);
    const playlistPath = path.join(this.framesDir, "frames.ffconcat");
    await writeFile(playlistPath, lines.join("\n") + "\n", "utf8");

    const wallSec = (this.frames[this.frames.length - 1]!.atMs - this.frames[0]!.atMs) / 1000;
    console.log(`[case-video] stop: ${this.frames.length} frames over ${wallSec.toFixed(1)}s (mode=${this.mode}) → composing MP4 (VFR) via ffmpeg…`);
    return new Promise((resolve) => {
      // -pix_fmt yuv420p + even-dimension scale: x264 needs both for broad
      // player compatibility. -vsync vfr honors the playlist's durations.
      const args = [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", playlistPath,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-vsync", "vfr",
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
