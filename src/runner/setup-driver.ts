import type { Page } from "@playwright/test";
import { decideConfigAction, type ConfigAction } from "../ai/vision.js";
import { getScreenshotStore } from "./screenshot-store.js";

export type SetupResult = {
  goal: string;
  achieved: boolean;
  iterations: number;
  actions_taken: number;
  final_state: string;
  reason: string;
};

function emitEvent(kind: string, data: Record<string, unknown>) {
  console.log(`EVENT:${kind} ${JSON.stringify(data)}`);
}

/**
 * AI-driven game configuration. Chạy vision loop cho tới khi:
 * - AI xác nhận goal_achieved=true → return { achieved: true }
 * - Max iterations → return { achieved: false, reason: "max_iter" }
 * - Stuck / error → return { achieved: false, reason: "stuck"|"error" }
 *
 * Mỗi iter AI thấy screenshot + goal → click/type/wait/done. KHÔNG click spin.
 */
export async function applyCaseSetup(
  page: Page,
  goal: string,
  opts: { maxIterations?: number; viewport?: { width: number; height: number }; label?: string } = {},
): Promise<SetupResult> {
  const maxIter = opts.maxIterations ?? Number(process.env.SETUP_MAX_ITERATIONS ?? 15);
  const maxRepeat = Number(process.env.SETUP_MAX_REPEAT ?? 200);
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const label = opts.label ?? "setup";
  const store = getScreenshotStore();

  let actionsTaken = 0;
  let consecutiveWaits = 0;
  let sameStateCount = 0;
  let lastStateKey = "";
  let lastDecision: ConfigAction | null = null;
  // Track observed numeric values + clicks-between để AI calibrate step size
  const observedHistory: Array<{ value: number | null; clicks_since_last: number }> = [];

  console.log(`[setup] Goal: ${goal}`);
  emitEvent("setup_start", { goal, maxIterations: maxIter });

  for (let i = 0; i < maxIter; i++) {
    const shotPath = await store.take(page, `${label}-${String(i).padStart(2, "0")}`);
    let decision: ConfigAction;
    try {
      decision = await decideConfigAction({
        screenshotPath: shotPath,
        viewport,
        goal,
        iteration: i,
        lastAction: lastDecision
          ? { action: lastDecision.action, reason: lastDecision.reason }
          : null,
        observedHistory,
      });
    } catch (err) {
      console.warn(`[setup iter ${i}] AI error: ${(err as Error).message}`);
      emitEvent("setup_error", { iteration: i, error: (err as Error).message });
      return {
        goal,
        achieved: false,
        iterations: i,
        actions_taken: actionsTaken,
        final_state: lastDecision?.current_state ?? "",
        reason: "ai_error",
      };
    }
    lastDecision = decision;

    const repeatRaw = decision.repeat ?? 1;
    const repeat = Math.max(1, Math.min(maxRepeat, Math.floor(repeatRaw)));
    const obsValue =
      decision.observed_numeric_value != null && Number.isFinite(decision.observed_numeric_value)
        ? Number(decision.observed_numeric_value)
        : null;
    // Update history: nếu obsValue khác lần trước → ghi lại để AI tính step
    if (obsValue != null) {
      observedHistory.push({ value: obsValue, clicks_since_last: 0 });
      if (observedHistory.length > 8) observedHistory.shift();
    }

    console.log(
      `[setup iter ${i}] action=${decision.action}${repeat > 1 ? ` ×${repeat}` : ""} achieved=${decision.goal_achieved} conf=${decision.confidence.toFixed(2)} obs=${obsValue ?? "?"} target=${decision.target_numeric_value ?? "?"} state="${decision.current_state}"`,
    );
    emitEvent("setup_iter", {
      iteration: i,
      goal,
      action: decision.action,
      repeat,
      observed_numeric_value: obsValue,
      target_numeric_value: decision.target_numeric_value ?? null,
      goal_achieved: decision.goal_achieved,
      current_state: decision.current_state,
      visible_controls: decision.visible_controls,
      confidence: decision.confidence,
    });

    if (decision.goal_achieved && decision.action === "done") {
      console.log(`[setup] ✔ goal achieved in ${i + 1} iter, ${actionsTaken} actions`);
      emitEvent("setup_done", {
        goal,
        iterations: i + 1,
        actions_taken: actionsTaken,
        final_state: decision.current_state,
      });
      return {
        goal,
        achieved: true,
        iterations: i + 1,
        actions_taken: actionsTaken,
        final_state: decision.current_state,
        reason: "goal_achieved",
      };
    }

    if (decision.action === "error") {
      emitEvent("setup_impossible", { iteration: i, reason: decision.reason });
      return {
        goal,
        achieved: false,
        iterations: i + 1,
        actions_taken: actionsTaken,
        final_state: decision.current_state,
        reason: `ai_reported_error: ${decision.reason}`,
      };
    }

    const stateKey = `${decision.current_state}|${decision.visible_controls.slice(0, 3).join(",")}`;
    if (stateKey === lastStateKey && decision.action !== "wait") {
      sameStateCount++;
      if (sameStateCount >= 4) {
        console.warn(`[setup] stuck state 4x — aborting`);
        return {
          goal,
          achieved: decision.goal_achieved,
          iterations: i + 1,
          actions_taken: actionsTaken,
          final_state: decision.current_state,
          reason: "stuck",
        };
      }
    } else {
      sameStateCount = 0;
      lastStateKey = stateKey;
    }

    if (decision.action === "click") {
      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(150);
      // Batch click theo `repeat`. Pause giữa click ngắn (60ms) để UI animate kịp
      // và prevent miss-click; pause sau cụm dài hơn để screenshot tiếp theo ổn định.
      for (let k = 0; k < repeat; k++) {
        await page.mouse.click(decision.x, decision.y);
        if (k < repeat - 1) await page.waitForTimeout(60);
      }
      await page.waitForTimeout(repeat > 1 ? 1_200 : 1_500);
      actionsTaken += repeat;
      // Khi batch click stepper, ghi clicks_since_last cho entry kế tiếp để AI có context
      if (repeat > 1 && observedHistory.length > 0) {
        observedHistory[observedHistory.length - 1]!.clicks_since_last = repeat;
      }
      consecutiveWaits = 0;
    } else if (decision.action === "type") {
      if (decision.text_to_type) {
        await page.mouse.click(decision.x, decision.y);
        await page.keyboard.type(decision.text_to_type);
        await page.waitForTimeout(500);
        actionsTaken++;
      }
      consecutiveWaits = 0;
    } else if (decision.action === "wait") {
      consecutiveWaits++;
      if (consecutiveWaits >= 5) {
        console.warn(`[setup] 5 waits — aborting`);
        return {
          goal,
          achieved: decision.goal_achieved,
          iterations: i + 1,
          actions_taken: actionsTaken,
          final_state: decision.current_state,
          reason: "wait_exhausted",
        };
      }
      await page.waitForTimeout(2_000);
    }
  }

  console.warn(`[setup] hết ${maxIter} iter, goal chưa achieved`);
  emitEvent("setup_max_iter", { goal, iterations: maxIter });
  return {
    goal,
    achieved: lastDecision?.goal_achieved ?? false,
    iterations: maxIter,
    actions_taken: actionsTaken,
    final_state: lastDecision?.current_state ?? "",
    reason: "max_iter",
  };
}
