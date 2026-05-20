# Tổng quan hệ thống — crawler-qa-agent

> Tài liệu sống: phản ánh trạng thái hiện tại của codebase sau các fix gần đây
> (Game Adapter, deterministic test layer, DB write-through, smart hybrid routing).
> Cập nhật lần cuối: 2026-05-18.

---

## 1. Mục tiêu

Test automation cho slot/casino canvas game với 3 mục đích chính:

1. **Discovery** — game mới chưa có data: AI tự khám phá UI, capture traffic, sinh `GameSpec` + test catalog.
2. **Regression** — game đã có recording: chạy lại deterministic mock thay vì spin thật → fast + cheap.
3. **Math validation** — bắn 10k-100k spins trực tiếp tới spin endpoint → verify RTP, hit rate, volatility, symbol distribution.

Triết lý: **Deterministic core + AI-assisted discovery & reporting**. AI chỉ dùng khi không có lựa chọn khác (game lạ, popup non-deterministic, screenshot OCR, bug summary).

---

## 2. Kiến trúc tổng quát

```
                       ┌──────────────────┐
                       │ Dashboard (HTTP) │
                       │ Port 3200        │
                       └────────┬─────────┘
                                │
                  ┌─────────────┼──────────────┐
                  ▼             ▼              ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────┐
        │ TaskQueue    │ │ BullMQ       │ │ Static   │
        │ (in-memory)  │ │ (Redis)      │ │ files    │
        └──────┬───────┘ └──────┬───────┘ └──────────┘
               │                │
               ▼                ▼
        ┌──────────────────────────────┐
        │ TaskRunner / Stats Worker     │
        │ spawn subprocess              │
        └──────┬───────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌──────────────┐  ┌──────────────────┐
│ generate-and │  │ statistical CLI  │
│ -run.ts      │  │ simulate.ts      │
└──────┬───────┘  └──────┬───────────┘
       │                 │
       ▼                 ▼
┌──────────────────────────────────────────┐
│  Playwright + GameAdapter + Rule Engine  │
└──────────────────────┬───────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌─────────────────┐         ┌──────────────────┐
│ fixtures/       │         │ PostgreSQL       │
│ (filesystem)    │         │ (env-gated)      │
└─────────────────┘         └──────────────────┘
```

### Stack thực tế (sau migration một phần)

| Layer | Implementation |
|---|---|
| Backend | Node `http` thuần (không NestJS) |
| Queue | In-memory `TaskQueue` (cho LLM tasks) + BullMQ trên Redis (cho stats jobs) |
| Database | PostgreSQL + Prisma — env-gated qua `DATABASE_URL`, no-op khi không set |
| Frontend | Vanilla JS + HTML + CSS (không Next.js) |
| Automation | Playwright (Chromium) |
| AI | Anthropic Claude (`@anthropic-ai/sdk` + claude-agent-sdk) |

---

## 3. Ba luồng test

### 3.1 Flow A — Discovery (LLM-driven, expensive)

Mục đích: game mới chưa có recording. AI xử lý từ A→Z.

```
Create Task (URL)
  ↓
1. Collect Context     [auto-play.ts]
     ├ vision navigate + dismiss popup        ($0.05-0.20)
     ├ capture HTTP/WS traffic
     ├ extract paytable/options/config        (vision OCR)
     ├ generate GameSpec via AI               ($0.05)
     ├ auto-extract scenarios → fixtures/scenarios/
     └ AUTO capture pre-game clicks → fixtures/pre-game/  (QA_CAPTURE_PREGAME=1)
  ↓
2. Generate Tests      [generate-and-run.ts]
     ├ AI sinh TestCaseCatalog (33 cases)     ($0.05-0.15)
     ├ emit Playwright spec qua hybrid-case-mapper:
     │    tests/generated/{slug}.spec.ts          (LLM-driven, vision-per-spin)
     │    tests/generated/{slug}.hybrid.spec.ts   (deterministic, replay-pre-game)
     │    tests/generated/{slug}.unified.spec.ts  (mix)
     └ markdown export cho QA review
  ↓
3. Run Tests           [smart routing]
     ├ Nếu có generated hybrid spec → chạy nó      (RECOMMEND)
     ├ Else nếu có scenarios → chạy hand-written hybrid
     └ Else → vision-per-spin (legacy, $1-10)
```

