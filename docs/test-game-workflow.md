# Quy trình test 1 game — chi tiết end-to-end

> Workflow thực tế để test 1 game canvas slot từ zero, dùng cả 3 flow (LLM discovery + Hybrid regression + Statistical math). Mỗi step có command cụ thể, expected output, và decision point.

---

## Tổng quan: 7 phase

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 0  Prerequisites (env + deps)                            │
│  Phase 1  Discovery → recording (LLM hoặc manual)               │
│  Phase 2  Extract scenarios + identify spin button coord        │
│  Phase 3  Generate test code (catalog LLM + hybrid template)    │
│  Phase 4  Run regression (hybrid)                               │
│  Phase 5  Math verification (statistical sim)                   │
│  Phase 6  Baseline snapshots (region + JSON)                    │
│  Phase 7  Maintenance (token refresh, UI update, schedule)      │
└─────────────────────────────────────────────────────────────────┘
```

Effort estimate cho 1 game lần đầu: **30-45 phút** (active), sau đó CI tự chạy regression hằng ngày.

## 2 cách chạy workflow

**Dashboard UI (recommended)** — tất cả phase qua web, không cần thuộc lệnh CLI:
```bash
npm run serve              # → http://localhost:3200/dashboard
# Tạo task → click button cho từng phase
```

**CLI** — dành cho automation, CI, hoặc khi không có browser:
```bash
npm run auto              # discovery
npm run extract-scenarios -- <slug>
npm run stats -- <slug> --spins 1000
npm run test:hybrid
```

Mỗi phase dưới đây có cả 2 đường — chọn cái phù hợp với bạn.

---

## Phase 0: Prerequisites

### 0.1. Dependencies
```bash
cd /Users/tranchinhthuc/Downloads/crawler-qa-agent
npm install
npx playwright install chromium    # nếu chưa có browser
```

### 0.2. Postgres + Redis (optional, cho persistent Test Runs history + queue)

```bash
npm run db:up        # docker compose up -d postgres redis
npm run db:generate  # prisma generate
npm run db:migrate   # tạo schema (test_runs, spin_results, validation_errors, stat_reports)
```

Mặc định Postgres ở port `5432`, Redis ở `6379`. Nếu không cần lưu lịch sử lâu dài (chỉ chạy ad-hoc), có thể bỏ qua — tool vẫn chạy nhưng tab "Test Runs (DB)" trên dashboard sẽ trống.

### 0.3. Environment (`.env`)
```bash
# Required
CLAUDE_CODE_OAUTH_TOKEN=...      # hoặc
ANTHROPIC_API_KEY=...             # (1 trong 2)

# DB (mặc định khớp docker-compose; bỏ qua nếu skip 0.2)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/crawler_qa
REDIS_URL=redis://localhost:6379

# Optional
QA_FORCE_LANG=en                  # ép game render English
QA_KEEP_BROWSER_OPEN=1            # giữ browser sau test xong (debug)
QA_FORCE_VISION=1                 # ép "Run Tests" dùng vision (bypass hybrid auto)
PORT=3200                         # dashboard port
```

### 0.4. Có sẵn 1 URL game valid

URL phải có token chưa expire (token thường expire 24-48h). Format ví dụ:
```
https://rc.dev.revenge-games.com/fiesta-magenta/?t=WaN0YdjiIr9sdC0RB6pkq2aj_BRL&oc=rcdemo&l=en&r=...
```

Verify token valid:
```bash
curl -sI "$GAME_URL" | head -3
# Expect: HTTP/2 200 hoặc 304
```

---

## Phase 1: Discovery (one-time per game)

Mục tiêu: capture spin endpoint + response shape vào `fixtures/recordings/{slug}__.../http.jsonl`.

### 1.0. Qua Dashboard

```
1. Mở http://localhost:3200/dashboard
2. Form "New Task" → paste GAME_URL → "Create Task"
3. Bỏ qua "Auto-run all phases" checkbox (để control từng phase)
4. Row task xuất hiện → click row → panel detail mở
5. Click "1. Collect Context"
   → tab "Full Log" tự stream events:
     - EVENT:pre_game_iter ...
     - [iter 0] click (720, 810) — AI auto-play
     - EVENT:pre_game_ready
     - Auto-extracted N scenario(s) ← scenarios tự sinh sau Collect
