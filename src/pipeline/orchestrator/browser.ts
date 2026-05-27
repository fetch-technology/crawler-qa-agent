import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export async function openBrowser(headless = false): Promise<BrowserSession> {
  // In headed mode, slow down each interaction so a human can follow what's
  // happening. QA_SLOWMO=ms override (default 500ms in headed, 0 in headless).
  const slowMo = headless
    ? Number(process.env.QA_SLOWMO ?? 0)
    : Number(process.env.QA_SLOWMO ?? 500);
  // 1280×720 fits comfortably on most laptop screens for headed debugging.
  // Override via QA_VIEWPORT="WxH" if needed (e.g. "1920x1080" for HD test).
  const vp = (process.env.QA_VIEWPORT ?? "1280x720").split("x").map((n) => Number(n));
  const viewport = {
    width: Number.isFinite(vp[0]) ? vp[0]! : 1280,
    height: Number.isFinite(vp[1]) ? vp[1]! : 720,
  };
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function closeBrowser(s: BrowserSession): Promise<void> {
  await s.context.close().catch(() => undefined);
  await s.browser.close().catch(() => undefined);
}