### 3.2 Flow B — Deterministic regression (cheap)

Mục đích: chạy lại test sau khi đã có scenarios + pre-game recording.

```
Run Tests (lần thứ N)
  ↓
Playwright launch tests/generated/{slug}.hybrid.spec.ts
  ↓
For each test case:
  ├ makeDeterministic(page, {slug, scenario, spinOnly: true})
  │   └ mount route handler: /spin → recorded response
  ├ page.goto(GAME_URL)
  ├ preGameWithReplayOrVision(page, {slug}):
  │   ├ Try replay (load fixtures/pre-game/{slug}.json)
  │   │   ├ Replay clicks at recorded coords + delays
  │   │   └ Verify play-screen-ready via region snapshot
  │   ├ If verify OK → ready (source=replay, $0, ~3s)
  │   └ Else fallback waitForGamePlayScreen (vision, $0.05-0.20)
  │       └ Auto-heal baseline if vision succeeded
  ├ spinDeterministic(page, handle, {spinButton}) — click + mock fires
  └ assertSpinMatchesExpected(result, scenario.expected)
     + per-case assertions (matrix shape, round id, balance reconciliation, ...)
```

### 3.3 Flow C — Statistical math (bypass UI)

Mục đích: verify RTP, hit rate, volatility với 1k-100k+ spins.

```
Run Stats (button trên Task detail)
  ↓
runStatsSim(taskId, {spins, concurrency})
  ↓
src/statistical/simulate.ts:
  ├ Load latest recording fixtures/recordings/{slug}__*/http.jsonl
  ├ Extract spin request template (url + headers + body)
  ├ Preflight: 1 request test → reject nếu token expired (HTTP 401/403)
  ├ Fire N requests (concurrency=4 default) trực tiếp tới spin endpoint
  ├ Per response: parse → aggregate
  │    bet/win → Welford variance
  │    matrix → symbol distribution
  │    flags → free spin / bonus / retrigger counters
  └ Return SimulateResult với RTP, hitFrequency, volatility, etc.

Output:
  ├ fixtures/statistical/{slug}-{ts}.json
  └ DB: test_runs + stat_reports (env-gated)
```

Có thể distribute qua BullMQ:
```bash
npm run worker:stats          # terminal A
npm run stats -- slug --spins 100000 --queue   # terminal B
```

---

## 4. Module map

### `src/adapters/` — Game Adapter abstraction
Provider × Mechanic composition (xem doc §9 spec). Mỗi adapter = parser cho 1 game.

```
src/adapters/
├ types.ts                # GameAdapter, SpinRequest, SpinResponse, ValidationError
├ compose.ts              # composeGameAdapter(provider, mechanic, spec)
├ registry.ts             # resolveAdapter({slug, snapshot?, spec?})
├ index.ts                # barrel + bootstrapAdapters()
├ providers/
│  ├ generic.ts           # wraps spin-detect.ts heuristics
│  └ pragmatic.ts         # PP gs2c quirk + cascade
└ mechanics/
   ├ ways.ts              # left-to-right ways pay
   ├ paylines.ts          # fixed-line pay (Phase 3)
   └ cluster.ts           # flood-fill cluster (Phase 3)
```

API:
```ts
const adapter = resolveAdapter({ slug: "fiesta-magenta", spec, sampleUrl });
adapter.parseResponse(raw)       // SpinResponse normalized
adapter.validateSpin({request, response, spec})  // ValidationError[]
adapter.shouldMockRoute?({url, method, postData})  // PP-specific filter
```

### `src/runner/` — Test execution layer
```
src/runner/
├ deterministic.ts          # makeDeterministic(page, opts) — mock /spin
├ deterministic-spin.ts     # spinDeterministic() — click + assert
├ pre-game.ts               # waitForGamePlayScreen() — vision flow
├ pre-game-recording.ts     # PreGameRecording schema + load/save
├ pre-game-replay.ts        # replayPreGameClicks() + preGameWithReplayOrVision()
├ pre-game-stats.ts         # logPreGameAttempt() + aggregatePreGameStats()
├ pre-game-stats-cli.ts     # `npm run pregame-stats`
├ scenario.ts               # Scenario schema + classifyScenario
├ scenario-extractor.ts     # Recording → scenarios CLI
├ rule-engine.ts            # decodeReels + calculateWaysWin + assertPayoutMatchesPaytable
├ balance-reconciler.ts     # reconcileBalances() — free-spin aware
├ region-snapshot.ts        # pixel diff via pixelmatch
├ json-snapshot.ts          # JSON shape compare (structural/exact/values)
├ ui-verifier.ts            # OCR + assert vs API response
├ test-harness.ts           # doAutoSpin (legacy vision-per-spin loop)
├ response-synthesizer.ts   # Override scenario body (bet/win/cascade)
├ spin-detect.ts            # Cross-provider spin URL+body heuristics
└ case-reporter.ts          # Playwright reporter → EVENT:case_end lines
```

