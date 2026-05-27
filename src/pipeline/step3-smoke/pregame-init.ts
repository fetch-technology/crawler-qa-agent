// Pre-game init: replay existing recording if available, else record fresh.
// Wraps dismissOverlays logic so both cold-start (record) and warm-start
// (replay) share the same entry.

import type { Page } from "playwright";
import { detectBlackScreen } from "../utils/pixel-diff/index.js";
import { PreGameRecorder } from "./pregame-record.js";
import { replayPreGame, loadRecording } from "./pregame-replay.js";

// Returns 3 safe-click points scaled to current viewport so dismissal works
// at any resolution (1280×720, 1920×1080, etc.). Hardcoded 1920×1080 coords
// would land off-screen at smaller viewports.
function safeClicksFor(viewport: { width: number; height: number }): Array<{ x: number; y: number; label: string }> {
  return [
    { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.5), label: "center" },
    { x: Math.round(viewport.width * 0.15), y: Math.round(viewport.height * 0.4), label: "left-mid" },
    { x: Math.round(viewport.width * 0.85), y: Math.round(viewport.height * 0.4), label: "right-mid" },
  ];
}

const INITIAL_WAIT_MS = 4000;
const PER_CLICK_WAIT_MS = 1200;
const FINAL_SETTLE_MS = 2000;

export type PreGameInitResult = {
  mode: "replay" | "record" | "fallback";
  clicks: number;
  durationMs: number;
  finalBlackScreen: boolean;
  reason?: string;
};

async function dismissStickyPopups(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = Math.round(vp.width / 2);
  const cy = Math.round(vp.height / 2);
  // Click center 3 times with short gaps — handles "PRESS ANYWHERE TO CONTINUE"
  // type popups + multi-stage celebrations (free spin end → big win → ok).
  for (let i = 0; i < 3; i++) {
    try {
      await page.mouse.click(cx, cy);
    } catch {
      break;
    }
    await page.waitForTimeout(600);
  }
}

export async function initPreGame(
  page: Page,
  gameSlug: string,
): Promise<PreGameInitResult> {
  const start = Date.now();
  const explicitMode = process.env.QA_PREGAME_MODE ?? "auto"; // auto | record | replay | off

  if (explicitMode === "off") {
    return {
      mode: "fallback",
      clicks: 0,
      durationMs: 0,
      finalBlackScreen: false,
      reason: "QA_PREGAME_MODE=off",
    };
  }

  // Try replay first (auto + replay modes)
  if (explicitMode === "auto" || explicitMode === "replay") {
    const existing = await loadRecording(gameSlug);
    if (existing) {
      const r = await replayPreGame(page, gameSlug);
      if (r.ok) {
        // Extra "press-anywhere" dismiss for sticky popups (e.g. PP free-spin
        // celebration "PRESS ANYWHERE TO CONTINUE" that persists across reload
        // due to server session state). Idempotent — no-op when no popup.
        await dismissStickyPopups(page);
        const black = await detectBlackScreen(page, 0.85);
        return {
          mode: "replay",
          clicks: r.clicksReplayed,
          durationMs: Date.now() - start,
          finalBlackScreen: black.black,
        };
      }
      // Replay failed — log reason, fall through to record if mode allows
      if (explicitMode === "replay") {
        return {
          mode: "fallback",
          clicks: 0,
          durationMs: Date.now() - start,
          finalBlackScreen: false,
          reason: `replay failed: ${r.reason}`,
        };
      }
    }
  }

  // Record fresh (cold-start or auto-fallback)
  const recorder = new PreGameRecorder(INITIAL_WAIT_MS);
  await page.waitForTimeout(INITIAL_WAIT_MS);

  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const safeClicks = safeClicksFor(vp);
  let clicks = 0;
  for (const { x, y, label } of safeClicks) {
    try {
      const tBefore = Date.now();
      await page.mouse.click(x, y);
      recorder.recordClick(x, y, label);
      clicks++;
      await page.waitForTimeout(PER_CLICK_WAIT_MS);
      recorder.closeLastClickWith(Date.now() - tBefore);
    } catch {
      break;
    }
  }
  await page.waitForTimeout(FINAL_SETTLE_MS);

  // Extra dismiss after recording too — catches popups that appear LATER
  // (server-side delayed) and aren't part of the recorded click sequence.
  await dismissStickyPopups(page);

  if (process.env.QA_PREGAME_MODE !== "norec") {
    try {
      await recorder.save(page, gameSlug, FINAL_SETTLE_MS);
    } catch (err) {
      console.warn(
        `[pregame-init] save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const black = await detectBlackScreen(page, 0.85);
  return {
    mode: "record",
    clicks,
    durationMs: Date.now() - start,
    finalBlackScreen: black.black,
  };
}
