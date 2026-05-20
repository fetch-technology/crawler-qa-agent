import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["html", { outputFolder: "reports/html", open: "never" }], ["list"]],
  use: {
    // Headed: maximize window để hiện đầy đủ game UI (spin button, balance,
    // bet display). Chrome bars chiếm vertical space → nếu viewport=1440×900
    // FIX cứng + window không maximize → bottom UI bị cắt.
    //
    // viewport=null → page sử dụng actual window size (sau khi maximize) thay
    // vì emulate fixed 1440×900. Tuy nhiên Playwright recommend explicit viewport
    // cho determinism — nên trong test khi tính scale coord, dùng `page.viewportSize()`
    // để fallback `page.evaluate(() => ({width: innerWidth, height: innerHeight}))`.
    headless: process.env.QA_HEADLESS === "1",
    viewport: process.env.QA_FULLSCREEN === "1" ? null : { width: 1440, height: 900 },
    launchOptions: {
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        ...(process.env.QA_FULLSCREEN === "1" ? ["--start-maximized"] : []),
        "--disable-blink-features=AutomationControlled",
      ],
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