6. Phase done → status badge chuyển "context_ready"
```

### 1.1. Option A — `npm run auto` (CLI, KHUYẾN NGHỊ)

AI tự dismiss pre-game + click spin 3-5 lần.

```bash
GAME_URL="https://rc.dev.revenge-games.com/fiesta-magenta/?t=..." \
npm run auto
```

Expected output:
```
EVENT:pre_game_start ...
[pre-game iter 0] action=wait blocker=loading
[pre-game iter 1] action=click blocker=launcher
[pre-game iter 2] action=done ready=true
EVENT:pre_game_ready
[iter 0] spins=0/3 — hỏi AI...
[iter 0] action=spin_done state=result_visible balance=981,175.05 win=4.50
[iter 1] click (720, 810)
[iter 1] spin API response: true
[iter 1] ✔ spin 2/3
...
✔ Output: fixtures/recordings/fiesta-magenta__auto-2026-05-15T04-13-18-026Z
 - spins completed: 3/3
 - http.jsonl:      653
```

**Cost**: ~$0.50-2 (3-5 spin × LLM iterations).
**Time**: ~2-3 phút.
**Pros**: Reliable — đảm bảo có spin response trong recording.
**Cons**: Tốn LLM token.

### 1.2. Option B — `npm run record` (manual)

User chơi tay trong browser 3 phút, recorder chỉ ghi traffic.

```bash
GAME_URL="..." npm run record
```

Browser mở → user phải:
1. Click qua pre-game popup
2. Đợi game load
3. Click Spin ít nhất 2-3 lần (mỗi spin = 1 response trong recording)
4. Đóng browser khi xong (hoặc đợi 180s timeout)

**Cost**: $0 (no LLM).
**Time**: ~3-5 phút.
**Risk**: User không click spin → recording rỗng → Phase 2 fail.

### 1.3. Verify recording

```bash
ls fixtures/recordings/ | tail -1
# fiesta-magenta__auto-2026-05-15T04-13-18-026Z

# Verify có spin response
grep -c "winAmount.*betAmount" fixtures/recordings/fiesta-magenta__*/http.jsonl | tail -1
# Expect: ≥ 1 (số spin response trong recording)
```

Nếu = 0 → recording không có spin (chỉ có pre-game). Re-run với `npm run auto`.

---

## Phase 2: Extract scenarios + identify coord

### 2.0. Qua Dashboard

**Scenarios**: auto-extract tự chạy sau Collect phase (không cần thao tác). Verify trong Full Log: `"Auto-extracted N scenario(s)"`.

View scenarios + expected values:
```
Tab "Test Cases" → button [📋 scenarios] → panel expand inline
Hiển thị: name, label, expected fields (bet, win, balance, has_bonus, ...)
```

**Spin button coord**: tab "Screenshots" → xem ảnh `iter-001.png` (hoặc bất kỳ post-pregame screenshot). Inspect visually hoặc dùng dev tool đo pixel.

### 2.1. Auto-extract scenarios (CLI)

```bash
npm run extract-scenarios -- fiesta-magenta
```

Expected output:
```
Extracting from 1 recording(s) for slug "fiesta-magenta"...

→ fixtures/recordings/fiesta-magenta__auto-2026-05-15T04-13-18-026Z
  ✔ fixtures/scenarios/fiesta-magenta/small_win.json
  ✔ fixtures/scenarios/fiesta-magenta/no_win.json

Done — wrote 2 scenario file(s)
```

Mỗi scenario file:
- `spin_response` — body raw + url_pattern + headers từ recording
- `expected` — bet, win, balance từng spin
- `prelude.authorize/config/balance` — response phụ trợ (dùng cho synthetic test, skip trong hybrid)

### 2.2. Verify scenarios

```bash
cat fixtures/scenarios/fiesta-magenta/small_win.json | jq '.expected'
# {
#   "bet": 1,
#   "win": 0.5,
#   "starting_balance": 981175.05,
#   "ending_balance": 981174.55,
#   "has_bonus": false,
#   "is_free_spin": false
# }
```

Nếu output `null` hoặc thiếu field → recording không capture được body đầy đủ. Re-record.

### 2.3. Identify spin button coord

Cần biết tọa độ click Spin trong viewport 1440×900.

Cách 1 — AI đã click trong auto-play:
```bash
cat fixtures/recordings/fiesta-magenta__auto-*/iterations.json | jq '.[] | select(.decision.action == "click") | .decision | {x, y, reason}' | head -5
# {
#   "x": 720,
#   "y": 810,
#   "reason": "Reels are idle... click the central spin button..."
# }
```

Cách 2 — visual inspect:
```bash
open fixtures/recordings/fiesta-magenta__auto-*/screenshots/iter-001.png
# Xem ảnh, ước lượng vị trí spin button
# Note: ảnh kích thước thực = viewport 1440x900
```

Note coord vào file test hoặc nhớ để dùng ở Phase 3.

---

## Phase 3: Generate test code

### 3.0. Qua Dashboard

```
Click "2. Generate Tests" (next to Collect Context button)
   → LLM sinh fixtures/specs/{slug}/{slug}.test-cases.json (catalog 15-30 case)
   → tab "Test Cases" populate list cases với severity/category
   → tests/generated/{slug}.spec.ts (vision spec — fallback nếu chưa có scenario)
