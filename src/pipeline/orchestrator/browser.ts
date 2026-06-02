import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as net from "node:net";

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** HTTP CDP endpoint exposed by the launched browser (e.g.
   *  "http://localhost:53827"). Set when --remote-debugging-port is added to
   *  launch args. Other CDP clients (Playwright MCP via --cdp-endpoint) can
   *  attach to the SAME browser instance via this URL — agent + QA both see
   *  the same page. */
  cdpEndpoint?: string;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

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
  // Expose a CDP TCP endpoint so external clients (Playwright MCP for the
  // crop-verify agent) can attach to the SAME browser instance — they see
  // exactly the page QA is viewing, no need to spawn a separate browser.
  // Playwright internally uses --remote-debugging-pipe, NOT the TCP port, so
  // both channels coexist without conflict. Random free port avoids
  // collisions when multiple sessions run concurrently.
  const cdpPort = await getFreePort();
  const browser = await chromium.launch({
    headless,
    slowMo,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { browser, context, page, cdpEndpoint: `http://localhost:${cdpPort}` };
}

export async function closeBrowser(s: BrowserSession): Promise<void> {
  await s.context.close().catch(() => undefined);
  await s.browser.close().catch(() => undefined);
}
