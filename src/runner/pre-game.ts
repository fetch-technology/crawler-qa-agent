import type { Page } from "playwright";
import { decidePreGameDismissal, type PreGameDismissal, type SpinButtonBbox } from "../ai/vision.js";
import { getScreenshotStore } from "./screenshot-store.js";
import {
  savePreGameRecording,
  type PreGameClick,
  type PreGameRecording,
} from "./pre-game-recording.js";
import { baselinePath } from "./region-snapshot.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type WaitForPlayScreenResult = {
  ready: boolean;            // true nếu AI xác nhận đã ở play screen
  dismissed: number;         // số blocker đã click dismiss
  iterations: number;        // số iteration đã chạy
  lastVisibleElements: string[];
  reason: string;            // lý do dừng (ready | max_iter | repeated_failure)
  /**
   * Spin button bbox AI trả về kèm decision "done". Coord trong viewport px
   * (cùng hệ với screenshot tại thời điểm vision call) — KHÔNG cần scale
   * thêm. Null khi AI không locate được, hoặc khi !ready, hoặc khi response
   * không match validation (xem normalizeSpinButtonBbox trong vision.ts).
   *
   * Caller có thể click tại bbox.x + bbox.w/2, bbox.y + bbox.h/2 thay vì
   * dùng SPIN_BUTTON hardcode từ recording.
   */
  spinButtonBbox: SpinButtonBbox | null;
};

function emitEvent(kind: string, data: Record<string, unknown>) {
  console.log(`EVENT:${kind} ${JSON.stringify(data)}`);
}

/**
 * Loop AI vision cho tới khi play screen ready. Dismiss mọi blocker (age gate,
 * terms, cookies, welcome, tutorial, sound prompt, promo, launcher, loading...)
 * cho tới khi AI xác nhận: reels + spin + balance + bet đều visible, không modal.
 *
 * Return ready=true khi AI confirm; ready=false khi đạt max iterations hoặc
 * stuck. Không throw — caller tự quyết xử lý theo ready flag.
 */
