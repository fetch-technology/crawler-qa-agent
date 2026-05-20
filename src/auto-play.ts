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
  usedSpinFallbackClick?: boolean;
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

function isSpinIntent(reason: string): boolean {
  return /\bspin\b|start spin|start the next spin|reels?.*spin|single spin|press spin/i.test(reason);
}

function isPragmaticPlayHost(gameUrl: string): boolean {
  try {
    const host = new URL(gameUrl).hostname.toLowerCase();
    return host.startsWith("pp.") || host.includes("pragmatic");
  } catch {
    return false;
  }
}

function resolvePpForceSpinCenter(args: {
  viewport: { width: number; height: number };
  fallbackCenter: { x: number; y: number } | null;
}): { x: number; y: number } {
  const { viewport, fallbackCenter } = args;
  // PP layout (1440x900): spin is typically near bottom-right but left of +/- controls.
  const hardAnchor = {
    x: Math.round(viewport.width - 320),
    y: Math.round(viewport.height - 80),
  };
  if (!fallbackCenter) return hardAnchor;

  // If AI bbox drifts too far right, it's often the '+' button, not spin.
  if (fallbackCenter.x > viewport.width - 220) {
    return {
      x: Math.max(1, Math.min(viewport.width - 1, fallbackCenter.x - 170)),
      y: fallbackCenter.y,
    };
  }
  return fallbackCenter;
}