```

> **Lưu ý**: Không còn nút riêng `🎯 gen hybrid` / `▶ run hybrid` trên UI — đã consolidate.
> Hybrid spec (deterministic) được **auto-generated** ngay trước khi chạy "3. Run Tests" nếu scenarios đã có sau Phase 1 (smart routing). Khi catalog drift (rename case ID), spec cũng tự re-emit từ catalog hiện tại.

### 3.1. Hybrid test (CLI, KHUYẾN NGHỊ cho regression)

```bash
# Option A: qua CLI (tự viết script)
npx tsx -e "
import { generateHybridTestCode } from './src/ai/authoring.js';
import { writeFileSync } from 'node:fs';
const code = generateHybridTestCode({
  gameSlug: 'fiesta-magenta',
  harnessImportPath: 'unused',
  envVarUrl: 'GAME_URL',
  spinButton: { x: 720, y: 810 },  // từ Phase 2.3
});
writeFileSync('tests/generated/fiesta-magenta.hybrid.spec.ts', code);
console.log('Wrote', code.length, 'chars');
"

# Option B: qua dashboard (xem Phase 3.3)
```

Output file:
```
tests/generated/fiesta-magenta.hybrid.spec.ts
```

Nội dung tự sinh: 1 `test()` cho mỗi scenario, mỗi test gồm:
- `makeDeterministic({ spinOnly: true, noFreeze: true })`
- `page.goto + waitForGamePlayScreen` (LLM pre-game)
- `spinDeterministic` (click coord)
- `assertSpinMatchesExpected`

**Cost codegen**: $0 (template, no LLM).
**Cost runtime**: $0.05-0.20/test (pre-game LLM 1 lần).

### 3.2. LLM test catalog (optional, full coverage)

Nếu muốn test catalog rich (15-30 case với invariants):

```bash
GAME_URL="..." npm run qa
```

Chạy full pipeline 3 phase qua CLI:
- Collect: ~2-3 phút (LLM discovery)
- Generate: ~1-2 phút (LLM sinh code)
- Run: ~10-20 phút (vision per spin)

Output:
- `fixtures/specs/{slug}/{slug}.spec.json` — GameSpec với invariants
- `fixtures/specs/{slug}/{slug}.test-cases.json` — catalog 15-30 case
- `tests/generated/{slug}.spec.ts` — LLM-driven test code

**Cost**: ~$5-15 (toàn bộ 3 phase).
**Khi nào**: lần đầu test game mới, hoặc sau khi game update major.

### 3.3. Generate qua Dashboard (full flow)

```bash
npm run serve
# Mở http://localhost:3200/dashboard
```

Steps:
1. Form "New Task" → paste GAME_URL → Create Task
2. Click **1. Collect Context** → wait Collect phase done (~3 phút).
   Scenarios auto-extracted (xem log: "Auto-extracted N scenario(s)").
3. Click **2. Generate Tests** → LLM sinh catalog + vision test code (~1-2 phút).
4. Click **3. Run Tests** → smart routing tự chọn:
   - Scenarios có sẵn → auto-emit `tests/generated/{slug}.hybrid.spec.ts` rồi run (deterministic, $0-0.20)
   - Không có scenarios → run vision spec (LLM cost cao hơn)

---

## Phase 4: Run regression

### 4.0. Qua Dashboard

```
Click "3. Run Tests"
   → smart routing: hybrid khi có scenarios, vision khi không.
   → spawn Playwright → status: "running — watch Full Log tab"
   → tab "Full Log" stream output từng test pass/fail
   → khi xong, tab "Test Cases" update với status passed/failed per test
```

**Per-case re-run**: trên mỗi row case có nút `▶ Run` (bên phải status badge). Click để chỉ chạy đúng case đó (cùng smart routing). Nếu catalog ID drift khỏi spec file (rename), system auto-regen spec từ catalog trước khi grep.

Khi test fail:
```
Tab "Errors" → mỗi error row tự render inline diff visualization:
   - Region snapshot mismatch → 3 ảnh baseline / actual / diff side-by-side (click để zoom)
   - JSON snapshot mismatch → diff lines colorized (added=green, removed=red, changed=amber)
```

Hoặc xem full Playwright UI:
```
Click [📊 playwright report] → mở reports/html/ trong tab mới
Full visual diff viewer + trace viewer + console log + video
```

### 4.1. Run CLI

```bash
QA_SLUG=fiesta-magenta \
GAME_URL="https://rc.dev.revenge-games.com/fiesta-magenta/?t=..." \
npm run test:hybrid
```

Expected output:
```
Running 2 tests using 1 worker
  ✓ any_win — pre-game qua LLM, spin qua mock (45.3s)
  ✓ no_win — verify balance math (32.1s)
  2 passed (1.3m)
