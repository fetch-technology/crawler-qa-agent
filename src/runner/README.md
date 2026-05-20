# Deterministic test layer

Hai con đường test song song trong codebase:

| | LLM-based flow (cũ) | Deterministic flow (mới) |
|---|---|---|
| Entry | `auto-play.ts`, `test-harness.ts:doAutoSpin` | `deterministic.ts:makeDeterministic` + `deterministic-spin.ts:spinDeterministic` |
| Mỗi spin | Vision call quyết định → click → đợi server | Click cố định → response từ mock |
| Cost | $$$ + chậm | Free, vài trăm ms |
| Flake | Cao (LLM + RNG + animation) | Không (mọi nguồn random bị freeze) |
| Use case | Discovery, game lạ, chưa có recording | CI, regression, smoke test |

Hai flow share chung: `spin-detect.ts`, `pre-game.ts`, recorder, fixtures format.

## Pipeline 3 bước

```
┌────────────────────┐    ┌─────────────────────┐    ┌────────────────────┐
│ 1. Record (cũ)     │ →  │ 2. Extract scenarios│ →  │ 3. Run deterministic│
│ npm run record     │    │ npm run extract-... │    │ npm run test:det... │
└────────────────────┘    └─────────────────────┘    └────────────────────┘
   http.jsonl              fixtures/scenarios/        Playwright test
   ws.jsonl                  {slug}/                   pass/fail
```

### 1. Record (đã có sẵn)

```bash
npm run record
# → fixtures/recordings/{slug}__{timestamp}/http.jsonl
```

### 2. Extract scenarios

```bash
npm run extract-scenarios -- fiesta-magenta
# → fixtures/scenarios/fiesta-magenta/no_win.json
# → fixtures/scenarios/fiesta-magenta/normal_win.json
# → fixtures/scenarios/fiesta-magenta/bonus_trigger.json
```

Extractor đọc recording, phân loại từng spin theo heuristic (`scenario.ts:classifyScenario`):

| Label | Điều kiện |
|---|---|
| `no_win` | win = 0 |
| `small_win` | 0 < win/bet < 5 |
| `normal_win` | 5 ≤ win/bet < 20 |
| `big_win` | 20 ≤ win/bet |
| `bonus_trigger` | `winFreeSpins > 0` |
| `free_spin` | `isFreeSpin = true` |
| `max_win` | `isMaxWin = true` |

User có thể edit file JSON sau để relabel.

### 3. Run deterministic test

```bash
# Lần đầu: tạo region snapshot baselines
REGION_SNAPSHOT_UPDATE=1 npm run test:deterministic

# Lần sau: assertion thực sự
npm run test:deterministic
```

## API cheatsheet

### `makeDeterministic(page, opts)`

Mount tất cả mocking + freeze lên page. Phải gọi **trước** `page.goto()`.

```ts
const handle = await makeDeterministic(page, {
  slug: "fiesta-magenta",
  scenario: "bonus_trigger",
});
await page.goto(GAME_URL);
```

Freeze:
- `Date.now()` → `scenario.frozen_time_ms`
- `Math.random()` → mulberry32 với `scenario.random_seed`
- `performance.now()` → 60fps clock simulated
- `/spin /authorize /config /balance` → response đã ghi

### `spinDeterministic(page, handle, opts)`

Click spin button, đợi mock fire, return parsed response.

```ts
const result = await spinDeterministic(page, handle, {
  spinButton: { x: 720, y: 820 },
});
```

### `assertSpinMatchesExpected(result, expected, tolerance?)`

Verify bet/win/balance/has_bonus của result khớp expected từ scenario.

```ts
assertSpinMatchesExpected(result, handle.scenario.expected);
```

### `assertRegionMatches(page, opts)`

Region snapshot — thay LLM vision cho việc "verify UI state".

```ts
await assertRegionMatches(page, {
  slug: "fiesta-magenta",
  name: "spin-button-idle",
  region: { x: 680, y: 780, width: 100, height: 100 },
  maxDiffRatio: 0.02,
});
```

Baseline lưu ở `fixtures/templates/{slug}/{name}.png`. Update: `REGION_SNAPSHOT_UPDATE=1`.

## Statistical layer

```bash
npm run stats -- fiesta-magenta --spins 10000 --concurrency 8
```

Bắn 10k spin request trực tiếp tới game server (template từ recording mới nhất), aggregate RTP / hit frequency / win distribution. Không qua UI → vài phút thay vì vài chục giờ.

Cần recording fresh (token chưa hết hạn).

## Không động tới

Các file sau **không thay đổi** — tiếp tục dùng cho LLM flow:

- `src/auto-play.ts`
- `src/ai/vision.ts`
- `src/runner/test-harness.ts` (export `doAutoSpin` cho generated tests cũ)
- `src/runner/pre-game.ts`
- `src/runner/setup-driver.ts`
- `src/server/*` (chưa wire deterministic vào dashboard)

## JSON snapshot ([json-snapshot.ts](json-snapshot.ts))

So spin response (hoặc bất kỳ JSON nào) với baseline đã chốt. Phát hiện server đổi schema, AI sinh catalog khác cấu trúc, v.v.