### `src/ai/` — LLM-assisted layer
```
src/ai/
├ claude.ts                 # askClaude() via claude-agent-sdk
├ vision.ts                 # decideNextAction, transcribePlayScreenValues, ...
├ authoring.ts              # GameSpec generation + emitHybridSpec
├ test-catalog.ts           # TestCaseCatalog schema
├ hybrid-case-mapper.ts     # Catalog → deterministic spec codegen
├ catalog-validator.ts      # Verify catalog cases reference valid invariants
├ catalog-markdown.ts       # Catalog → human-readable .md
├ game-analyzer.ts          # GameSpec → canonical §6 JSON
├ game-analyzer-cli.ts      # `npm run analyze:game`
├ bug-summarizer.ts         # ValidationError → AI-grouped markdown
├ bug-summarizer-cli.ts     # `npm run bug-summary`
├ config-extract.ts         # Structured fields from /config response
├ network-detect.ts         # AI pick spin endpoint from candidates
└ ...
```

### `src/db/` — PostgreSQL layer (env-gated)
```
src/db/
├ client.ts                 # getDb() singleton (lazy import @prisma/client)
├ index.ts                  # barrel
└ repositories/
   ├ test-run.ts            # createTestRun, upsertTestRun, clearTestRunChildren, list
   ├ spin-result.ts         # insertSpinResults (batch)
   ├ validation-error.ts    # insertValidationErrors + groupByType
   └ stat-report.ts         # upsertStatReport
```

Schema: 4 tables theo §10 spec — `test_runs`, `spin_results`, `validation_errors`, `stat_reports`.

### `src/queue/` — Redis + BullMQ
```
src/queue/
├ redis.ts                  # getRedis() singleton
├ stats-queue.ts            # BullMQ Queue for stats-batches
└ stats-worker.ts           # Worker entry: `npm run worker:stats`
```

### `src/server/` — Dashboard HTTP + task queue
```
src/server/
├ index.ts                  # HTTP entry, route table
├ queue.ts                  # In-memory TaskQueue + persistence to fixtures/tasks/
├ runner.ts                 # TaskRunner: spawn generate-and-run.ts, parse EVENT lines
├ db-writethrough.ts        # Lifecycle hooks: onRunPhaseStart/onSpinEvent/onCaseEnd/onTaskComplete
├ case-report.ts            # Aggregate case results → JSON + Markdown
└ types.ts                  # Task, CaseResult, TaskSpinEvent, ...
```

### `src/statistical/` — Math validation
```
src/statistical/
├ simulate.ts               # simulate() — fire N requests, aggregate metrics
└ cli.ts                    # `npm run stats`
```

---

## 5. Data lifecycle

### Filesystem layout (source of truth)

