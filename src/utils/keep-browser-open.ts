import type { Page } from "playwright";

/**
 * Nếu QA_KEEP_BROWSER_OPEN=1, hàm này sẽ treo cho đến khi user đóng browser tay.
 * Dùng cho các script chạy Playwright Library trực tiếp (auto-play, extract-rules).
 */
export async function keepBrowserOpenIfRequested(page: Page): Promise<void> {
  const keep = process.env.QA_KEEP_BROWSER_OPEN;
  if (keep !== "1" && keep !== "true") return;
  console.log("\n>>> QA_KEEP_BROWSER_OPEN: Browser sẽ ở lại. Đóng cửa sổ (nút X) để kết thúc script.");
  await page.waitForEvent("close", { timeout: 0 });
  console.log("<<< Browser đã bị đóng thủ công, script kết thúc.");
}