```ts
import { assertJsonSnapshot } from "../src/runner/json-snapshot.js";

assertJsonSnapshot(result.parsed, {
  slug: "fiesta-magenta",
  name: "spin-response-shape",
  mask: ["id", "round", "player"],  // field mỗi spin khác → mask để không noise
  mode: "structural",  // chỉ check shape, không check value primitive
});
```

3 mode:

| Mode | Khi nào |
|---|---|
| `structural` (default) | Check key + type khớp. Primitive value bỏ qua. |
| `exact` | Full equality. Mỗi byte phải khớp. |
| `values` | Full equality, array unordered. |

Baseline lưu ở `fixtures/snapshots/{slug}/{name}.json`. Update: `JSON_SNAPSHOT_UPDATE=1`.

## Auto-extract sau Collect

Khi pipeline qua phase `collect` ([src/server/runner.ts](../../src/server/runner.ts) ~line 487), scenario extractor được gọi tự động:

```
Phase collect done → fixtures/recordings/{slug}__... created
                  → extractLatestForSlug(slug) chạy
                  → fixtures/scenarios/{slug}/*.json sẵn sàng cho deterministic test
```

Log line trong dashboard: `Auto-extracted N scenario(s) → fixtures/scenarios/{slug}/`.

Best-effort: nếu không extract được scenario (vd recording chưa có spin response), task vẫn pass — chỉ là deterministic mode chưa dùng được cho slug này.

## Test thử deterministic layer

3 cách verify, từ nhanh nhất đến đầy đủ nhất.

### 1. Integration test (không cần game thật, không cần token)

`tests/deterministic-integration.spec.ts` self-host 1 HTML mini giả lập slot game, verify mọi cấu phần của deterministic layer:
- Freeze `Date.now()` / `Math.random()` đã inject
- Mock spin route fire response từ scenario
- Region snapshot + JSON snapshot baseline stable

```bash
# Lần đầu — tạo baselines
REGION_SNAPSHOT_UPDATE=1 JSON_SNAPSHOT_UPDATE=1 npm run test:integration

# Lần sau — verify baselines stable
npm run test:integration
```

Pass = deterministic layer wire đúng. Dùng để CI gate khi sửa code trong `src/runner/`.

### 2a. End-to-end pure deterministic (giới hạn — không qua được pre-game)

```bash
QA_SLUG=fiesta-magenta GAME_URL="https://..." npm run test:deterministic
```

**Cảnh báo:** Pure deterministic chỉ work nếu game tự lên play screen sau page load. Hầu hết slot game có pre-game flow (login → loading 30s+ → age gate / tutorial popup) → pure deterministic không qua được vì không có cách robust để detect "play screen ready" mà không cần baseline hoặc LLM. Test sẽ fail với "no spin request fired after click" — click happen nhưng button bị che bởi loading screen.

Dùng cho:
- Synthetic test (xem `test:integration`)
- Game đơn giản load nhanh, không có popup pre-game
- Sau khi đã có region snapshot baseline cho "play screen ready" state

### 2b. End-to-end hybrid (RECOMMENDED — LLM cho pre-game, deterministic cho spin)

```bash
QA_SLUG=fiesta-magenta GAME_URL="https://..." npm run test:hybrid
```

Yêu cầu:
- Recording fresh + scenarios đã extract (như 2a)
- Token còn valid
- `CLAUDE_CODE_OAUTH_TOKEN` hoặc `ANTHROPIC_API_KEY` trong `.env`

Flow:
1. `makeDeterministic()` — set up mock /spin
2. `page.goto(GAME_URL)`
3. `waitForGamePlayScreen()` ([pre-game.ts](pre-game.ts)) — LLM dismiss tự động: age gate, terms, cookies, welcome, tutorial, loading
4. Play screen ready → `spinDeterministic()` — click mock spin button, response từ scenario
5. Assert từ `scenario.expected`

Cost: ~$0.05-0.20/test cho pre-game (1 lần khi vào game), $0 cho mỗi spin. So với LLM-flow nguyên thuỷ tốn ~$0.05-0.20 mỗi spin → hybrid tiết kiệm 80-95% khi test có nhiều spin/scenario.

### 3. Statistical sim — verify math (bypass UI)

```bash
npm run stats -- {slug} --spins 1000
```

Output: RTP / hit frequency / win distribution. Cần token valid; không qua browser.

### Bug đã gặp + fix khi viết integration test (lessons learned)

- **CORS preflight**: cross-origin POST với `content-type: application/json` trigger OPTIONS preflight. Route handler phải fulfill OPTIONS bằng `Access-Control-Allow-*` headers. Đã thêm `fulfillPreflightIfNeeded()` trong [deterministic.ts](deterministic.ts).
- **Viewport mặc định**: `devices["Desktop Chrome"]` = 1280×720. Mock UI có element ở y>720 sẽ ngoài viewport → mouse click miss. Set explicit `page.setViewportSize({ width: 1440, height: 900 })` nếu cần.
- **data: URL origin "null"**: Nhiều browser quirk với cross-origin requests từ data: URL. Dùng `page.goto("about:blank") + setContent()` thay vì data: URL cho mock page.

## Roadmap (chưa làm)

- [ ] `src/ai/authoring.ts` thêm mode emit deterministic-style test code
- [ ] Server / dashboard expose deterministic run mode (UI work)
- [ ] Token refresh cho statistical sim (hiện cần re-record manual khi token expire)
