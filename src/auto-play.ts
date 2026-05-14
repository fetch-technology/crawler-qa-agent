import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { parseGameUrl, redactUrl } from "./utils/url.js";
import { resolveGameUrl } from "./utils/resolve-game-url.js";
import { attachRecorder } from "./recorder/attach.js";
import { decideNextAction, type AIDecision } from "./ai/vision.js";
import { keepBrowserOpenIfRequested } from "./utils/keep-browser-open.js";
import { waitForGamePlayScreen } from "./runner/pre-game.js";
import { getSpinUrlPattern, shouldSkipUrl } from "./runner/spin-detect.js";

loadEnv();

type IterationLog = {
  iter: number;
  t: number;
  screenshot: string;
  decision: AIDecision;
  postClickWaitMs?: number;
  sawApiResponse?: boolean;
};

const VIEWPORT = { width: 1440, height: 900 };

/**
 * Cross-provider spin response detector. Dùng pattern shared với spin-detect.ts
 * (PP /gs2c/ge/, RG /spin, generic /round, /doSpin…) thay vì hardcode 1 domain.
 */
async function waitForSpinResponse(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const spinPattern = getSpinUrlPattern();
  try {
    await page.waitForResponse(
      (res) => {
        const url = res.url();
        if (shouldSkipUrl(url)) return false;
        return spinPattern.test(url);
      },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const gameUrl = resolveGameUrl("auto");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY) trong .env");
    process.exit(1);
  }

  const info = parseGameUrl(gameUrl);
  const outDir = process.env.RECORD_OUT_DIR ?? "fixtures/recordings";
  const spinsTarget = Number(process.env.AUTO_SPIN_COUNT ?? 3);
  const maxIterations = Number(process.env.AUTO_MAX_ITERATIONS ?? spinsTarget * 10);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outDir, `${info.gameSlug}__auto-${runId}`);

  console.log("================================================================");
  console.log(` AUTO-PLAY: ${info.gameSlug}`);
  console.log(` URL           : ${redactUrl(gameUrl)}`);
  console.log(` Spins target  : ${spinsTarget} (max ${maxIterations} iterations)`);
  console.log(` Output dir    : ${runDir}`);
  console.log("================================================================");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(runDir, "video"), size: VIEWPORT },
  });
  const page: Page = await context.newPage();
  const recorder = await attachRecorder(context, page, runDir);

  const iterations: IterationLog[] = [];
  let spinsCompleted = 0;
  let stopReason = "completed";

  try {
    await page.goto(gameUrl, { waitUntil: "domcontentloaded" });

    // Loop AI cho tới khi play screen ready: dismiss mọi blocker (age gate,
    // terms, cookies, welcome, tutorial, loading).
    await page.waitForTimeout(2_500);
    const preGameRes = await waitForGamePlayScreen(page, {
      viewport: VIEWPORT,
      label: "pre-game",
      maxIterations: Number(process.env.PRE_GAME_MAX_ITERATIONS ?? 25),
    });
    if (!preGameRes.ready) {
      console.warn(
        `[auto-play] play screen chưa ready sau ${preGameRes.iterations} iter (${preGameRes.reason}). Tiếp tục dù sao.`,
      );
    } else {
      console.log(
        `[auto-play] ✔ play screen ready sau ${preGameRes.iterations} iter, dismissed ${preGameRes.dismissed} blockers`,
      );
    }

    let lastAction: { action: string; reason: string } | null = null;
    let consecutiveWaits = 0;
    // Stuck-click detection: nếu AI cứ click spin nhưng spinsCompleted không tăng
    // (vd nút bị blocked, click bounce, balance frozen, server throttle), break để
    // tránh vòng lặp tốn ~22s/iter.
    let consecutiveSpinClicksWithoutProgress = 0;
    let lastObservedBalance: string | null = null;
    let consecutiveSameBalance = 0;
    const maxSameBalance = Number(process.env.AUTO_MAX_SAME_BALANCE ?? 4);

    for (let i = 0; i < maxIterations && spinsCompleted < spinsTarget; i++) {
      const t = Date.now() - recorder.t0;
      const screenshot = join(runDir, "screenshots", `iter-${i.toString().padStart(3, "0")}.png`);
      await page.screenshot({ path: screenshot });

      console.log(`\n[iter ${i}] spins=${spinsCompleted}/${spinsTarget} — hỏi AI...`);
      let decision: AIDecision;
      try {
        decision = await decideNextAction({
          screenshotPath: screenshot,
          viewport: VIEWPORT,
          spinsCompleted,
          spinsTarget,
          lastAction,
        });
      } catch (err) {
        console.error(`[iter ${i}] AI error:`, err);
        stopReason = "ai-error";
        break;
      }

      console.log(
        `[iter ${i}] action=${decision.action} state=${decision.spin_state} conf=${decision.confidence.toFixed(2)} balance=${decision.observed_balance ?? "?"} win=${decision.observed_win ?? "?"}`,
      );
      console.log(`[iter ${i}] reason: ${decision.reason}`);
      if (decision.action === "click") {
        console.log(`[iter ${i}] click (${decision.x}, ${decision.y})`);
      }

      const logEntry: IterationLog = { iter: i, t, screenshot, decision };

      if (decision.action === "click") {
        const spinPromise = /spin|play|bet/i.test(decision.reason) ? waitForSpinResponse(page) : null;

        await page.mouse.move(decision.x, decision.y);
        await page.waitForTimeout(150);
        await page.mouse.click(decision.x, decision.y);

        const waitStart = Date.now();
        if (spinPromise) {
          logEntry.sawApiResponse = await spinPromise;
          console.log(`[iter ${i}] spin API response: ${logEntry.sawApiResponse}`);
        } else {
          await page.waitForTimeout(1_500);
        }
        logEntry.postClickWaitMs = Date.now() - waitStart;

        // Cho animation chạy
        await page.waitForTimeout(2_500);
        consecutiveWaits = 0;
      } else if (decision.action === "wait") {
        await page.waitForTimeout(2_000);
        consecutiveWaits++;
        if (consecutiveWaits >= 6) {
          console.warn(`[iter ${i}] 6 waits liên tiếp — break để tránh treo`);
          stopReason = "stuck-waiting";
          iterations.push(logEntry);
          break;
        }
      } else if (decision.action === "spin_done") {
        spinsCompleted++;
        consecutiveWaits = 0;
        console.log(`[iter ${i}] ✔ spin ${spinsCompleted}/${spinsTarget} done`);
      } else if (decision.action === "error") {
        console.error(`[iter ${i}] AI báo error state, dừng`);
        stopReason = "ai-error-state";
        iterations.push(logEntry);
        break;
      }

      iterations.push(logEntry);
      lastAction = { action: decision.action, reason: decision.reason };

      const spinsBeforePostHook = spinsCompleted;
      // Hậu kiểm: nếu AI nói click spin và đã có API response, đếm là 1 spin
      if (decision.action === "click" && /spin|play/i.test(decision.reason) && logEntry.sawApiResponse) {
        spinsCompleted++;
        console.log(`[iter ${i}] ✔ spin ${spinsCompleted}/${spinsTarget} (detected via API)`);
      }

      // Stuck detection: track spin clicks không tăng progress + balance frozen.
      const wasSpinClick = decision.action === "click" && /spin|play|bet/i.test(decision.reason);
      if (wasSpinClick) {
        if (spinsCompleted === spinsBeforePostHook && decision.action !== "spin_done") {
          consecutiveSpinClicksWithoutProgress++;
        } else {
          consecutiveSpinClicksWithoutProgress = 0;
        }
      }

      const obsBalance = decision.observed_balance;
      if (obsBalance != null) {
        if (obsBalance === lastObservedBalance) consecutiveSameBalance++;
        else consecutiveSameBalance = 0;
        lastObservedBalance = obsBalance;
      }

      if (consecutiveSpinClicksWithoutProgress >= 4 && consecutiveSameBalance >= maxSameBalance) {
        console.warn(
          `[iter ${i}] STUCK — ${consecutiveSpinClicksWithoutProgress} click spin liên tiếp, balance frozen ở ${lastObservedBalance} ${consecutiveSameBalance} iter. Break.`,
        );
        stopReason = "stuck-no-progress";
        break;
      }
    }

    if (spinsCompleted >= spinsTarget) {
      stopReason = "target-reached";
    }
  } catch (err) {
    console.error("Fatal:", err);
    stopReason = "exception";
  } finally {
    console.log(`\n<<< Auto-play kết thúc (${stopReason}). Flush output...`);
    await page.screenshot({ path: join(runDir, "screenshots", "final.png"), fullPage: false }).catch(() => {});

    writeFileSync(
      join(runDir, "iterations.json"),
      JSON.stringify(iterations, null, 2),
    );

    await recorder.finalize({
      gameUrl,
      gameSlug: info.gameSlug,
      operator: info.operator,
      stopReason,
      extra: {
        spinsCompleted,
        spinsTarget,
        iterationsRun: iterations.length,
      },
    });

    await keepBrowserOpenIfRequested(page);

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log(`\n✔ Output: ${runDir}`);
    console.log(` - spins completed: ${spinsCompleted}/${spinsTarget}`);
    console.log(` - iterations:      ${iterations.length}`);
    console.log(` - http.jsonl:      ${recorder.counts.http}`);
    console.log(` - ws.jsonl:        ${recorder.counts.ws}`);
    console.log(` - iterations.json, summary.json, screenshots/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
