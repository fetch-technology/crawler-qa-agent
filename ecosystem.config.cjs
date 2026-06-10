// pm2 process configuration for the crawler-qa-agent dashboard server.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs qa
//   pm2 restart qa
//   pm2 stop qa
//
// Boot autostart (macOS):
//   pm2 startup launchd        # prints a `sudo launchctl …` command — run it
//   pm2 save                   # snapshot current process list
//
// .env is loaded by the app itself (dotenv.config() in src/server/index.ts),
// so we don't duplicate env values here. We DO inject PATH because pm2 (when
// started from a non-interactive context like launchd) inherits a minimal
// PATH that omits Homebrew, which means `spawn("ffmpeg", …)` fails with
// ENOENT and case-video recording silently skips on the Mac mini.

module.exports = {
  apps: [
    {
      name: "qa",
      // Launch via the wrapper so the server runs under a CPU ceiling
      // (cpulimit -l <cores*100>%). Lets a co-located service on the same Mac
      // mini keep headroom. The wrapper falls back to running UNCAPPED if
      // cpulimit isn't installed, so the server always boots. Tune with
      // QA_CPU_CORES (default 7) / QA_CPU_LIMIT=0 to disable. See scripts/qa-server.sh.
      script: "./scripts/qa-server.sh",
      interpreter: "bash",
      cwd: __dirname,
      // Keep ONE instance — game session state lives in-memory.
      instances: 1,
      exec_mode: "fork",
      // Auto-restart on crash; back off on tight loops.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      // Don't restart on file changes — long-running game sessions would
      // die mid-onboard. Use `pm2 restart qa` manually after deploys.
      watch: false,
      // Cap memory growth (Playwright + Tesseract + crop snapshots) — pm2
      // restarts the process if it exceeds. Adjust if you see frequent kills.
      max_memory_restart: "2G",
      // Log paths under ./logs (gitignored). Combined output for easy tail.
      out_file: "./logs/qa.out.log",
      error_file: "./logs/qa.err.log",
      merge_logs: true,
      time: true, // prefix each log line with timestamp
      env: {
        NODE_ENV: "production",
        // CPU ceiling for the testing tool — keep ~7 of 8 cores so a
        // co-located service has room. The wrapper maps this to
        // `cpulimit -l <QA_CPU_CORES*100>%`. Set QA_CPU_LIMIT=0 to disable.
        QA_CPU_CORES: "7",
        // Cap Node's libuv worker-thread pool (OCR/image fs work) too. Default
        // is 4; pin to the same budget so background async doesn't oversubscribe.
        UV_THREADPOOL_SIZE: "7",
        // Ensure Homebrew binaries (ffmpeg, etc.) resolve from the pm2-
        // managed process. Without this, /opt/homebrew/bin isn't on PATH
        // when pm2 is started via launchd / system boot and ffmpeg is missing
        // → QA_RECORD_VIDEO silently disabled. Append rather than overwrite
        // so default system paths still work.
        PATH: [
          "/opt/homebrew/bin",       // Apple Silicon Homebrew
          "/usr/local/bin",          // Intel Homebrew + manual installs
          process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        ].join(":"),
      },
    },
  ],
};
