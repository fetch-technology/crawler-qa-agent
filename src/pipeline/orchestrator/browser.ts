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

/**
 * Per-browser proxy for geo-restricted games. Some games only load from an IP
 * in an allowed country; instead of putting the whole host on a VPN, route ONLY
 * the game browser through a proxy/VPN endpoint (the server's Claude/DB traffic
 * stays direct). Opt-in via env — unset → no proxy, behaviour unchanged.
 *
 *   QA_PROXY=socks5://127.0.0.1:1080         # SSH dynamic-forward / local VPN
 *   QA_PROXY=http://gw.example.com:8080      # HTTP(S) proxy
 *   QA_PROXY_USER / QA_PROXY_PASS            # proxy auth (HTTP only — see note)
 *   QA_PROXY_BYPASS="*.local,127.0.0.1"      # comma-list of no-proxy hosts
 *
 * Note: Chromium (via Playwright) does NOT support SOCKS5 *with* auth — use an
 * HTTP proxy for authenticated endpoints, or an unauthenticated SOCKS5 (e.g. an
 * SSH `-D` tunnel) for geo routing.
 */
function proxyFromEnv(): { server: string; username?: string; password?: string; bypass?: string } | undefined {
  const server = process.env.QA_PROXY?.trim();
  if (!server) return undefined;
  return {
    server,
    username: process.env.QA_PROXY_USER?.trim() || undefined,
    password: process.env.QA_PROXY_PASS || undefined,
    bypass: process.env.QA_PROXY_BYPASS?.trim() || undefined,
  };
}

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
  const proxy = proxyFromEnv();
  if (proxy) {
    console.log(`[browser] routing via proxy ${proxy.server}${proxy.username ? " (auth)" : ""}${proxy.bypass ? ` bypass=${proxy.bypass}` : ""}`);
  }
  // Launch the user's REAL Google Chrome (channel: "chrome") instead of
  // Playwright's bundled Chromium. Bundled Chromium lacks proprietary codecs
  // (H.264/AAC) and ships a different GPU/WebGL backend, so many PIXI/WebGL slot
  // loaders get STUCK on the loading screen even though they load fine in real
  // Chrome. We also strip the automation fingerprint (navigator.webdriver via
  // --disable-blink-features=AutomationControlled, and the --enable-automation
  // default arg) that some game loaders' anti-bot checks stall on.
  // Override with QA_BROWSER_CHANNEL ("chromium" forces bundled; "msedge",
  // "chrome-beta", … pick another channel). Falls back to bundled Chromium when
  // the requested channel isn't installed, so the server always boots.
  const baseOpts: Parameters<typeof chromium.launch>[0] = {
    headless,
    slowMo,
    args: [
      `--remote-debugging-port=${cdpPort}`,
      "--disable-blink-features=AutomationControlled",
      // WebGL — Cocos/PIXI slot engines REQUIRE a WebGL context or they crash
      // on init and the loader sticks (observed: "This device does not support
      // WebGL" → getExtension on a null gl). When this Chrome can't get a
      // hardware GL context (no GPU session on the Mac mini / headless), modern
      // Chrome refuses WebGL UNLESS software fallback is explicitly allowed.
      // These let it use hardware GL when available and fall back to SwiftShader
      // (software, CPU-bound) otherwise — so the game always gets a context.
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      ...(process.env.QA_FORCE_SWIFTSHADER === "1" ? ["--use-gl=angle", "--use-angle=swiftshader"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    ...(proxy ? { proxy } : {}),
  };
  const channelEnv = (process.env.QA_BROWSER_CHANNEL ?? "chrome").trim();
  const channel = channelEnv && channelEnv.toLowerCase() !== "chromium" ? channelEnv : undefined;
  let browser: Browser;
  // Log the resolved launch config so a restart can be CONFIRMED to pick up the
  // WebGL/channel flags (a stale server is the #1 reason a fix "didn't work").
  console.log(`[browser] launching channel=${channel ?? "chromium(bundled)"} headless=${headless} args=${JSON.stringify(baseOpts.args)}`);
  try {
    browser = await chromium.launch(channel ? { ...baseOpts, channel } : baseOpts);
    if (channel) console.log(`[browser] launched real "${channel}" (full codecs + GPU, automation flags stripped)`);
  } catch (err) {
    if (!channel) throw err;
    console.warn(`[browser] channel "${channel}" unavailable (${err instanceof Error ? err.message : String(err)}) → falling back to bundled Chromium`);
    browser = await chromium.launch(baseOpts);
  }
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { browser, context, page, cdpEndpoint: `http://localhost:${cdpPort}` };
}

export async function closeBrowser(s: BrowserSession): Promise<void> {
  await s.context.close().catch(() => undefined);
  await s.browser.close().catch(() => undefined);
}