export async function waitForGamePlayScreen(
  page: Page,
  opts: {
    maxIterations?: number;
    viewport?: { width: number; height: number };
    label?: string;
    perIterWaitMs?: number;
    /**
     * Optional slug to capture a click recording into
     * `fixtures/pre-game/{slug}.json`. Triggered by env QA_CAPTURE_PREGAME=1
     * (so callers can opt in centrally). When set, every click + delay is
     * recorded and a region-snapshot baseline is captured after play-screen ready.
     */
    captureSlug?: string;
  } = {},
): Promise<WaitForPlayScreenResult> {
  const maxIter = opts.maxIterations ?? Number(process.env.PRE_GAME_MAX_ITERATIONS ?? 20);
  const maxConsecutiveWaits = Number(process.env.PRE_GAME_MAX_CONSECUTIVE_WAITS ?? 12);
  const waitActionMs = Number(process.env.PRE_GAME_WAIT_ACTION_MS ?? 2_500);
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const label = opts.label ?? "pre-game";
  const store = getScreenshotStore();

  // Capture mode: opt-in via env var to avoid touching every caller signature.
  const captureEnabled = process.env.QA_CAPTURE_PREGAME === "1" && Boolean(opts.captureSlug);
  const capturedClicks: PreGameClick[] = [];
  let lastClickAt: number | null = null;
  const captureStart = Date.now();

  let dismissed = 0;
  let consecutiveWaits = 0;
  let sameStateCount = 0;
  let lastStateKey = "";
  let lastDecision: PreGameDismissal | null = null;

  emitEvent("pre_game_start", { maxIterations: maxIter, label });

  for (let i = 0; i < maxIter; i++) {
    const shotPath = await store.take(page, `${label}-${String(i).padStart(2, "0")}`);
    let decision: PreGameDismissal;
    try {
      decision = await decidePreGameDismissal({
        screenshotPath: shotPath,
        viewport,
        iteration: i,
        dismissedSoFar: dismissed,
      });
    } catch (err) {
      console.warn(`[pre-game iter ${i}] AI error:`, (err as Error).message);
      emitEvent("pre_game_error", { iteration: i, error: (err as Error).message });
      return {
        ready: false,
        dismissed,
        iterations: i,
        lastVisibleElements: lastDecision?.visible_elements ?? [],
        reason: "ai_error",
        spinButtonBbox: null,
      };
    }
    lastDecision = decision;

    const confDisplay = typeof decision.confidence === "number" ? decision.confidence.toFixed(2) : "?";
    console.log(
      `[${label} iter ${i}] action=${decision.action} blocker=${decision.blocker_type} ready=${decision.play_screen_ready} conf=${confDisplay} visible=[${(decision.visible_elements ?? []).join(",")}]`,
    );
    console.log(`[${label} iter ${i}] reason: ${decision.reason}`);

    emitEvent("pre_game_iter", {
      iteration: i,
      label,
      action: decision.action,
      blocker_type: decision.blocker_type,
      blocker_text: decision.blocker_text,
      play_screen_ready: decision.play_screen_ready,
      visible_elements: decision.visible_elements,
      confidence: decision.confidence,
      dismissed_so_far: dismissed,
    });

    if (decision.action === "done" && decision.play_screen_ready) {
      emitEvent("pre_game_ready", {
        iterations: i + 1,
        dismissed,
        visible_elements: decision.visible_elements,
        spin_button_bbox: decision.spin_button_bbox,
      });
      if (decision.spin_button_bbox) {
        const cx = Math.round(decision.spin_button_bbox.x + decision.spin_button_bbox.w / 2);
        const cy = Math.round(decision.spin_button_bbox.y + decision.spin_button_bbox.h / 2);
        console.log(
          `[${label}] spin button bbox (${decision.spin_button_bbox.x},${decision.spin_button_bbox.y}) ${decision.spin_button_bbox.w}×${decision.spin_button_bbox.h} → click center (${cx},${cy})`,
        );
      } else {
        console.log(`[${label}] no spin_button_bbox returned by vision — caller will fall back to recorded coord`);
      }
      // Capture mode: snapshot baseline + persist recording.
      if (captureEnabled && opts.captureSlug) {
        try {
          await capturePlayScreenBaseline(page, opts.captureSlug, viewport);
          const rec: PreGameRecording = {
            slug: opts.captureSlug,
            recorded_at: new Date().toISOString(),
            viewport,
            initial_wait_ms: 2_000,
            default_post_click_wait_ms: opts.perIterWaitMs ?? 2_000,
            clicks: capturedClicks,
            ready_signal: {
              kind: "region_snapshot",
              region: DEFAULT_PLAY_SCREEN_REGION,
              baseline_name: "play-screen-ready",
              max_diff_ratio: 0.05,
            },
          };
          const path = savePreGameRecording(rec);
          console.log(`[pre-game] captured ${capturedClicks.length} click(s) → ${path}`);
          emitEvent("pre_game_captured", { path, clicks: capturedClicks.length });
        } catch (err) {
          console.warn(`[pre-game] capture failed:`, (err as Error).message);
        }
      }
      return {
        ready: true,
        dismissed,
        iterations: i + 1,
        lastVisibleElements: decision.visible_elements,
        reason: "ready",
        spinButtonBbox: decision.spin_button_bbox,
      };
    }

    // Detect stuck: cùng (phase, visible_elements) nhiều lần
    const stateKey = `${decision.blocker_type}|${decision.action}|${decision.visible_elements.slice(0, 4).join(",")}`;
    if (stateKey === lastStateKey) {
      sameStateCount++;
      if (sameStateCount >= 5) {
        console.warn(`[${label}] kẹt state "${stateKey}" 5 lần — thoát loop`);
        emitEvent("pre_game_stuck", { iteration: i, stateKey });
        return {
          ready: decision.play_screen_ready,
          dismissed,
          iterations: i + 1,
          lastVisibleElements: decision.visible_elements,
          reason: "repeated_state",
          spinButtonBbox: decision.play_screen_ready ? decision.spin_button_bbox : null,
        };
      }
    } else {
      sameStateCount = 0;
      lastStateKey = stateKey;
    }

    if (decision.action === "click") {
      consecutiveWaits = 0;
      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(150);
      await page.mouse.click(decision.x, decision.y);
      dismissed++;
      // Capture click for future deterministic replay
      if (captureEnabled) {
        const now = Date.now();
        const delay = lastClickAt == null ? now - captureStart : now - lastClickAt;
        capturedClicks.push({
          delay_ms: delay,
          x: decision.x,
          y: decision.y,
          reason: `${decision.blocker_type ?? "unknown"}: ${(decision.reason ?? "").slice(0, 80)}`,
        });
        lastClickAt = now;
      }
      await page.waitForTimeout(opts.perIterWaitMs ?? 2_000);
    } else if (decision.action === "wait") {
      consecutiveWaits++;
      if (consecutiveWaits >= maxConsecutiveWaits) {
        console.warn(
          `[${label}] ${maxConsecutiveWaits} waits liên tiếp — có thể loading quá lâu, thoát loop`,
        );
        emitEvent("pre_game_wait_exhausted", { iteration: i });
        return {
          ready: false,
          dismissed,
          iterations: i + 1,
          lastVisibleElements: decision.visible_elements,
          reason: "wait_exhausted",
          spinButtonBbox: null,
        };
      }
      await page.waitForTimeout(waitActionMs);
    } else if (decision.action === "done" && !decision.play_screen_ready) {
      // AI nói done nhưng play_screen_ready=false → tiếp tục, có thể sai lầm nhất thời
      console.warn(`[${label} iter ${i}] AI said done but play_screen_ready=false, continuing`);
      await page.waitForTimeout(1_500);
    }
  }

  console.warn(`[${label}] hết ${maxIter} iterations, play screen chưa ready`);
  emitEvent("pre_game_max_iter", { maxIterations: maxIter, dismissed });
  return {
    ready: lastDecision?.play_screen_ready ?? false,
    dismissed,
    iterations: maxIter,
    lastVisibleElements: lastDecision?.visible_elements ?? [],
    reason: "max_iter",
    spinButtonBbox: lastDecision?.play_screen_ready ? lastDecision.spin_button_bbox : null,
  };
}

/**
 * Backward-compat wrapper. Dùng waitForGamePlayScreen bên trong.
 * Trả về chỉ số blocker đã dismiss (như API cũ).
 */
export async function dismissPreGameBlockers(
  page: Page,
  opts: { maxIterations?: number; viewport?: { width: number; height: number }; label?: string } = {},
): Promise<number> {
  const res = await waitForGamePlayScreen(page, opts);
  return res.dismissed;
}

/**
 * Default region for play-screen-ready baseline — bottom-center where spin
 * button typically sits. Override per-slug by editing fixtures/pre-game/{slug}.json
 * after first recording.
 */
export const DEFAULT_PLAY_SCREEN_REGION = {
  x: 620,
  y: 760,
  width: 200,
  height: 120,
};

/**
 * Snapshot the play-screen-ready region as a baseline PNG. Used by replay
 * verification: after replaying clicks, screenshot the same region and pixel-diff.
 */
async function capturePlayScreenBaseline(
  page: Page,
  slug: string,
  _viewport: { width: number; height: number },
): Promise<void> {
  const path = baselinePath(slug, "play-screen-ready");
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({
    path,
    clip: DEFAULT_PLAY_SCREEN_REGION,
  });
}