```

Hoặc chạy generated hybrid spec cụ thể:
```bash
GAME_URL="..." npx playwright test tests/generated/fiesta-magenta.hybrid.spec.ts
```

### 4.2. Output artifacts

| Artifact | Path |
|---|---|
| HTML report | `reports/html/index.html` (xem qua `npm run report`) |
| Test results JSON | `test-results/` |
| Screenshots khi fail | `test-results/<test-name>/test-failed-1.png` |
| Video | `test-results/<test-name>/video.webm` |
| Per-test pregame screenshots | `fixtures/tasks/<task-id>/screenshots/` (nếu chạy qua dashboard) |

### 4.3. Test pass criteria

| Test | Pass = |
|---|---|
| `pre-game ready` | LLM dismiss xong popup, AI confirm play screen ready |
| `spinRequestCount >= 1` | Mock /spin fire ít nhất 1 lần |
| `assertSpinMatchesExpected` | Bet/win/balance khớp scenario expected ±0.01 |

---

## Phase 5: Statistical math verification

### 5.0. Qua Dashboard

```
Trên main action bar (sau "3. Run Tests"):
   [📊 Run Stats]  (prompt sẽ hỏi số spins)

1. Click [📊 Run Stats]
   → prompt yêu cầu nhập số spins (default 1000)
   → preflight token check (~1 giây)
   → nếu HTTP 401/403 → fail ngay với hướng dẫn re-record
   → nếu OK → mass-spin với concurrency 4, throttle 10ms
2. Tab "Full Log" stream tiến độ:
   [simulate] 100/1000  RTP=121.84%  hits=37  fail=0
3. Xong → log show formatted report (RTP / HF / distribution)
4. Report save tự động vào fixtures/statistical/{slug}-{ISO}.json
   + DB write-through: row mới trong tab "Test Runs (DB)" với stat report đính kèm
5. Tab "Test Cases" → khối stats inline sẽ render summary từ report mới nhất
   (button 🔄 refresh để re-fetch, ⬇ json để download)
```

### 5.1. Quick smoke (CLI, 5-100 spin)

```bash
npm run stats -- fiesta-magenta --spins 100 --concurrency 2 --throttle 50
```

Expected output:
```
[stats] slug=fiesta-magenta spins=100 concurrency=2 throttle=50ms
[simulate] Using template from: fixtures/recordings/fiesta-magenta__auto-...
[simulate] Preflight token check...
[simulate] ✔ Preflight OK (status 201)
[simulate] 100/100  RTP=121.84%  hits=37  fail=0

=== Statistical simulation report — fiesta-magenta ===
Spins: 100/100 successful  (0 failed)
Duration: 16.1s
Observed RTP: 121.84%       ← noise ở N=100, không phải bug
Hit frequency: 37.00%
Max win: 34
Win distribution:
  =0   (no win)             51  (51.00%)
  0-1×                      14  (14.00%)
  ...
```

### 5.2. Production-grade (10k+ spin)

```bash
npm run stats -- fiesta-magenta --spins 10000 --concurrency 8 --throttle 5
```

Chạy ~10-15 phút. RTP error ~±1% → đủ tin để verify spec.

Tham khảo std deviation:
| N spin | RTP std dev | Use case |
|---|---|---|
| 100 | ±12% | Smoke test only |
| 1,000 | ±4% | Initial sanity |
| 10,000 | ±1% | QA gate |
| 100,000 | ±0.4% | Cert / pre-launch |

### 5.3. Token expired

Nếu preflight fail:
```
❌ Token expired:
Preflight failed with HTTP 401 — token in recorded URL likely expired.
Fix: re-record with fresh session:
  GAME_URL="<fresh URL>" npm run auto
  npm run extract-scenarios -- fiesta-magenta
  npm run stats -- fiesta-magenta --spins 100
```

Quay lại Phase 1 với URL token mới.

---

## Phase 6: Baseline snapshots

### 6.0. Qua Dashboard

Lần đầu hoặc khi UI/API thay đổi có chủ đích:
```
Tab "Test Cases" → button [🔄 update baselines]

Click → prompt hỏi:
   1 = region snapshot only (pixel UI)
   2 = JSON snapshot only (response shape)
   3 = both (default)

Backend spawn Playwright với REGION_SNAPSHOT_UPDATE=1 / JSON_SNAPSHOT_UPDATE=1
   → Full Log stream output
   → Lần sau click "3. Run Tests", baseline mới được dùng để compare