```
fixtures/
├ recordings/                            # Raw HTTP/WS capture
│  └ {slug}__{timestamp}/
│     ├ http.jsonl                       # Each request + response, line-delimited
│     ├ ws.jsonl                         # WebSocket frames
│     ├ console.jsonl                    # Browser console
│     ├ iterations.json                  # AI decisions (auto-play log)
│     └ screenshots/                     # Per-iteration screenshots
├ scenarios/                             # Labeled spin responses for deterministic mock
│  └ {slug}/
│     ├ no_win.json
│     ├ small_win.json
│     ├ normal_win.json
│     ├ big_win.json
│     └ bonus_trigger.json
├ pre-game/                              # Click sequence for deterministic replay
│  ├ {slug}.json                         # Clicks + ready_signal config
│  └ _stats.jsonl                        # Append-only attempt log
├ templates/                             # Pixel baselines
│  └ {slug}/
│     ├ play-screen-ready.png            # For pre-game replay verification
│     └ spin-button-idle.png             # Other region snapshots
├ specs/                                 # AI-generated artifacts per game
│  └ {slug}/
│     ├ {slug}.spec.json                 # GameSpec
│     ├ {slug}.test-cases.json           # TestCaseCatalog
│     ├ {slug}.test-cases.qa-review.md   # Human-readable
│     ├ {slug}.catalog-context.json      # AI inputs (provenance)
│     └ network-hints.json               # Spin endpoint candidate
├ snapshots/                             # JSON snapshot baselines
│  └ {slug}/
│     └ spin-response-shape.json
├ options/                               # AI extraction of UI options
│  └ {slug}__{timestamp}/
│     ├ options.json
│     ├ paytable.json
│     ├ play-screen.json
│     └ api-snapshot.json
├ analyzers/                             # Canonical §6 schema
│  └ {slug}.json
├ statistical/                           # Sim reports
│  └ {slug}-{ts}.json
└ tasks/                                 # Per-Task metadata + logs
   └ {task-id}/
      ├ log.jsonl
      ├ events.jsonl                     # Spin events
      ├ case-report.json + .md
      └ screenshots/
```

### DB write-through (env-gated by `DATABASE_URL`)

Runner lifecycle hooks ([src/server/db-writethrough.ts](../src/server/db-writethrough.ts)):

| Event | Action |
|---|---|
| Phase `run`/`all` start | `upsertTestRun({id: task.id, ...})` + `clearTestRunChildren()` |
| `EVENT:spin {...}` từ subprocess | `insertSpinResults([{...}])` |
| `EVENT:case_end {status: "failed"}` | `insertValidationErrors([{...}])` |
| Subprocess exit | `updateTestRunStatus({status, endedAt})` + `upsertStatReport({...})` |

Stats CLI cũng write-through:
- `createTestRun()` trước khi sim → status=running
- `upsertStatReport()` sau sim → full metrics
- `updateTestRunStatus({status: 'completed'})` final

Filesystem vẫn là source of truth — DB là **indexed view** cho UI.

---

## 6. UI workflow

Dashboard: `http://localhost:3200/dashboard`

### Section "New Task"
- Input: Game URL
- Spins/test: số spin mỗi test case
- ☐ Auto-run all phases (legacy: chạy luôn 1 mạch)

### Section "Tasks" (in-memory)
Bảng tasks LLM-driven với cột: Game / Provider / Status / Spins / RTP / Duration / Updated.

Click row → mở **Task Detail Panel** với toolbar:

```
[1. Collect Context]  [2. Generate Tests]  [3. Run Tests (smart)]
[📊 Run Stats]  [🎬 Re-record Pre-game]
[Cancel]  [↻ Retry all]  [🗑 Delete]
```

Tabs trong detail panel:
- **Test Cases** — list 33 cases với status pill (passed/failed/skipped/pending/running)
- **QA View** — human-readable bảng cho QA team
- **Context (AI inputs)** — rules + config + samples đã feed cho AI
- **JSON** — raw artifacts (spec, options, hints)
- **Errors** — group log entries level=error/warn
- **Spin Events** — bảng spins real-time
- **Screenshots** — per-iteration + per-case sub-folders
- **Full Log** — stream stdout/stderr

### Section "Test Runs (DB)" (env-gated)
History từ PostgreSQL. Cột: Game / Status / Spins / RTP / Hit rate / Volatility / Errors / Created.

Click row → **Test Run Detail** với 5 tabs:
- **Spins** — full SpinResult rows
- **Validation Errors** — group theo errorType
- **Stat Report** — RTP, volatility, feature frequency, symbol distribution, win distribution buckets
- **Bug Summary** — markdown từ Claude (click "Generate Bug Summary" để render)
- **Analyzer** — canonical §6 JSON (click "Analyzer Report")

---

## 7. Test types catch được

### Per-spin invariants
| Check | Module | Catch bug |
|---|---|---|
| Bet validation | adapter `parseRequest` | bet = c × bl sai parse |
| Reels length | `decodeReels` | s.length ≠ sw × sh (schema change) |
| Payout (ways) | `calculateWaysWin` | server win ≠ paytable math |
| Payout (paylines) | `paylines.ts` | sai logic 25-line games |
| Payout (cluster) | `cluster.ts` | sai cascade tumble logic |
| Balance reconciliation | `balance-reconciler.ts` | free-spin trừ bet, server jump |
| JSON shape | `json-snapshot.ts` | response field thêm/bớt |
| Region pixel | `region-snapshot.ts` | UI vỡ layout, black screen |
| UI ↔ API | `ui-verifier.ts` | balance display ≠ response (OCR) |