function buildHistoryCandidates(gameUrl: string, slug: string): string[] {
  try {
    const u = new URL(gameUrl);
    const t = u.searchParams.get("t") ?? "";
    const tokenVariants = [t, t ? `demo@${t}` : ""].filter(Boolean);
    const out: string[] = [];

    // Legacy landing history URL seen in init payload.
    out.push(`${u.origin}/history/?symbol=${encodeURIComponent(slug)}`);

    // Modern history API variants.
    for (const tok of tokenVariants) {
      const qp = new URLSearchParams({ token: tok, symbol: slug });
      out.push(`${u.origin}/history/api/history/v2/play-session/last-items?${qp.toString()}`);
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

async function captureHistoryEndpointTraffic(page: Page, gameUrl: string, slug: string): Promise<void> {
  const candidates = buildHistoryCandidates(gameUrl, slug);
  if (candidates.length === 0) return;
  console.log(`[auto-play] probing history endpoint(s): ${candidates.length} candidate(s)`);
  for (const url of candidates) {
    try {
      const status = await page.evaluate(async (u) => {
        const r = await fetch(u, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json, text/plain, */*" },
        });
        await r.text().catch(() => "");
        return r.status;
      }, url);
      console.log(`[auto-play] history probe ${url} -> HTTP ${status}`);
      // Give recorder a short window to persist request/response pair.
      await page.waitForTimeout(250);
      // 2xx/4xx both useful for capturing template URL in recording.
      if (status >= 200 && status < 500) break;
    } catch (err) {
      console.log(`[auto-play] history probe failed: ${(err as Error).message}`);
    }
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
      // Pass slug so QA_CAPTURE_PREGAME=1 actually captures.
      // Auto-play always knows the slug — there's no reason not to thread it.
      captureSlug: info.gameSlug,
    });
    const fallbackSpinCenter = preGameRes.spinButtonBbox
      ? {
          x: Math.round(preGameRes.spinButtonBbox.x + preGameRes.spinButtonBbox.w / 2),
          y: Math.round(preGameRes.spinButtonBbox.y + preGameRes.spinButtonBbox.h / 2),
        }
      : null;
    const ppHost = isPragmaticPlayHost(gameUrl);
    const forceSpinEnabled = ppHost && (process.env.AUTO_FORCE_SPIN ?? "1") !== "0";
    const forceSpinWindowMs = Number(process.env.AUTO_FORCE_SPIN_WINDOW_MS ?? 15_000);
    const forceSpinCenter = forceSpinEnabled
      ? resolvePpForceSpinCenter({ viewport: VIEWPORT, fallbackCenter: fallbackSpinCenter })
      : fallbackSpinCenter;
    const forceSpinOffsets = [
      { dx: 0, dy: 0 },
      { dx: -22, dy: 0 },
      { dx: 22, dy: 0 },
      { dx: 0, dy: -22 },
      { dx: 0, dy: 22 },
      { dx: -34, dy: -12 },
      { dx: 34, dy: -12 },
      { dx: -34, dy: 12 },
      { dx: 34, dy: 12 },
    ];
    let forceSpinProbeIndex = 0;
    const playReadyAt = Date.now();

    if (!preGameRes.ready) {
      console.warn(
        `[auto-play] play screen chưa ready sau ${preGameRes.iterations} iter (${preGameRes.reason}). Tiếp tục dù sao.`,
      );
    } else {
      console.log(
        `[auto-play] ✔ play screen ready sau ${preGameRes.iterations} iter, dismissed ${preGameRes.dismissed} blockers`,
      );
      if (fallbackSpinCenter) {
        console.log(
          `[auto-play] fallback spin center from pre-game: (${fallbackSpinCenter.x}, ${fallbackSpinCenter.y})`,
        );
      }
      if (forceSpinEnabled && forceSpinCenter) {
        console.log(
          `[auto-play] force-spin enabled for PP: window=${forceSpinWindowMs}ms, center=(${forceSpinCenter.x}, ${forceSpinCenter.y})`,
        );
      }
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
      const inForceWindow =
        forceSpinEnabled &&
        forceSpinCenter &&
        Date.now() - playReadyAt < forceSpinWindowMs;

      if (inForceWindow) {
        const off = forceSpinOffsets[forceSpinProbeIndex % forceSpinOffsets.length]!;
        forceSpinProbeIndex++;
        const fx = Math.max(1, Math.min(VIEWPORT.width - 1, forceSpinCenter.x + off.dx));
        const fy = Math.max(1, Math.min(VIEWPORT.height - 1, forceSpinCenter.y + off.dy));
        console.log(`\n[iter ${i}] force-spin probe (${fx}, ${fy})`);

        await page.mouse.move(fx, fy);
        await page.waitForTimeout(90);
        await page.mouse.click(fx, fy);
        const saw = await waitForSpinResponse(page, 1_500);
        console.log(`[iter ${i}] force-spin API response: ${saw}`);

        const syntheticDecision: AIDecision = {
          action: "click",
          x: fx,
          y: fy,
          reason: "Force-spin probe in startup window",
          confidence: 1,
          observed_balance: null,
          observed_win: null,
          spin_state: "idle",
        };
        iterations.push({
          iter: i,
          t: Date.now() - recorder.t0,
          screenshot: "",
          decision: syntheticDecision,
          sawApiResponse: saw,
        });

        if (saw) {
          spinsCompleted++;
          console.log(`[iter ${i}] ✔ spin ${spinsCompleted}/${spinsTarget} (force-spin)`);
          await page.waitForTimeout(2_500);
        } else {
          await page.waitForTimeout(350);
        }
        continue;
      }

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
        const spinIntent = isSpinIntent(decision.reason);
        const spinPromise = spinIntent ? waitForSpinResponse(page) : null;

        await page.mouse.move(decision.x, decision.y);
        await page.waitForTimeout(150);
        await page.mouse.click(decision.x, decision.y);

        const waitStart = Date.now();
        if (spinPromise) {
          logEntry.sawApiResponse = await spinPromise;
          console.log(`[iter ${i}] spin API response: ${logEntry.sawApiResponse}`);
          if (!logEntry.sawApiResponse && spinIntent && fallbackSpinCenter) {
            console.log(
              `[iter ${i}] no API response from AI click, retry at pre-game spin center (${fallbackSpinCenter.x}, ${fallbackSpinCenter.y})`,
            );
            await page.mouse.move(fallbackSpinCenter.x, fallbackSpinCenter.y);
            await page.waitForTimeout(120);
            await page.mouse.click(fallbackSpinCenter.x, fallbackSpinCenter.y);
            logEntry.usedSpinFallbackClick = true;
            let fallbackSawResponse = await waitForSpinResponse(page, 5_000);
            // Probe nearby points when vision coordinates drift from actual canvas hitbox.
            if (!fallbackSawResponse) {
              const probeOffsets = [
                { dx: -40, dy: 0 },
                { dx: 40, dy: 0 },
                { dx: 0, dy: -40 },
                { dx: 0, dy: 40 },
                { dx: -30, dy: -30 },
                { dx: 30, dy: -30 },
                { dx: -30, dy: 30 },
                { dx: 30, dy: 30 },
              ];
              for (const p of probeOffsets) {
                const px = Math.max(1, Math.min(VIEWPORT.width - 1, fallbackSpinCenter.x + p.dx));
                const py = Math.max(1, Math.min(VIEWPORT.height - 1, fallbackSpinCenter.y + p.dy));
                console.log(`[iter ${i}] probing spin hitbox at (${px}, ${py})`);
                await page.mouse.move(px, py);
                await page.waitForTimeout(100);
                await page.mouse.click(px, py);
                fallbackSawResponse = await waitForSpinResponse(page, 1_500);
                if (fallbackSawResponse) break;
              }
            }
            logEntry.sawApiResponse = fallbackSawResponse;
            console.log(`[iter ${i}] spin API response after fallback: ${fallbackSawResponse}`);
          }
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
      if (decision.action === "click" && isSpinIntent(decision.reason) && logEntry.sawApiResponse) {
        spinsCompleted++;
        console.log(`[iter ${i}] ✔ spin ${spinsCompleted}/${spinsTarget} (detected via API)`);
      }

      // Stuck detection: track spin clicks không tăng progress + balance frozen.
      const wasSpinClick = decision.action === "click" && isSpinIntent(decision.reason);
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

    // Record at least one history endpoint request/response pair for later
    // statistical history audit template extraction.
    await captureHistoryEndpointTraffic(page, gameUrl, info.gameSlug);
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