```

**Workflow đúng cho UI change**:
1. Designer/server push thay đổi
2. Click "3. Run Tests" → fail vì snapshot mismatch
3. Tab "Errors" → xem inline diff visualization
4. Decide: intentional → click [🔄 update baselines]. Bug → fix code, không update
5. `git add fixtures/templates/ fixtures/snapshots/ && git commit`

### 6.1. Region snapshot (CLI)

Lần đầu — tạo baseline:
```bash
REGION_SNAPSHOT_UPDATE=1 npm run test:hybrid
```

Output:
```
fixtures/templates/fiesta-magenta/spin-button-idle.png    ← baseline
```

Lần sau — verify:
```bash
npm run test:hybrid
# Pass nếu pixel diff < threshold (default 2%)
# Fail với diff PNG ở test-results/region-snapshots/{slug}/{name}.diff.png
```

Khi nào update baseline:
- Designer đổi color/icon button (intentional change)
- Game update major version
- Resolution thay đổi

### 6.2. JSON snapshot (response shape regression)

Lần đầu:
```bash
JSON_SNAPSHOT_UPDATE=1 npm run test:hybrid
```

Output:
```
fixtures/snapshots/fiesta-magenta/spin-response-shape-no-win.json    ← baseline
```

Lần sau:
```bash
npm run test:hybrid
# Pass nếu shape khớp (structural mode) sau khi mask volatile fields (id, round, timestamp)
# Fail với diff text: [changed/added/removed] field-path: expected=X actual=Y
```

Khi nào update:
- Server đổi schema (intentional)
- Thêm field mới
- Đổi type của field

### 6.3. Commit baselines vào git

```bash
git add fixtures/templates/ fixtures/snapshots/
git commit -m "test: baseline snapshots for fiesta-magenta v1.2"
```

Mỗi PR thay đổi UI hoặc API phải:
1. Update baseline với env flag
2. Review pixel diff / JSON diff visually
3. Commit baseline + code change cùng PR

---

## Phase 7: Maintenance

### 7.1. Token refresh schedule

Tokens expire 24-48h. Workflow:

```
Hằng ngày (Cron 6am):
  1. Get fresh URL từ operator → set GAME_URL env
  2. npm run auto                          # 3 phút
  3. npm run extract-scenarios -- {slug}   # 1 giây
  4. npm run stats -- {slug} --spins 1000  # 3 phút (sanity)
  5. npm run test:hybrid                   # 2-3 phút
  6. Báo cáo qua Slack/email nếu fail