### Long-run statistical
| Metric | Catch |
|---|---|
| RTP (+ 95% CI) | Game weighted sai, paytable error |
| Hit frequency | Reel strip distribution off |
| Volatility (σ of win/bet) | Mismatch advertised band |
| Average winning | Skew shape |
| Feature frequency | Free spin trigger rate ngoài spec |
| Symbol distribution | Reel strip symbol mix wrong |
| Win distribution buckets | Shape phân bố |

### AI-assisted
- Bug summarizer — group validation errors → markdown report
- Game analyzer — sinh canonical schema cho game mới
- Vision OCR — UI balance/win cross-check
- Pre-game vision — dismiss popup khi replay miss

---

## 8. CLI cheatsheet

```bash
# === Server / Dashboard ===
npm run serve                                    # Start dashboard @ port 3200

# === Database (1 lần setup) ===
npm run db:up                                    # docker compose up postgres + redis
npm run db:migrate                               # Prisma migrate dev
npm run db:studio                                # Prisma Studio UI

# === Workers ===
npm run worker:stats                             # BullMQ stats worker

# === Discovery / data capture ===
npm run record                                   # Manual record (2 phút auto-stop)
npm run auto                                     # AI auto-play + capture
npm run record-pregame                           # = auto with QA_CAPTURE_PREGAME=1

# === Extract / generate ===
npm run extract-scenarios -- <slug>              # Recording → scenarios
npm run qa                                       # Full pipeline (collect+gen+run)

# === Run tests ===
npm run test                                     # All Playwright tests
npm run test:integration                         # Synthetic deterministic (no game)
npm run test:hybrid                              # Hand-written hybrid spec
npm run test:deterministic                       # Pure deterministic (limited use)

# === Statistical ===
npm run stats -- <slug> --spins 10000            # Inline
npm run stats -- <slug> --spins 100000 --queue   # Via BullMQ worker

# === AI utilities ===
npm run analyze:game -- <slug>                   # Sinh fixtures/analyzers/{slug}.json
npm run bug-summary -- <test-run-id>             # Markdown bug report từ DB
npm run pregame-stats [-- <slug>]                # Aggregate replay/vision rate
```

---

## 9. Smart routing — Run Tests

[src/generate-and-run.ts](../src/generate-and-run.ts) trong phase=run:

```
listScenarios(slug)  →  [] hoặc [scenarios]
                              │
                              ▼
       ┌──────────────────────────────────────────┐
       │ Có scenarios AND không force vision?     │
       └──────────┬───────────────────────────────┘
                  │ yes                  │ no
                  ▼                      ▼
       ┌────────────────────────┐  Vision flow (legacy):
       │ Có tests/generated/    │  tests/generated/{slug}.spec.ts
       │ {slug}.hybrid.spec.ts? │  → vision per spin
       └────┬─────────────┬─────┘  → $1-10 / run, 30-60 phút
            │ yes         │ no
            ▼             ▼
  Catalog-driven   Hand-written hybrid:
  hybrid spec:     tests/deterministic-hybrid.spec.ts
  27-33 cases      → 13 cases hardcode
  $0-0.60          → fallback safety net
  5-15 phút
```

Override: `QA_FORCE_VISION=1` để bypass smart routing.

---

## 10. Pre-game replay & auto-heal

`preGameWithReplayOrVision()` ([src/runner/pre-game-replay.ts](../src/runner/pre-game-replay.ts)):

```
1. Load fixtures/pre-game/{slug}.json (nếu có)
2. Wait initial_wait_ms
3. For each click: wait delay_ms → mouse.click(x, y) → wait post_click_wait_ms
4. Screenshot vùng ready_signal.region
5. pixelmatch(actual, baseline) ≤ max_diff_ratio (default 5%)
   ├ Pass → ready (source=replay, $0, ~3s)
   └ Fail → fallback waitForGamePlayScreen (vision, $0.05-0.20)
         └ Nếu vision OK AND replay failure was "region_mismatch":
              auto-heal: re-capture baseline (default ON, off via PRE_GAME_AUTO_HEAL=0)
6. Log attempt → fixtures/pre-game/_stats.jsonl
```

