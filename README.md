# crawler-qa-agent

Slot-game QA automation: Playwright drives the live game, AI vision + network
parsing capture each spin, and a per-game learned registry generates and runs
test cases. Ships a web dashboard (login-gated, multi-QA) plus a CLI pipeline.

Runs on **tsx** — TypeScript executes directly, there is **no build/compile step**.

---

## 1. Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| **Node.js ≥ 20** | runtime (tsx, Playwright) | `node -v` |
| **npm** | install deps | bundled with Node |
| **Chromium** | Playwright browser | installed automatically by `postinstall` |
| **pm2** (optional) | run as a background daemon | `npm i -g pm2` — only for daemon mode |
| **ffmpeg** (optional) | per-case screen video | needed only if `QA_RECORD_VIDEO=1`; must be on `PATH` |
| **cpulimit** (optional) | CPU ceiling on shared hosts | `brew install cpulimit` — see [§7](#7-cpu-ceiling-shared-hosts) |
| **Docker + Postgres/Redis** (optional) | statistical-sim queue only | `npm run db:up`; NOT needed for the dashboard/QA flow |

A **Claude credential is required** (the AI vision/catalog calls). Either a
Claude Code OAuth token or an Anthropic API key — see [§3](#3-configure-env).

---

## 2. Install

```bash
git clone <repo-url> crawler-qa-agent
cd crawler-qa-agent
npm install          # postinstall runs `playwright install chromium`
```

If the Chromium download was skipped (offline/CI), run it manually:

```bash
npx playwright install chromium
```

---

## 3. Configure (.env)

Copy the template and fill in the required values:

```bash
cp .env.example .env
```

Minimum to run the dashboard:

```bash
# Claude auth — REQUIRED (one of these)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# ANTHROPIC_API_KEY=sk-ant-api03-...     # alternative

# Dashboard login — seeds the FIRST admin on startup when no users exist yet.
# Set a strong password (do NOT reuse a dev one).
QA_ADMIN_USER=admin
QA_ADMIN_PASSWORD=<strong-password>

# Port (default 3200)
# PORT=3200
```

Notes:
- **Get the Claude token** with the Claude Code CLI:
  ```bash
  claude setup-token
  ```
  Copy the printed `sk-ant-oat01-…` token into `CLAUDE_CODE_OAUTH_TOKEN`.
  (Alternatively use an `ANTHROPIC_API_KEY`.)
- The dashboard is **login-gated**. On first boot with an empty user store, the
  app seeds an admin from `QA_ADMIN_USER` / `QA_ADMIN_PASSWORD`. After logging in
  you can manage QA accounts from the **Users** panel — the env vars are then
  optional. User/session data lives in `fixtures/auth/` (gitignored).
- Per-QA Claude token: each QA can paste their own token in the dashboard (🔑
  badge); it's stored in their browser only and billed to their account. The
  env token is the shared fallback.
- `.env` is gitignored — never commit secrets. Rotate any key that leaks.

---

## 4. Run the dashboard

**Dev / foreground:**

```bash
npm run serve
```

Open **http://localhost:3200/** → you'll be redirected to `/login`. Sign in with
the seeded admin, then paste a game launch URL to start a session.

## 5. Verify it's up

```bash
curl -s http://localhost:3200/api/qa/version
# {"build":"2026-06-..","startedAt":"..."}
```

`/api/qa/version` is public (no auth) and prints the **build marker** — use it to
confirm which code a server is actually running after a deploy. The same marker
is logged at startup (`build: …`).

---

## 6. Deploy / update an existing server

tsx means no build — pull and restart:

```bash
git pull
npm install            # only if dependencies changed
npm run serve:restart  # or: pm2 restart qa --update-env
curl -s http://localhost:3200/api/qa/version   # confirm the new build marker
```

`git pull` never touches `fixtures/auth/` or `.env`, so accounts + secrets on
that host are preserved.

---

## 7. CPU ceiling (shared hosts)

When co-located with other services, the daemon runs under a CPU cap via
`scripts/qa-server.sh` (`cpulimit -l <cores×100>%`). Tune in `ecosystem.config.cjs`:

```js
QA_CPU_CORES: "7",      // ~7 cores; set QA_CPU_LIMIT=0 to disable
UV_THREADPOOL_SIZE: "7" // libuv worker pool (OCR/image fs)
```

If `cpulimit` isn't installed the wrapper runs **uncapped** (logs a warning) —
install it with `brew install cpulimit` to enforce the cap.

---

## 8. Tests

```bash
npm test                 # full Playwright suite
npm run test:invariants  # fast invariant unit tests (pure logic, no browser)
```

Invariant tests are the quick gate after a change. A few `spec-driven-parser`
cases require a provider fixture that isn't committed and fail on a clean
checkout — that's expected; everything else should pass.

---