```

Total: ~10 phút/game/ngày → 10 game = 100 phút CI/ngày.

### 7.2. Game update detection

Khi operator deploy new version:
- Region snapshot fail → button/UI đổi → update baseline + verify visually
- JSON snapshot fail → API shape đổi → check changelog → update + cập nhật scenario expected
- Hybrid test fail "no spin request fired" → coord đổi → update SPIN_BUTTON

### 7.3. CI integration sample (GitHub Actions)

```yaml
name: QA Regression
on:
  schedule: [{ cron: "0 6 * * *" }]      # 6am UTC daily
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - name: Record fresh
        env:
          GAME_URL: ${{ secrets.GAME_URL_FIESTA }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
        run: npm run auto
      - run: npm run extract-scenarios -- fiesta-magenta
      - name: Stats sanity
        run: npm run stats -- fiesta-magenta --spins 1000 --concurrency 4
      - name: Hybrid regression
        env:
          GAME_URL: ${{ secrets.GAME_URL_FIESTA }}
        run: npm run test:hybrid
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: failure-artifacts
          path: |
            test-results/
            reports/html/
            fixtures/recordings/
```

---

## Phase 8: Troubleshooting common issues

### Issue: `Pre-game không ready: wait_exhausted`
**Symptom**: hybrid test fail sau 30-45s ở pre-game.
**Cause**: Game loading > 6 consecutive wait iters (>~30s).
**Fix**:
1. Verify token valid: `curl -I "$GAME_URL"`
2. Tăng timeout: edit `pre-game.ts` `maxIterations` lên 40
3. Network slow: thêm `pollMs` cao hơn

### Issue: `no spin request fired after 4 click(s) at (720, 810)`
**Symptom**: pre-game ready nhưng spin không trigger.
**Cause** (xếp theo độ phổ biến):
1. **`noFreeze` chưa set** → Date.now frozen phá Cocos event binding. Fix: `noFreeze: true` trong `makeDeterministic` opts.
2. Coord sai → inspect `fixtures/recordings/.../iterations.json` để lấy AI-clicked coord
3. Popup che spin button → AI confirm "ready" sai → tăng pre-game iter, hoặc check screenshot
4. Game ở Bonus/Feature mode → cần spin_sequence array (cascade game)

### Issue: `Preflight failed with HTTP 401/403`
**Cause**: Token trong recording expired.
**Fix**: Re-record với URL có token fresh.

### Issue: `Scenario not found: fixtures/scenarios/{slug}/{name}.json`
**Cause**: Scenario chưa extract hoặc label không match.
**Fix**:
```bash
ls fixtures/scenarios/{slug}/    # list available
npm run extract-scenarios -- {slug}    # re-extract
```

### Issue: `Observed RTP: 121.84%` (>100%)
**Cause**: N spin quá nhỏ. Std dev ±12% ở N=100.
**Fix**: Tăng N lên 10000+ → noise giảm về ±1%.

### Issue: Region snapshot fail nhưng UI trông giống
**Cause**: pixel diff không tolerant với anti-aliasing.
**Fix**:
1. Tăng `maxDiffRatio` trong test (default 0.02 = 2%)
2. Crop region nhỏ hơn để loại trừ animation
3. Update baseline nếu thay đổi intended: `REGION_SNAPSHOT_UPDATE=1`

### Issue: Hybrid test pass khi run riêng, fail trong CI
**Cause** thường gặp:
- Headed vs headless: CI dùng headless, local headed → font render khác → region snapshot fail
- Network latency: CI gọi remote game server chậm hơn → timeout
**Fix**:
1. `playwright.config.ts` set `headless: true` cho cả 2
2. Tăng `test.setTimeout()` cho CI

---

## Appendix A: Decision tree — flow nào dùng khi?

```
Có recording fresh cho slug?
   ├─ NO  → Phase 1: Dashboard "1. Collect Context" hoặc CLI `npm run auto`
   └─ YES
        │
        Cần verify math (RTP/HF)?
        ├─ YES → Dashboard [📊 Run Stats] hoặc CLI `npm run stats -- {slug} --spins 10000`
        │
        Cần regression cho UI flow?
        ├─ YES → Dashboard "3. Run Tests" (smart routing tự dùng hybrid khi có scenarios)
        │        hoặc CLI `npm run test:hybrid`
        │
        Cần test rich catalog (15+ case)?
        ├─ YES → Dashboard "2. Generate Tests" → "3. Run Tests" hoặc CLI `npm run qa`
        │
        Cần test multi-step flow (buy feature, autoplay)?
        └─ YES → Dashboard "2. Generate Tests" (chỉ LLM xử lý được)
```

---

## Appendix B: Dashboard UI map

Toàn bộ button + endpoint trên dashboard. Mở `npm run serve` → http://localhost:3200/dashboard.

### Trên row task (table)
- Click row → mở Task Detail panel
- **▶ Collect / Generate / Run** (single "next-phase" button — chỉ show phase tiếp theo) → POST `/api/tasks/:id/collect|generate|run`
- **🗑 Delete** → DELETE `/api/tasks/:id` (xóa task + toàn bộ artifact của slug)

### Trong Task Detail panel — main action bar (6 button)

| Button | Endpoint | Mục đích |
|---|---|---|
| **1. Collect Context** | POST `/api/tasks/:id/collect` | LLM discovery + auto-extract scenarios |
| **2. Generate Tests** | POST `/api/tasks/:id/generate` | LLM sinh catalog + vision test code (kèm Phase 2.5 auto-record UI flows) |
| **3. Run Tests** | POST `/api/tasks/:id/run` | Smart routing — hybrid khi có scenarios, vision khi không |
| **📊 Run Stats** | POST `/api/tasks/:id/run-stats` (prompt spins) | Mass-spin direct API (RTP/HF/distribution) |
| **🎬 Re-record Pre-game** | POST `/api/tasks/:id/record-pregame` | Re-record pre-game click sequence (chỉ khi UI game đổi) |
| **🎬 Record UI Flows** | POST `/api/tasks/:id/record-ui-flows` | Phase 2.5 — LLM record click sequence cho replay_or_vision cases (buy_feature, special_bet). Test runs sau đó replay deterministic ($0) |
| **🎰 Capture FS Chain** | POST `/api/tasks/:id/capture-fs-buy` | Phase 2.6 — Click Buy Feature → capture FS chain → save `free_spin_chain.json`. Unblock `free_spins` tests với real data thay vì synthesize |

Phụ trợ: **↻ Retry all**, **🗑 Delete**, **Cancel/Stop**.

### Tab "Test Cases" — header action row

| Button | Endpoint | Mục đích |
|---|---|---|
| 📄 report.md | GET `/api/tasks/:id/case-report.md` | QA-readable Markdown report |
| ⬇ report.json | GET `/api/tasks/:id/case-report.json` | Full report data (JSON) |
| 📊 playwright report | GET `/playwright-report/` | Full Playwright HTML report (diff viewer, trace, video) |
| 📋 scenarios | GET `/api/tasks/:id/scenarios` | Expand panel show scenario details |
| 🔄 update baselines | POST `/api/tasks/:id/update-baselines` (prompt 1=region/2=json/3=both) | Re-capture snapshot baselines |
| 📄 view .md / ⬇ .md | GET `/api/tasks/:id/test-cases.md[?download=1]` | Catalog xem dạng Markdown |
| 📊 .csv | GET `/api/tasks/:id/test-cases.csv?download=1` | Catalog xuất Excel/Sheets |

### Tab "Test Cases" — per-case row

| Button | Endpoint | Mục đích |
|---|---|---|
| ▶ Run | POST `/api/tasks/:id/cases/:caseId/run` | Re-run đúng 1 case (smart routing + auto-regen spec nếu catalog drift) |

### Tab "Test Runs (DB)" — Postgres-backed history (chỉ khi DB enabled)

| Button | Endpoint | Mục đích |
|---|---|---|
| Refresh | GET `/api/test-runs` | List 50 run mới nhất từ Postgres |
| View | GET `/api/test-runs/:id` + `/spins` + `/errors` | Drill-down spins / errors / stat report |
| 🗑 | DELETE `/api/test-runs/:id` | Xóa 1 run (cascade spins + errors + stat report) |
| 🗑 All / by game | DELETE `/api/test-runs?all=1` hoặc `?gameCode=X` | Wipe history |
| Summary | POST `/api/test-runs/:id/summary` | AI bug summarizer cho run đó |

### Trong Task Detail panel — các tab khác

- **QA View** — formatted markdown view
- **Context (AI inputs)** — show recording samples + spec + extracted config
- **JSON** — raw JSON snapshots (play screen, api samples, paytable, spec)
- **Errors** — failed test rows với **inline diff visualization**:
  - Region fail → 3 ảnh side-by-side (baseline / actual / diff)
  - JSON fail → diff lines colorized
- **Spin Events** — live spin event stream
- **Screenshots** — per-test + global screenshots
- **Full Log** — stdout/stderr stream của tất cả phase

### Real-time events
Mọi action stream qua SSE `/api/tasks/:id/stream`:
- `EVENT:pre_game_iter`
- `EVENT:spin` (balance, bet, win)
- `EVENT:case_start` / `case_end`
- `EVENT:phase_done`
- `EVENT:test_mode` (mode=hybrid|vision, scenarios=N)

---

## Appendix C: Commands cheatsheet

```bash
# Discovery
npm run auto                            # AI tự chơi 3-5 spin
npm run record                          # Manual chơi tay
npm run record-pregame                  # auto-play + capture pre-game click sequence
npm run extract-scenarios -- <slug>     # Extract scenarios từ recording
npm run extract-scenarios -- --list     # List recordings có sẵn

# Generate test code
npm run qa                              # Full LLM pipeline (catalog + code + run)
# Hybrid codegen: auto khi click "3. Run Tests" trên dashboard

# Run tests
npm run test                            # Tất cả Playwright test
npm run test:hybrid                     # Hybrid spec (tests/deterministic-hybrid.spec.ts)
npm run test:integration                # Self-test (synthetic page)
npm run test:deterministic              # Pure deterministic example

# Statistical
npm run stats -- <slug> --spins N --concurrency C --throttle MS
npm run stats -- <slug> --extract-scenarios   # discover rare events từ N spin
npm run stats -- <slug> --history-audit       # API history cross-check
npm run stats -- <slug> --debug               # dump full request/response
npm run stats:currency-batch -- <slug>        # multi-currency batch runner

# Statistical follow-up tools
npm run pregame-stats                   # aggregate pre-game replay/vision stats
npm run balance-trace                   # CSV/MD QA sheet export từ spin log

# AI analyzers
npm run analyze:game -- <slug>          # AI tổng hợp rule game từ recording + spec
npm run bug-summary -- <test-run-id>    # AI bug report cho 1 test run

# Database (Postgres + Redis)
npm run db:up                           # docker compose up -d postgres redis
npm run db:down                         # tear down
npm run db:generate                     # prisma generate (regen client)
npm run db:migrate                      # prisma migrate dev (apply schema)
npm run db:reset                        # prisma migrate reset --force (nuke + re-seed)
npm run db:studio                       # mở Prisma Studio (browse data)
npm run worker:stats                    # BullMQ stats worker (process queued sims)

# Dashboard
npm run serve                           # http://localhost:3200/dashboard
npm run report                          # Mở Playwright HTML report

# Maintenance
REGION_SNAPSHOT_UPDATE=1 npm run test:hybrid    # Update visual baseline
JSON_SNAPSHOT_UPDATE=1 npm run test:hybrid      # Update JSON baseline
QA_FORCE_VISION=1 ...                           # ép Run Tests dùng vision (debug)
npm run clean                                   # Dọn artifacts
```

---

## Appendix D: File layout sau khi test 1 game xong

```
fixtures/
├── recordings/
│   └── fiesta-magenta__auto-2026-05-15T04-13-18-026Z/
│       ├── http.jsonl          (653 entries)
│       ├── ws.jsonl
│       ├── console.jsonl
│       ├── iterations.json     ← AI clicked coords
│       ├── summary.json
│       └── screenshots/        ← iter-000.png ... iter-N.png
│
├── scenarios/fiesta-magenta/
│   ├── no_win.json             ← scenario fixture
│   └── small_win.json
│
├── specs/fiesta-magenta/       (chỉ có nếu chạy npm run qa)
│   ├── fiesta-magenta.spec.json        ← GameSpec
│   ├── fiesta-magenta.test-cases.json  ← Test catalog
│   └── fiesta-magenta.preflight.json
│
├── snapshots/fiesta-magenta/   (lần đầu chạy hybrid với UPDATE env)
│   └── spin-response-shape-no-win.json
│
├── templates/fiesta-magenta/   (lần đầu chạy hybrid với UPDATE env)
│   └── spin-button-idle.png
│
├── statistical/
│   └── fiesta-magenta-2026-05-15T07-05-04-815Z.json   ← latest stats report
│
└── tasks/{task-id}/             (chỉ có nếu chạy qua dashboard)
    ├── case-report.json
    ├── case-report.md
    └── screenshots/

tests/
└── generated/
    ├── fiesta-magenta.spec.ts          ← LLM-driven (nếu chạy qa)
    └── fiesta-magenta.hybrid.spec.ts   ← Hybrid template-based (nếu gen-hybrid)
```

---

## Appendix E: Time + Cost breakdown thực tế

Test 1 game lần đầu (fiesta-magenta) — measured numbers:

| Phase | Time | Cost (LLM) | Output |
|---|---|---|---|
| 0. Setup env | 5 phút | $0 | .env, deps installed |
| 1. `npm run auto` | 3 phút | $0.50-1 | recording 653 http entries |
| 2. `extract-scenarios` | 1 giây | $0 | 2 scenario JSON |
| 3a. Hybrid codegen | 1 giây | $0 | hybrid.spec.ts (~3KB) |
| 3b. Full LLM `npm run qa` | 20-30 phút | $5-12 | catalog + spec + LLM tests |
| 4. `test:hybrid` | 2-3 phút | $0.10-0.40 | 2 test pass |
| 5. `stats --spins 1000` | 3 phút | $0 | RTP / HF / distribution |
| 6. Baseline `UPDATE=1` | 2-3 phút | $0.10-0.40 | snapshots + templates |
| **Total minimal (hybrid only)** | **~15 phút** | **$0.50-1.50** | Ready for regression |
| **Total full (with qa)** | **~45 phút** | **$5-15** | Full catalog + invariants |

Sau lần đầu, mỗi lần chạy regression:
- Hybrid: 2-3 phút, $0.10-0.40
- Statistical 1k: 3 phút, $0
- Statistical 10k: 10-15 phút, $0

---

## Summary — 2 cách dùng

### Dashboard UI (recommended cho dev/QA cá nhân)
```
1. Mở http://localhost:3200/dashboard
2. New Task → paste GAME_URL → Create
3. Click 1. Collect Context → 2. Generate Tests → 3. Run Tests
                            → 📊 Run Stats (prompt nhập N spins, cho math)
4. Tab "Errors" để xem diff inline khi fail
5. 📊 playwright report nếu cần deep-dive
6. 🔄 update baselines khi UI/API thay đổi có chủ đích
7. Tab "Test Runs (DB)" để xem lịch sử run cũ + summary AI
```

### CLI (recommended cho CI/automation)
```bash
1. npm run auto                                # discovery
2. npm run extract-scenarios -- {slug}          # AUTO sau Collect, optional CLI
3. npm run stats -- {slug} --spins 10000        # math verify
4. npm run test:hybrid                          # regression
5. REGION_SNAPSHOT_UPDATE=1 npm run test:hybrid # update baseline
6. JSON_SNAPSHOT_UPDATE=1 npm run test:hybrid   # update JSON baseline
```

### Khi nào dùng cái nào?

| Use case | Dashboard | CLI |
|---|---|---|
| Test 1 game lần đầu, explore output | ✅ | ⚠️ (verbose hơn) |
| QA team daily QA work | ✅ | ⚠️ |
| Debug khi test fail (xem diff) | ✅ (inline viz + Playwright report link) | ⚠️ (text only) |
| CI cron nightly | ❌ (cần browser) | ✅ |
| Bash script automation | ❌ | ✅ |
| Multi-task parallel run | ✅ (queue UI) | ⚠️ (tự lo) |

Đó là toàn bộ workflow ở tình trạng tool hiện tại.