Stats CLI cho tỷ lệ fallback:
```bash
npm run pregame-stats -- fiesta-magenta
# Vision rate %  : 12.1%  ← % cần AI confirm
# Replay success : 87.9%
# Avg duration   : replay 1.2s, vision 42s
```

---

## 11. API endpoints

### Read-only
| Endpoint | Mô tả |
|---|---|
| `GET /api/tasks` | List LLM tasks |
| `GET /api/tasks/:id` | Task detail |
| `GET /api/tasks/:id/log` | Full log entries |
| `GET /api/tasks/:id/events` | Spin events |
| `GET /api/tasks/:id/scenarios` | Available scenarios |
| `GET /api/tasks/:id/case-report.{json,md}` | Per-case report |
| `GET /api/tasks/:id/pregame-stats` | Replay/vision stats for slug |
| `GET /api/test-runs` | DB run history |
| `GET /api/test-runs/:id` | Test run detail + statReport |
| `GET /api/test-runs/:id/spins` | Spin results paginated |
| `GET /api/test-runs/:id/errors` | Validation errors grouped |
| `GET /api/analyzer/:slug` | Canonical analyzer JSON |
| `GET /api/stream` | Global SSE stream |

### Actions
| Endpoint | Mô tả |
|---|---|
| `POST /api/tasks` | Create task |
| `POST /api/tasks/:id/collect` | Trigger phase=collect |
| `POST /api/tasks/:id/generate` | Trigger phase=generate |
| `POST /api/tasks/:id/run` | Trigger phase=run (smart routing) |
| `POST /api/tasks/:id/run-stats` | Statistical sim (body: `{spins, concurrency}`) |
| `POST /api/tasks/:id/record-pregame` | Re-record pre-game clicks |
| `POST /api/tasks/:id/cancel` | Cancel running phase |
| `POST /api/tasks/:id/retry` | Reset + re-run |
| `DELETE /api/tasks/:id` | Delete + cleanup |
| `POST /api/test-runs/:id/summary` | Generate bug summary (AI) |
| `POST /api/tasks/:id/cases/:caseId/run` | Re-run 1 test case |
| `POST /api/tasks/:id/update-baselines` | Update region/JSON snapshots |
| `POST /api/tasks/:id/gen-hybrid` | Re-emit hybrid spec |

---

## 12. Configuration

### `.env` (file permissions restricted — edit manually)
```env
GAME_URL=https://...                          # Default game URL cho CLI
DATABASE_URL=postgresql://postgres@localhost:5432/crawler_qa
REDIS_URL=redis://localhost:6379
CLAUDE_CODE_OAUTH_TOKEN=...                   # Hoặc ANTHROPIC_API_KEY
```

### Runtime flags
| Env var | Default | Mô tả |
|---|---|---|
| `QA_PHASE` | `all` | `collect` / `generate` / `run` / `all` |
| `QA_SLUG` | `fiesta-magenta` | Slug cho `test:hybrid` |
| `QA_SPINS_PER_TEST` | 3 | Spins/test trong vision flow |
| `QA_FORCE_VISION` | unset | Force vision flow, bypass smart routing |
| `QA_CAPTURE_PREGAME` | unset | Auto-set khi phase=collect → capture replay |
| `QA_NO_CAPTURE_PREGAME` | unset | Disable auto-capture |
| `PRE_GAME_AUTO_HEAL` | `1` | Auto refresh baseline khi vision recovers |
| `PRE_GAME_MAX_ITERATIONS` | 20 | Max vision iterations |
| `REGION_SNAPSHOT_UPDATE` | unset | Update region baselines instead of assert |
| `JSON_SNAPSHOT_UPDATE` | unset | Update JSON baselines |
| `WORKER_CONCURRENCY` | 1 | BullMQ stats worker concurrency |
| `PORT` | 3200 | Dashboard port |
| `QA_CLAUDE_DEBUG` | unset | Stream Claude SDK stderr |

---

## 13. Cost / time matrix

