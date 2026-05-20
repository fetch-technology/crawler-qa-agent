# Dashboard Guide — Hướng dẫn sử dụng UI chi tiết

> Hướng dẫn toàn diện cho web dashboard của crawler-qa-agent. Mọi component, button, tab, behavior — giải thích cụ thể tại sao có và dùng ra sao.

URL: `http://localhost:3200/dashboard` (sau khi chạy `npm run serve`)

---

## Mục lục

1. [Quick start — 5 phút first test](#1-quick-start)
2. [Cấu trúc dashboard](#2-cấu-trúc-dashboard)
3. [Top bar](#3-top-bar)
4. [New Task form](#4-new-task-form)
5. [Tasks table](#5-tasks-table)
6. [Task Detail panel](#6-task-detail-panel)
7. [Test Cases tab — chi tiết action buttons](#7-test-cases-tab--chi-tiết-action-buttons)
8. [Các tab khác](#8-các-tab-khác)
9. [Real-time events (SSE)](#9-real-time-events-sse)
10. [Common workflows](#10-common-workflows)
11. [Tips & shortcuts](#11-tips--shortcuts)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Quick start

5 bước để test 1 game lần đầu qua dashboard:

```
1. Khởi động:        npm run serve
2. Mở browser:       http://localhost:3200/dashboard
3. Paste GAME_URL → Create Task
4. Click row task → "1. Collect Context" → đợi ~3 phút
5. Tab Test Cases → 🎯 gen hybrid → ▶ run hybrid → xem kết quả
```

Sau bước 5, có 1 game pass deterministic regression test.

---

## 2. Cấu trúc dashboard

```
┌──────────────────────────────────────────────────────────┐
│  Crawler QA Agent                          Queue: idle   │  ← Top bar
├──────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐ │
│  │  New Task                                            │ │
│  │  [Game URL_______] [Spins:3] [☐ Auto-run]  [Create]│ │  ← New Task form
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Tasks                                  3 total      │ │
│  │  Game           Provider  URL    Status   Duration   │ │  ← Tasks table
│  │  fiesta-magenta RG        ...    completed  2.3m    │ │
│  │  ...                                                  │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Task detail: fiesta-magenta                  [×]   │ │
│  │  [Test Cases] [QA View] [Context] [JSON] [Errors]   │ │  ← Detail panel
│  │  [Spin Events] [Screenshots] [Full Log]              │ │     (tabs)
│  │  ┌────────────────────────────────────────────────┐ │ │
│  │  │ ... tab content ...                             │ │ │
│  │  └────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### URL aliases
- `/` → redirect `/dashboard`
- `/dashboard` → main UI
- `/playwright-report/` → Playwright HTML report (chỉ có sau khi chạy ít nhất 1 test)

---

## 3. Top bar

```
Crawler QA Agent                    Queue: 1 running, 2 queued
```

- **Title** (left): tên app
- **Queue status** (right): tổng quan worker state
  - `idle` — không có task chạy
  - `N running, M queued` — N đang chạy + M đang đợi
  - Auto-update qua SSE, không cần refresh

Update event: bất kỳ task nào thay đổi status → tự refresh số liệu.

---

## 4. New Task form

```
Game URL: [https://rc.dev.revenge-games.com/...]
Spins / test: [3]      ☐ Auto-run all phases     [Create Task]
```

### Fields

| Field | Mục đích | Default |
|---|---|---|
| **Game URL** | URL game đầy đủ với token. Tool tự parse slug từ host + path. | (required) |
| **Spins / test** | Số spin mỗi test case khi chạy LLM-driven test (Phase 3 Run Tests). Không ảnh hưởng hybrid/stats. | 3 |
| **Auto-run all phases** | Tick → tạo task xong tự chạy Collect → Generate → Run liên tục (legacy 1-click pipeline). | unchecked |

### Behavior

- **Validation**: Server check URL hợp lệ (parseable URL) trước khi tạo task. Lỗi hiển thị banner đỏ phía trên form.
- **Slug auto-detect**: tool tự lấy slug từ URL (vd `/fiesta-magenta/` → slug=`fiesta-magenta`). Xem [src/utils/url.ts](../src/utils/url.ts) cho rules.
- **Provider auto-detect**: tool detect provider từ host (`revenge-games.com` → RG, `pragmaticplay.com` → PP, etc.)
- **Token redaction**: URL hiển thị trong table được redact `?t=***REDACTED***` để tránh leak token.

### Khi nào tick "Auto-run all phases"?

- ✅ Game đơn giản, đã test trước, biết flow OK
- ✅ Smoke test trong CI
- ❌ Game mới (nên control từng phase để debug)
- ❌ Muốn dùng hybrid (auto chỉ chạy LLM flow cũ)

---

## 5. Tasks table

```
| | Game            | Provider | URL              | Status      | Spins | RTP    | Duration | Updated | |
| | fiesta-magenta  | RG       | rc.dev...        | completed   | 9     | 96.5%  | 2.3m     | 2m ago  | |
| | sweet-bonanza   | PP       | demogamesfree... | running     | 3/10  | -      | 1.1m     | now     | |
| | book-of-dead    | PNG      | demo.playngo...  | failed      | 0     | -      | 0.5m     | 5m ago  | |
```

### Columns

| Column | Mô tả |
|---|---|
| **Game** | Slug (vd `fiesta-magenta`) |
| **Provider** | Code (RG, PP, PG, EVO, NE, PNG, SPR) |
| **URL** | Redacted URL, hover để xem đầy đủ |
| **Status** | `queued` / `running` / `completed` / `failed` / `cancelled` |
| **Spins** | Số spin đã record / target (vd `9/9` = xong, `3/10` = đang chạy) |
| **RTP** | Observed RTP nếu có data (chỉ show sau khi statistical sim hoặc nhiều spin) |
| **Duration** | Tổng thời gian từ start tới giờ |
| **Updated** | Last activity timestamp |
| **Actions** | Cancel/Retry/Delete buttons (visible theo status) |

### Row interactions

- **Click row** → mở Task Detail panel (cuộn xuống dưới)
- **Click row đang active** → close detail
- Hover row → highlight + cursor pointer

### Status colors

| Status | Color | Meaning |
|---|---|---|
| `queued` | gray | Đợi worker rảnh |
| `running` | blue (animated) | Đang chạy |
| `completed` | green | Tất cả phase done OK |
| `failed` | red | 1 phase fail |
| `cancelled` | gray | User cancel |

### Sort + filter

Hiện tại không có sort/filter UI. Task ngầm sort theo `updated` desc (mới nhất trên top).

---

## 6. Task Detail panel

Panel mở khi click vào row task. Có 3 phần:

### 6.1. Header

```
Task detail: fiesta-magenta                                       [Close]
─────────────────────────────────────────────────────────────────────────
Meta: provider=RG | gameUrl=... | status=completed | duration=2.3m
      [1. Collect Context]  [2. Generate Tests]  [3. Run Tests]
      [Cancel]  [Retry]  [Delete]
```

- **Title**: slug + provider name
- **Close** button: đóng panel (giữ task trong table)
- **Meta**: status, duration, current stage
- **Phase buttons**: 3 phase chính của LLM flow cũ
- **Action buttons**: thay đổi theo status

### 6.2. Phase action buttons

Đây là điều khiển **legacy LLM pipeline**. Mỗi button tương ứng 1 phase:

| Button | Khi nào enabled | Effect |
|---|---|---|
| **1. Collect Context** | Always (stage `pending`) | LLM auto-play → record traffic → auto-extract scenarios. ~2-5 phút. |
| **2. Generate Tests** | Sau khi Collect xong (stage `context_ready`) | LLM sinh test catalog + Playwright code. ~1-3 phút. |
| **3. Run Tests** | Sau khi Generate xong (stage `catalog_ready`) | Chạy LLM-driven tests. ~5-30 phút. |

Buttons disable nếu pre-condition chưa met (vd Generate disable khi chưa Collect).

### 6.3. Tabs

8 tabs ở dưới meta:

```
[Test Cases] [QA View] [Context (AI inputs)] [JSON] [Errors X] [Spin Events] [Screenshots] [Full Log]
```

- **Test Cases** (default active) — hiển thị test catalog + status per case + ACTION BUTTONS (xem section 7)
- **QA View** — formatted markdown của test catalog
- **Context (AI inputs)** — show data AI đã thấy khi gen catalog (rules, options, samples)
- **JSON** — raw JSON snapshots (play screen, api samples, paytable, game spec)
- **Errors** (có badge số lỗi) — failed tests với INLINE DIFF VISUALIZATION
- **Spin Events** — real-time stream of spin events
- **Screenshots** — per-test + global screenshots
- **Full Log** — stdout/stderr stream của tất cả phase

Click tab → switch pane. Active tab có border bottom highlighted.

---

## 7. Test Cases tab — chi tiết action buttons

Đây là tab chính, có 2 row action buttons với 8 buttons tổng.

### Row 1: Reports + Deterministic flow

```
[📄 report.md] [⬇ report.json] [📊 playwright report] 
[🎯 gen hybrid] [▶ run hybrid] [📋 scenarios] · N scenarios available
```

#### 📄 report.md
- **Endpoint**: `GET /api/tasks/:id/case-report.md`
- **Action**: Mở markdown report của LLM-driven test run trong tab mới
- **Khi dùng**: Sau khi click "3. Run Tests" xong, đọc kết quả từng test case với invariants
- **Format**: QA-readable markdown với pass/fail per case + error details
- **Yêu cầu**: Đã chạy `3. Run Tests` ít nhất 1 lần

#### ⬇ report.json
- **Endpoint**: `GET /api/tasks/:id/case-report.json` (với download header)
- **Action**: Download full report JSON
- **Khi dùng**: Khi cần data programmatic (Python script analyze, dashboards bên ngoài)

#### 📊 playwright report
- **URL**: `/playwright-report/` (full HTML report)
- **Action**: Mở Playwright HTML report viewer trong tab mới
- **Features**: Visual diff viewer (cho toHaveScreenshot), trace viewer, console log, video playback per test, attachment browser
- **Yêu cầu**: Đã chạy bất kỳ Playwright test nào (LLM hoặc hybrid)

#### 🎯 gen hybrid
- **Endpoint**: `POST /api/tasks/:id/gen-hybrid`
- **Action**: Sinh `tests/generated/{slug}.hybrid.spec.ts` từ scenarios có sẵn
- **Output**: Status text update `gen ✓ tests/generated/...` với path file
- **Behavior**: Template-based (không gọi LLM), instant (< 1 giây)
- **Yêu cầu**: Phải có scenarios (status text show "N scenarios available")
- **Error**: Nếu chưa có scenarios → status "no scenarios (run Collect first)"

#### ▶ run hybrid
- **Endpoint**: `POST /api/tasks/:id/run-hybrid`
- **Action**: Spawn Playwright chạy hybrid spec → stream output qua tab "Full Log"
- **Behavior**: Fire-and-forget — response trả ngay, kết quả qua SSE
- **Duration**: ~2-3 phút (LLM pre-game + spin loop)
- **Yêu cầu**: Phải gen hybrid trước (file `.hybrid.spec.ts` exists)
- **Error**: 409 nếu chưa gen hoặc worker đang bận

#### 📋 scenarios (toggle)
- **Endpoint**: `GET /api/tasks/:id/scenarios`
- **Action**: Click → toggle panel hiển thị danh sách scenarios với expected values
- **Output panel**:
  ```
  ┌────────────────────────────────────────────┐
  │ small_win [small_win]                       │
  │ bet=1 win=0.5 ending_balance=981174.55 ... │
  │                                             │
  │ no_win [no_win]                             │
  │ bet=1 win=0 ending_balance=981200.65 ...   │
  └────────────────────────────────────────────┘
  ```
- **Khi dùng**: Verify scenario data trước khi gen hybrid, hoặc debug khi assertion fail

### Row 2: Stats + Baseline updates

```
[📊 run stats] [____1000____] spins (token preflight ngầm)
[🔄 update region] [🔄 update json] · status
```

#### 📊 run stats + input
- **Input field**: số spin (10 - 100000, default 1000)
- **Endpoint**: `POST /api/tasks/:id/run-stats` body `{ spins: N, concurrency: 4, throttleMs: 10 }`
- **Action**: Bắn N spin trực tiếp tới game's spin endpoint (bypass UI)
- **Flow**:
  1. Preflight 1 request thử → check token valid
     - HTTP 401/403 → fail ngay với hướng dẫn re-record
     - HTTP 200/201 → continue
  2. Mass-spin với concurrency 4 (4 worker parallel)
  3. Stream progress qua tab "Full Log": `[simulate] 500/1000 RTP=98.2% hits=180`
  4. Khi xong: formatted report (RTP, HF, distribution, max win) trong log
  5. Save vào `fixtures/statistical/{slug}-{ISO}.json`
- **Duration**: ~16s (100 spin) → ~15 phút (10k spin)
- **Cost**: $0 LLM, nhưng tốn balance demo account (mỗi spin = 1 round thật)

#### 🔄 update region
- **Endpoint**: `POST /api/tasks/:id/update-baselines` body `{ type: "region" }`
- **Action**: Spawn Playwright với `REGION_SNAPSHOT_UPDATE=1` → re-capture region snapshot baselines
- **Yêu cầu**: Phải có hybrid spec đã gen
- **Khi dùng**: Sau khi UI thay đổi có chủ đích, accept new state làm baseline
- **Output**: Baseline mới ghi vào `fixtures/templates/{slug}/*.png`
- **Workflow đúng**:
  1. Run hybrid → fail vì region mismatch
  2. Tab "Errors" → xem diff inline → verify visual change OK
  3. Click button này → spawn re-capture
  4. Run hybrid lại → pass
  5. `git add fixtures/templates/ && git commit`

#### 🔄 update json
- **Endpoint**: `POST /api/tasks/:id/update-baselines` body `{ type: "json" }`
- **Action**: Tương tự update region nhưng với `JSON_SNAPSHOT_UPDATE=1`
- **Output**: Baseline mới ghi vào `fixtures/snapshots/{slug}/*.json`
- **Khi dùng**: Sau khi server đổi schema API có chủ đích

---

## 8. Các tab khác

### 8.1. QA View
Render markdown formatted version của test catalog. Dễ đọc hơn raw JSON. Có button download .csv (Excel/Sheets-ready).

### 8.2. Context (AI inputs)
Show toàn bộ input AI đã thấy khi sinh catalog:
- **Rules summary** — paytable extracted
- **Game spec** — bet sizes, symbols, features
- **Config response** — structured config từ server
- **Sample spin responses** — vài spin mẫu để AI suy ra invariants

Dùng để **debug khi LLM sinh catalog sai** — kiểm tra AI đã thấy data nào.

### 8.3. JSON
Show raw JSON snapshots — 5 cards:
- `play_screen` — game state lúc ready
- `api_snapshot` — bundle authorize + config + balance
- `paytable` — paytable extracted
- `options` — bet options + autoplay options
- `game_spec` — full GameSpec

Click expand từng card → view JSON tree.

### 8.4. Errors (có badge số lỗi)

Tab quan trọng khi test fail. Cấu trúc:

```
┌─────────────────────────────────────────────────────┐
│  3 errors  1 warning  across 2 phases               │
│  ☑ Errors  ☑ Warnings    [Copy all]                 │
├─────────────────────────────────────────────────────┤
│  ▼ run-tests (2 errors)                              │
│  ├─ 10:32:15 ERROR  Region snapshot mismatch: ...   │
│  │    ┌──────────┬──────────┬──────────┐            │
│  │    │ baseline │ actual   │ diff     │            │  ← INLINE DIFF VIZ
│  │    │ [image]  │ [image]  │ [image]  │            │
│  │    └──────────┴──────────┴──────────┘            │
│  └─ 10:33:01 ERROR  JSON snapshot mismatch: ...     │
│       [changed] winAmount: number→string             │  ← COLORIZED DIFF
│       [added] bonusMultiplier: 2                     │
│       [removed] status: "RESOLVED"                   │
└─────────────────────────────────────────────────────┘
```

**Features mới**:
- **Region diff viz**: 3 ảnh side-by-side với border màu (gray=baseline, amber=actual, red=diff)
- **JSON diff colorize**: added=green, removed=red, changed=amber, type_changed=purple
- Click ảnh → mở fullsize tab mới
- Filter checkbox: hide warnings để focus errors
- Copy all → copy text errors vào clipboard

Diff fetch qua `/api/tasks/:id/attachment?path=...` (test-results/, reports/, etc.).

### 8.5. Spin Events
Real-time stream từng spin event với fields:
- `spinNumber` — index trong test
- `betAmount` / `winAmount` / `balanceBefore` / `balanceAfter` / `netChange`
- `status` (RESOLVED, PENDING, ...)
- `spinId` / `currency`

Useful khi:
- Verify LLM flow đang spin đúng
- Debug balance chain issues
- Live monitor trong khi test chạy

### 8.6. Screenshots
2 phần:
- **Root screenshots** (flat) — pre-game iterations, ready state
- **Per-case folders** — screenshots theo `caseId` (chỉ có khi LLM test)

Click ảnh → mở fullsize modal. Modal có nút Close + label hiển thị tên file.

### 8.7. Full Log
Pure text dump của stdout + stderr từ tất cả phase. Useful khi:
- Debug deep — xem console.log của test code
- Verify LLM iteration sequence
- Track timing

Auto-scroll khi có dòng mới (nếu đang ở cuối).

---

## 9. Real-time events (SSE)

Dashboard nhận events qua Server-Sent Events từ 2 endpoints:

- `/api/stream` — global events cho tất cả tasks (queue status, task creation)
- `/api/tasks/:id/stream` — per-task events khi xem detail panel

### Event types

| Event | Emit khi | Update |
|---|---|---|
| `pre_game_start` | Pre-game LLM loop bắt đầu | Log |
| `pre_game_iter` | Mỗi LLM iteration | Log |
| `pre_game_ready` | AI confirm play screen ready | Status |
| `open_game` | openGame() bắt đầu | Log |
| `game_ready` | Game canvas ready | Status |
| `spin` | Mỗi spin response captured | Spin Events tab |
| `authorize` | Authorize-game response | Spin Events tab |
| `case_start` | Test case bắt đầu | Test Cases tab (status running) |
| `case_end` | Test case kết thúc | Test Cases tab (status pass/fail) |
| `catalog_ready` | LLM xong catalog | Test Cases tab populate |
| `phase_done` | Phase 1/2/3 xong | Status badge advance |

UI tự auto-update qua các events này — không cần F5.

### Heartbeat
SSE connection có ping mỗi 20s để giữ alive qua proxy.

---

## 10. Common workflows

### Workflow A: Test 1 game từ zero qua dashboard

```
1. npm run serve → mở http://localhost:3200/dashboard
2. Paste GAME_URL → Create Task
3. Click row → detail panel mở
4. [1. Collect Context] → đợi ~3 phút
   → Tab "Full Log" xem stream
   → Khi xong: status "context_ready", scenarios auto-extract
5. Tab Test Cases → [📋 scenarios] verify có scenarios
6. [🎯 gen hybrid] → status "gen ✓ ..."
7. [▶ run hybrid] → xem Full Log
8. Khi xong → status pass/fail per test
9. Nếu fail → tab "Errors" xem inline diff
```

### Workflow B: Statistical RTP check

```
1. Mở detail panel của task có recording fresh
2. Tab Test Cases → input số spin = 10000 → [📊 run stats]
3. Preflight ~1 giây
4. Tab "Full Log" stream progress
5. Khi xong → formatted report trong log
6. Verify: RTP gần spec, hit freq hợp lý, max win cap đúng
```

### Workflow C: Update baseline sau UI change

```
1. Designer push UI update
2. Run hybrid → fail
3. Tab "Errors" → xem region diff inline
4. Verify visually OK
5. Click [🔄 update region]
6. Run hybrid lại → pass
7. git add fixtures/templates/ && commit
```

### Workflow D: Debug deep với Playwright report

```
1. Run hybrid → fail
2. Tab Test Cases → [📊 playwright report] (mở tab mới)
3. Click failed test trong tree
4. Xem trace viewer (timeline + DOM snapshot + network)
5. Verify đúng lúc nào fail, request gì, DOM state ra sao
```

### Workflow E: Multi-task parallel monitoring

```
1. Tạo 3 task cho 3 game khác nhau
2. Tick "Auto-run all phases" cho mỗi task → queue
3. Worker chạy tuần tự (workers=1 by default)
4. Mở Task A detail → switch Task B detail → switch Task C detail
5. Top bar show "1 running, 2 queued"
6. Khi 1 task xong → auto next
```

---

## 11. Tips & shortcuts

### Browser DevTools
- **F12** → Network tab → filter `eventsource` để xem SSE events raw
- Console tab → see `[browser] ...` log từ test code

### Hard reload
Sau khi tôi (hoặc git pull) update `public/app.js`, browser cache HTML/JS cũ. Hard reload:
- **Mac**: Cmd+Shift+R
- **Windows/Linux**: Ctrl+Shift+R

### Multiple tabs
Mở dashboard ở nhiều tab cùng lúc — mỗi tab nhận SSE riêng. Không có race condition vì state ở server.

### Direct API access
Mọi action UI = REST call. Có thể automate qua curl/script:
```bash
# Create task
curl -X POST http://localhost:3200/api/tasks \
  -H 'content-type: application/json' \
  -d '{"gameUrl":"https://..."}'

# Trigger phase
curl -X POST http://localhost:3200/api/tasks/<id>/collect

# Run stats
curl -X POST http://localhost:3200/api/tasks/<id>/run-stats \
  -H 'content-type: application/json' \
  -d '{"spins":1000}'

# List scenarios
curl http://localhost:3200/api/tasks/<id>/scenarios
```

### Static assets caching
Dashboard set `cache-control: no-store` → mọi GET không cache. Update CSS/JS thấy ngay sau reload.

---

## 12. Troubleshooting

### Dashboard không load
- Verify `npm run serve` đang chạy (xem terminal output: `http://localhost:3200/dashboard`)
- Verify port 3200 không bị process khác chiếm: `lsof -i :3200`
- Try port khác: `PORT=3299 npm run serve`

### Buttons không response (click no effect)
- Mở F12 → Console — check JS error
- Hard reload (Cmd+Shift+R) — cache cũ
- Verify backend đã restart sau code update

### "0 scenarios available" sau Collect xong
- Collect chạy thành công nhưng không có spin response trong recording
- Verify trong Full Log: dòng `Auto-extracted N scenario(s)` — nếu N=0 hoặc dòng "No scenarios extracted"
- Fix: chạy lại Collect (đôi khi AI không click được spin), hoặc dùng CLI `npm run auto` rồi `npm run extract-scenarios -- {slug}`

### Hybrid run fail "no spin request fired after 4 clicks"
- Game's spin button không ở coord (720, 810) — verify trong tab Screenshots
- Hoặc game loading vẫn chưa xong → tăng `maxIterations` trong pre-game
- Hoặc token expired → re-collect

### Stats fail với 401/403
- Token expired (recording > 24-48h cũ)
- Solution: re-collect (Phase 1) với URL token fresh

### Errors tab không show inline diff
- Diff PNG path không match `test-results/` allowed prefix → check region-snapshot.ts ghi đúng dir
- JSON error format không match pattern `[changed]/[added]/[removed]` → check json-snapshot.ts:formatDiff()
- File diff bị clean → tránh `npm run clean` giữa test fail và view error

### Playwright report 404
- Chưa chạy test nào → reports/html/ chưa generate
- Fix: chạy bất kỳ test (Run Tests hoặc run hybrid) ít nhất 1 lần

### SSE disconnect
- Browser timeout connection sau idle lâu
- Dashboard tự re-connect khi detect close
- Hoặc reload page

### Multiple tasks queue nhưng chỉ 1 chạy
- Worker count default = 1 (sequential)
- Đây là intentional vì Playwright headed mode mặc định không parallel safe
- Để chạy parallel: cần custom config (chưa expose qua dashboard)

---

## Phụ lục: Endpoint reference đầy đủ

```
GET    /api/tasks                              # List tất cả tasks
POST   /api/tasks                              # Create task
GET    /api/tasks/:id                          # Get task detail
DELETE /api/tasks/:id                          # Delete task
GET    /api/tasks/:id/log                      # Full log
GET    /api/tasks/:id/events                   # Spin events
GET    /api/tasks/:id/stream                   # SSE stream
GET    /api/stream                             # Global SSE
GET    /api/tasks/:id/test-cases               # Test catalog JSON
GET    /api/tasks/:id/test-cases.md            # Markdown
GET    /api/tasks/:id/test-cases.csv           # CSV
GET    /api/tasks/:id/case-report.md           # Run report markdown
GET    /api/tasks/:id/case-report.json         # Run report JSON
GET    /api/tasks/:id/catalog-context          # AI inputs
GET    /api/tasks/:id/json-snapshots           # Structured JSON snapshots
GET    /api/tasks/:id/screenshots              # Screenshot list
GET    /api/tasks/:id/screenshots/:filename    # Serve screenshot
GET    /api/tasks/:id/attachment?path=...      # Serve attachment (test-results/, reports/, fixtures/tasks/)

POST   /api/tasks/:id/collect                  # Phase 1
POST   /api/tasks/:id/generate                 # Phase 2
POST   /api/tasks/:id/run                      # Phase 3
POST   /api/tasks/:id/retry                    # Retry failed task
POST   /api/tasks/:id/cancel                   # Cancel running
POST   /api/tasks/:id/cases/:caseId/run        # Re-run single case (LLM)

# Deterministic / Hybrid (mới)
GET    /api/tasks/:id/scenarios                # List scenarios + expected
POST   /api/tasks/:id/gen-hybrid               # Gen hybrid spec
POST   /api/tasks/:id/run-hybrid               # Run hybrid spec

# Statistical (mới)
POST   /api/tasks/:id/run-stats                # Mass-spin sim
GET    /api/tasks/:id/stats-report             # Latest stats report

# Baseline updates (mới)
POST   /api/tasks/:id/update-baselines         # body: { type: "region"|"json"|"both" }

# Static
GET    /                                       # → redirect /dashboard
GET    /dashboard                              # Main UI (alias /index.html)
GET    /style.css, /app.js                     # Static assets
GET    /playwright-report/                     # Playwright HTML report
GET    /playwright-report/*                    # Report sub-resources
```

---

## TLDR — 30 giây skim

- Dashboard ở `http://localhost:3200/dashboard`
- Tạo task → click row → detail panel
- 3 button phase: Collect / Generate / Run (LLM flow)
- Tab Test Cases có 2 row action: deterministic flow + math/baseline
- Tab Errors có inline diff visualization khi snapshot fail
- 📊 playwright report → full UI cho deep debug
- Mọi thứ real-time qua SSE — không cần F5

Đó là toàn bộ dashboard.
