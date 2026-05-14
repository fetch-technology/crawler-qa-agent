import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { parseGameUrl, redactUrl, forceLangIfRequested } from "./utils/url.js";
import { resolveGameUrl } from "./utils/resolve-game-url.js";
import { attachRecorder } from "./recorder/attach.js";
import {
  decideRulesFlow,
  transcribeRulesPage,
  type RulesFlowDecision,
  type TranscribedRulesPage,
} from "./ai/vision.js";
import { keepBrowserOpenIfRequested } from "./utils/keep-browser-open.js";
import { waitForGamePlayScreen } from "./runner/pre-game.js";

loadEnv();

const VIEWPORT = { width: 1440, height: 900 };

type NavLog = {
  iter: number;
  t: number;
  screenshot: string;
  decision: RulesFlowDecision;
};

type CapturedRulesPage = {
  pageNumber: number;
  screenshot: string;
  transcribed?: TranscribedRulesPage;
};

function pageKey(d: RulesFlowDecision): string {
  // Để dedupe khi AI báo cùng page nhiều lần
  return `page=${d.current_page ?? "x"}|total=${d.estimated_total_pages ?? "x"}`;
}

async function main() {
  const gameUrl = resolveGameUrl("rules");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY) trong .env");
    process.exit(1);
  }

  const info = parseGameUrl(gameUrl);
  const outBase = process.env.RULES_OUT_DIR ?? "fixtures/rules";
  const maxIterations = Number(process.env.RULES_MAX_ITERATIONS ?? 40);
  const maxPages = Number(process.env.RULES_MAX_PAGES ?? 10);
  const loadTimeout = Number(process.env.AUTO_LOAD_TIMEOUT_MS ?? 90_000);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outBase, `${info.gameSlug}__${runId}`);

  console.log("================================================================");
  console.log(` EXTRACT-RULES: ${info.gameSlug}`);
  console.log(` URL           : ${redactUrl(gameUrl)}`);
  console.log(` Max iters     : ${maxIterations}, max pages: ${maxPages}`);
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

  const navLog: NavLog[] = [];
  const captured: CapturedRulesPage[] = [];
  const seenPageKeys = new Set<string>();
  let stopReason = "completed";

  // Detect new tabs/popups (một số provider mở rules ở tab mới)
  const extraPages: Page[] = [];
  context.on("page", async (p) => {
    extraPages.push(p);
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      const idx = extraPages.length;
      const shot = join(runDir, "screenshots", `extra-tab-${idx}.png`);
      await p.screenshot({ path: shot });
      console.log(`[tab] New tab opened (${extraPages.length}): ${p.url().slice(0, 100)} → ${shot}`);
    } catch {}
  });

  try {
    const finalUrl = forceLangIfRequested(gameUrl);
    if (finalUrl !== gameUrl) {
      console.log(`[lang] URL force-lang: ${redactUrl(finalUrl)}`);
    }
    await page.goto(finalUrl, { waitUntil: "domcontentloaded" });

    // Loop AI cho tới khi play screen ready (dismiss mọi blocker)
    await page.waitForTimeout(2_500);
    const preGameRes = await waitForGamePlayScreen(page, {
      viewport: VIEWPORT,
      label: "pre-game",
      maxIterations: Number(process.env.PRE_GAME_MAX_ITERATIONS ?? 25),
    });
    console.log(
      `[extract-rules] play screen ${preGameRes.ready ? "ready" : "NOT READY"} sau ${preGameRes.iterations} iter, dismissed ${preGameRes.dismissed} blockers`,
    );

    let lastDecision: { action: string; reason: string; phase: string } | null = null;
    let consecutiveWaits = 0;
    let sameStateCount = 0;
    let lastStateKey = "";
    // Detect cycle A↔B (ví dụ: click menu → dismiss modal → click menu → dismiss modal)
    const recentPhases: string[] = [];

    for (let i = 0; i < maxIterations; i++) {
      if (captured.length >= maxPages) {
        console.log(`[iter ${i}] Đã đạt max ${maxPages} pages, dừng navigation`);
        break;
      }

      const t = Date.now() - recorder.t0;
      const screenshot = join(runDir, "screenshots", `nav-${i.toString().padStart(3, "0")}.png`);
      await page.screenshot({ path: screenshot });

      console.log(`\n[iter ${i}] pages=${captured.length} — hỏi AI...`);
      let decision: RulesFlowDecision;
      try {
        decision = await decideRulesFlow({
          screenshotPath: screenshot,
          viewport: VIEWPORT,
          iteration: i,
          pagesCaptured: captured.length,
          lastAction: lastDecision,
        });
      } catch (err) {
        console.error(`[iter ${i}] AI error:`, err);
        stopReason = "ai-error";
        break;
      }

      console.log(
        `[iter ${i}] action=${decision.action} phase=${decision.phase} page=${decision.current_page ?? "?"}/${decision.estimated_total_pages ?? "?"} visible=${decision.rules_visible} conf=${decision.confidence.toFixed(2)}`,
      );
      console.log(`[iter ${i}] reason: ${decision.reason}`);

      navLog.push({ iter: i, t, screenshot, decision });

      // Capture mỗi page khi AI thấy nó visible + có page number, bất kể phase.
      // AI đang ở phase=next_page nghĩa là nó đang NHÌN page hiện tại và quyết định
      // click forward → chính xác thời điểm để capture.
      if (decision.rules_visible && decision.current_page != null) {
        const key = pageKey(decision);
        if (!seenPageKeys.has(key)) {
          seenPageKeys.add(key);
          const pageShot = join(runDir, "screenshots", `rules-page-${decision.current_page.toString().padStart(2, "0")}.png`);
          await page.screenshot({ path: pageShot });
          captured.push({
            pageNumber: decision.current_page,
            screenshot: pageShot,
          });
          console.log(`[iter ${i}] ✔ Captured rule page ${decision.current_page} (total captured: ${captured.length})`);

          // Chỉ break khi đã qua hết page VÀ AI thực sự nói completed/done (không phải next_page)
          const atLastPage =
            decision.estimated_total_pages != null &&
            decision.current_page >= decision.estimated_total_pages;
          if (atLastPage && decision.phase !== "next_page") {
            console.log(`[iter ${i}] Đã đến trang cuối ${decision.current_page}/${decision.estimated_total_pages} — done`);
            break;
          }
        }
      }

      // Detect stuck: cùng state nhiều lần
      const stateKey = `${decision.phase}|page=${decision.current_page ?? "x"}|visible=${decision.rules_visible}`;
      if (stateKey === lastStateKey) {
        sameStateCount++;
        if (sameStateCount >= 4) {
          console.warn(`[iter ${i}] Kẹt state ${stateKey} 4 lần — break`);
          stopReason = "stuck";
          break;
        }
      } else {
        sameStateCount = 0;
        lastStateKey = stateKey;
      }

      // Detect cycle A↔B (vd: finding_rules_button ↔ dismissing_modal)
      recentPhases.push(decision.phase);
      if (recentPhases.length > 8) recentPhases.shift();
      if (recentPhases.length >= 6 && !decision.rules_visible) {
        const last6 = recentPhases.slice(-6);
        const unique = new Set(last6);
        const isAltABAB =
          unique.size === 2 &&
          last6[0] === last6[2] && last6[2] === last6[4] &&
          last6[1] === last6[3] && last6[3] === last6[5];
        if (isAltABAB) {
          console.warn(`[iter ${i}] Phát hiện cycle ${last6.join("→")} — break`);
          stopReason = "cycle_detected";
          break;
        }
      }

      if (decision.action === "click") {
        await page.mouse.move(decision.x, decision.y);
        await page.waitForTimeout(150);
        await page.mouse.click(decision.x, decision.y);
        await page.waitForTimeout(2_000);
        consecutiveWaits = 0;
      } else if (decision.action === "scroll") {
        const dir = decision.scroll_direction ?? "down";
        const amount = decision.scroll_amount ?? 400;
        const delta = dir === "up" ? -amount : amount;
        const sx = decision.x > 0 ? decision.x : Math.floor(VIEWPORT.width / 2);
        const sy = decision.y > 0 ? decision.y : Math.floor(VIEWPORT.height / 2);
        await page.mouse.move(sx, sy);
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(1_200);
        console.log(`[iter ${i}] scroll ${dir} ${amount}px at (${sx},${sy})`);
        consecutiveWaits = 0;
      } else if (decision.action === "wait") {
        await page.waitForTimeout(2_000);
        consecutiveWaits++;
        if (consecutiveWaits >= 5) {
          console.warn(`[iter ${i}] 5 waits liên tiếp — break`);
          stopReason = "stuck-waiting";
          break;
        }
      } else if (decision.action === "done") {
        console.log(`[iter ${i}] AI báo done`);
        stopReason = "ai-done";
        break;
      } else if (decision.action === "error") {
        console.error(`[iter ${i}] AI báo error`);
        stopReason = "ai-error-state";
        break;
      }

      lastDecision = { action: decision.action, reason: decision.reason, phase: decision.phase };
    }

    console.log(`\n[transcribe] Đọc nội dung ${captured.length} trang rules...`);
    for (const cap of captured) {
      console.log(`[transcribe] page ${cap.pageNumber}...`);
      try {
        cap.transcribed = await transcribeRulesPage({
          screenshotPath: cap.screenshot,
          pageNumber: cap.pageNumber,
        });
      } catch (err) {
        console.error(`[transcribe] page ${cap.pageNumber} failed:`, err);
      }
    }
  } catch (err) {
    console.error("Fatal:", err);
    stopReason = "exception";
  } finally {
    console.log(`\n<<< Extract-rules kết thúc (${stopReason}). Flush output...`);
    await page.screenshot({ path: join(runDir, "screenshots", "final.png") }).catch(() => {});

    writeFileSync(join(runDir, "nav-log.json"), JSON.stringify(navLog, null, 2));
    writeFileSync(
      join(runDir, "rules.json"),
      JSON.stringify(
        {
          game: info.gameSlug,
          capturedAt: new Date().toISOString(),
          pageCount: captured.length,
          pages: captured.map((c) => ({
            pageNumber: c.pageNumber,
            screenshot: c.screenshot,
            transcribed: c.transcribed ?? null,
          })),
        },
        null,
        2,
      ),
    );

    // Markdown human-readable
    const md: string[] = [`# Rules — ${info.gameSlug}`, ""];
    md.push(`Captured: ${new Date().toISOString()}`);
    md.push(`Pages: ${captured.length}`, "");
    for (const c of captured) {
      md.push(`## Page ${c.pageNumber}`, "");
      if (c.transcribed?.title) md.push(`### ${c.transcribed.title}`, "");
      for (const s of c.transcribed?.sections ?? []) {
        md.push(`**${s.heading}**`, "", s.body, "");
      }
      if (c.transcribed?.symbols.length) {
        md.push(`**Symbols:**`, "");
        for (const s of c.transcribed.symbols) {
          const parts = [`- ${s.code ?? "?"} ${s.name ? `(${s.name})` : ""}`.trim()];
          if (s.multipliers) parts.push(`  × ${JSON.stringify(s.multipliers)}`);
          if (s.note) parts.push(`  — ${s.note}`);
          md.push(...parts);
        }
        md.push("");
      }
      if (c.transcribed?.features.length) {
        md.push(`**Features:**`, "");
        for (const f of c.transcribed.features) md.push(`- ${f}`);
        md.push("");
      }
      if (c.transcribed?.raw_text) {
        md.push("<details><summary>Raw transcription</summary>", "");
        md.push("```", c.transcribed.raw_text, "```", "</details>", "");
      }
    }
    writeFileSync(join(runDir, "rules.md"), md.join("\n"));

    // Extract paytable HTML from recorder (share-ui-game-client)
    try {
      const httpPath = join(runDir, "http.jsonl");
      if (existsSync(httpPath)) {
        const lines = readFileSync(httpPath, "utf8").split("\n").filter(Boolean);
        let htmlCount = 0;
        for (const line of lines) {
          const e = JSON.parse(line);
          if (
            e.phase === "response" &&
            typeof e.url === "string" &&
            e.url.includes("share-ui-game-client") &&
            e.url.includes("pay-table") &&
            typeof e.body === "string" &&
            e.body.trim().startsWith("<!DOCTYPE")
          ) {
            htmlCount++;
            writeFileSync(join(runDir, `paytable-html-${htmlCount}.html`), e.body);
          }
        }
        if (htmlCount > 0) console.log(`Đã trích ${htmlCount} paytable HTML từ traffic`);
      }
    } catch (err) {
      console.warn("Không trích được paytable HTML:", err);
    }

    await recorder.finalize({
      gameUrl,
      gameSlug: info.gameSlug,
      operator: info.operator,
      stopReason,
      extra: {
        pagesCaptured: captured.length,
        iterationsRun: navLog.length,
      },
    });

    await keepBrowserOpenIfRequested(page);

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log(`\n✔ Output: ${runDir}`);
    console.log(` - rules.json     (${captured.length} pages transcribed)`);
    console.log(` - rules.md       (human-readable)`);
    console.log(` - nav-log.json   (${navLog.length} iterations)`);
    console.log(` - screenshots/rules-page-*.png`);
    console.log(` - http.jsonl, summary.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