| Workflow | Time | LLM cost |
|---|---|---|
| Collect (1 lần per game) | 1-3 phút | $0.10-0.30 |
| Generate Tests | 30s-2 phút | $0.05-0.15 |
| Run Tests (hybrid + replay) | ~5 phút (33 cases) | $0-0.20 |
| Run Tests (hybrid + vision fallback) | ~10-15 phút | $1-3 |
| Run Tests (vision flow legacy) | 30-60 phút | $5-15 |
| Stats sim 1k spins | 10-30s | $0 |
| Stats sim 100k spins | 5-10 phút | $0 |
| Bug summary | ~5s | $0.05 |
| Analyzer report | <1s | $0 (no LLM — pure mapping) |

---

## 14. Gap so với §6 spec

| Phần spec | Trạng thái |
|---|---|
| §2 Architecture (Playwright + capture + parser + adapter + rule engine + UI) | ✅ Đầy đủ |
| §3 Flow (spin → capture → parse → validate → RTP → report) | ✅ |
| §4.1 Deterministic core | ✅ Vượt spec (mock + freeze + region snapshot) |
| §4.2 AI hỗ trợ schema/draft/testcase/bug | ✅ |
| §5 Detect rule (paytable + paylines + multiplier) | ⚠️ Ways + paylines + cluster có; multi-mechanic per-game chưa |
| §6 AI Game Analyzer JSON schema | ✅ Canonical output |
| §7.1 Spin-by-spin validation | ✅ |
| §7.2 Long-run statistical (RTP, hit rate, volatility, etc.) | ✅ |
| §8 UI testing (state, visual, API↔UI) | ✅ region snapshot + OCR cross-check |
| §9 GameAdapter interface | ✅ Provider × Mechanic composition |
| §10 Database (test_runs, spin_results, validation_errors, stat_reports) | ✅ PostgreSQL + Prisma, env-gated |
| §11 Dashboard | ✅ HTTP thuần thay vì Next.js — đủ dùng |
| §12 Stack (NestJS/BullMQ/Prisma/Next.js/S3) | ⚠️ BullMQ + Prisma có; NestJS/Next.js/S3 không (intentional simplification) |
| §13 Roadmap Phase 1-6 | ✅ All phases shipped |

---

## 15. Known limitations

1. **Pre-game replay fragile với non-deterministic popups** — game có promo/A-B test thay đổi giữa sessions → replay verification fail thường xuyên → fallback vision. Tỷ lệ ~10-20% tuỳ game.
2. **Catalog regen mỗi Generate** — AI sinh catalog mới mỗi lần click "2. Generate Tests" → diff khó review qua git.
3. **9/33 cases skip** trong codegen — autoplay/options/history/turbo_spin/max_win/history/buy-feature/special-bet không deterministic-mockable (cần UI interaction phức tạp).
4. **Cascade decoder per-game** — PP cascade `sa`/`sb` chỉ surface initial drop. Multi-frame cascade verification chưa hoàn chỉnh.
5. **Token expiry** — Recording-based statistical sim cần token còn hạn (24-7d). Hết hạn → 401, phải re-record.
6. **`workers: 1`** trong playwright.config.ts — không parallel test execution. Headed browser × multi-worker chưa wire.
7. **DB không lưu Task LLM-flow trừ phi phase=run/all** — Generate/Collect không tạo TestRun row (intentional — chỉ runs có spin data đáng persist).

---

## 16. Lịch sử thay đổi gần đây

1. **GameAdapter abstraction** (§9) — provider × mechanic composition layer
2. **Statistical metrics expansion** — volatility, average win, feature frequency, symbol distribution, RTP CI
3. **Paylines + Cluster mechanics** — beyond ways-only
4. **Balance reconciler** — free-spin aware
5. **PostgreSQL + Prisma** — 4 tables, env-gated
6. **Redis + BullMQ** — stats queue + worker
7. **Game Analyzer canonical JSON** (§6)
8. **AI Bug summarizer** — skeleton fallback khi không có LLM creds
9. **Pre-game click replay** — fixtures/pre-game + region snapshot verify
10. **Stats logger** — fixtures/pre-game/_stats.jsonl + CLI aggregator
11. **Auto-heal baseline** — default ON
12. **DB write-through** trong server runner — 4 lifecycle hooks
13. **Test Runs (DB) section** trên dashboard
14. **Smart Run Tests routing** — prefer generated hybrid spec
15. **Run Stats + Re-record Pre-game buttons** trên dashboard

Test coverage: 32/32 pass (typecheck clean).
