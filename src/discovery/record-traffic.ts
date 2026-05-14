import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { parseGameUrl, redactUrl } from "../utils/url.js";
import { attachRecorder } from "../recorder/attach.js";

loadEnv();

async function main() {
  const gameUrl = process.env.GAME_URL;
  if (!gameUrl) {
    console.error("Thiếu GAME_URL. Copy .env.example -> .env và set GAME_URL.");
    process.exit(1);
  }

  const info = parseGameUrl(gameUrl);
  const outDir = process.env.RECORD_OUT_DIR ?? "fixtures/recordings";
  const duration = Number(process.env.RECORD_DURATION_MS ?? 120_000);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outDir, `${info.gameSlug}__${runId}`);

  console.log("================================================================");
  console.log(` Game          : ${info.gameSlug}`);
  console.log(` URL           : ${redactUrl(gameUrl)}`);
  console.log(` Operator      : ${info.operator ?? "-"}`);
  console.log(` Output dir    : ${runDir}`);
  console.log(` Record time   : ${duration}ms`);
  console.log("================================================================");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: join(runDir, "video"), size: { width: 1440, height: 900 } },
  });
  const page: Page = await context.newPage();

  const recorder = await attachRecorder(context, page, runDir);

  await page.goto(gameUrl, { waitUntil: "domcontentloaded" });

  const screenshotInterval = setInterval(async () => {
    try {
      const ts = Date.now() - recorder.t0;
      await page.screenshot({ path: join(runDir, "screenshots", `${ts}.png`), fullPage: false });
    } catch {}
  }, 5_000);

  console.log(`\n>>> Đang ghi traffic. Hãy chơi tay trong cửa sổ browser vừa mở.`);
  console.log(`>>> Recorder sẽ tự dừng sau ${duration}ms, hoặc nhấn Ctrl+C / đóng browser để dừng sớm.\n`);

  let stopReason = "timeout";
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), duration);
    process.once("SIGINT", () => {
      stopReason = "sigint";
      clearTimeout(timer);
      resolve();
    });
    page.once("close", () => {
      stopReason = "page-closed";
      clearTimeout(timer);
      resolve();
    });
  });

  clearInterval(screenshotInterval);
  console.log(`\n<<< Dừng ghi (${stopReason}). Đang flush output...`);

  await page.screenshot({ path: join(runDir, "screenshots", "final.png"), fullPage: false }).catch(() => {});

  await recorder.finalize({
    gameUrl,
    gameSlug: info.gameSlug,
    operator: info.operator,
    stopReason,
  });

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  console.log(`\n✔ Đã lưu recording vào: ${runDir}`);
  console.log(` - http.jsonl     (${recorder.counts.http} entries)`);
  console.log(` - ws.jsonl       (${recorder.counts.ws} entries)`);
  console.log(` - console.jsonl  (${recorder.counts.console} entries)`);
  console.log(` - summary.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
