import type { Page } from "playwright";
import { decidePreGameDismissal, type PreGameDismissal } from "../ai/vision.js";
import { getScreenshotStore } from "./screenshot-store.js";

export type WaitForPlayScreenResult = {
  ready: boolean;            // true nếu AI xác nhận đã ở play screen
  dismissed: number;         // số blocker đã click dismiss
  iterations: number;        // số iteration đã chạy
  lastVisibleElements: string[];
  reason: string;            // lý do dừng (ready | max_iter | repeated_failure)
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
  } = {},
): Promise<WaitForPlayScreenResult> {
  const maxIter = opts.maxIterations ?? Number(process.env.PRE_GAME_MAX_ITERATIONS ?? 20);
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const label = opts.label ?? "pre-game";
  const store = getScreenshotStore();

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
      });
      return {
        ready: true,
        dismissed,
        iterations: i + 1,
        lastVisibleElements: decision.visible_elements,
        reason: "ready",
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
      await page.waitForTimeout(opts.perIterWaitMs ?? 2_000);
    } else if (decision.action === "wait") {
      consecutiveWaits++;
      if (consecutiveWaits >= 6) {
        console.warn(`[${label}] 6 waits liên tiếp — có thể loading quá lâu, thoát loop`);
        emitEvent("pre_game_wait_exhausted", { iteration: i });
        return {
          ready: false,
          dismissed,
          iterations: i + 1,
          lastVisibleElements: decision.visible_elements,
          reason: "wait_exhausted",
        };
      }
      await page.waitForTimeout(2_500);
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
