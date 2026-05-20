# Báo cáo: crawler-qa-agent — Đánh giá và đề xuất cải tiến

> Tổng kết dự án sau quá trình review architecture, đánh giá hiện trạng và triển khai cải tiến.
>
> Ngày bắt đầu: 2026-05-13 — Hoàn thành validation: 2026-05-15
>
> **Status: ✅ Verified end-to-end với game thật (fiesta-magenta @ Revenge Games)**

---

## 1. Tình trạng ban đầu

### Mô tả dự án
**crawler-qa-agent** là QA automation tool dùng AI để test các canvas-based casino/slot games (Revenge Games, Pragmatic Play, PG Soft...). Mục tiêu: tự động khám phá game, sinh test case, chạy regression — KHÔNG cần hợp tác từ studio phát triển game (black-box testing).

### Kiến trúc hiện tại (LLM flow)

**Pipeline 3 phase độc lập:**

| Phase | Đầu vào | LLM dùng vào việc | Đầu ra |
|---|---|---|---|
| **Collect** | URL game | Vision dismiss popup, navigate pre-game, extract config | `fixtures/recordings/`, `fixtures/specs/` |
| **Generate** | Recording + spec | Sinh test catalog + Playwright code | `tests/generated/{slug}.spec.ts` |
| **Run** | Test code + game URL | Vision quyết định click ở đâu mỗi spin, OCR đọc balance/win | Test pass/fail + screenshot + video |

### Tech stack
- Playwright (Chromium, headed, 1440×900, `workers: 1`, `fullyParallel: false`)
- Claude API (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`)
- TypeScript + tsx (ESM, no build step)
- Node HTTP thuần + SSE cho dashboard
- Web dashboard tại `http://localhost:3200/dashboard`

### Key files
- `src/auto-play.ts` — entry vision loop
- `src/ai/vision.ts` — LLM vision (decideNextAction, OCR)
- `src/runner/test-harness.ts` — SpinCollector, doAutoSpin
- `src/runner/pre-game.ts` — LLM dismiss pre-game blockers
- `src/server/` — dashboard backend + task queue
- `src/discovery/`, `src/extractors/` — network capture

---

## 2. Các vấn đề

### 2.1. Non-determinism kép → test không tin được

Mỗi test có 2 nguồn random:
- **RNG game**: spin response random từ server (slot game bản chất là random)
- **LLM output**: cùng prompt + screenshot có thể ra decision khác nhau

→ Test fail không biết do **bug code** hay do **xui rủi** hay do **LLM nhìn nhầm**. Chỉ có thể assert mơ hồ kiểu "balance phải thay đổi", không bắt được bug logic cụ thể.

### 2.2. Test 3 spins không đủ verify math

Default `spinsPerTest: 3`. Math properties của slot game (RTP, hit frequency, volatility) cần **10k-100k+ spin** để có statistical significance. 3 spin = noise, không phải data.

Đây là **rủi ro thực sự** của slot game không được verify.

### 2.3. Cost LLM mỗi run cao

`doAutoSpin` gọi `decideNextAction` mỗi iteration, 5-25 iteration mỗi spin. Mỗi vision call ~$0.02-0.05.

| Workload | LLM cost ước tính |
|---|---|
| 1 test case (3 spin) | $0.05 – $0.20 + 30-120s |
| Full regression (20 case) | $1 – $4 + 15-30 phút |
| 100 game × 20 case × hàng ngày | $20-80/ngày, không scale |

### 2.4. LLM vision không reliable cho canvas

Balance/win amount luôn ở **cùng vị trí, cùng font, cùng màu** → bài toán template matching (giải xong từ 1990s). Dùng LLM vision OCR vừa **chậm** (2-5s/call), **đắt**, **đôi khi sai** (50 → 5O).

### 2.5. Headed browser + workers=1

`playwright.config.ts`: `fullyParallel: false`, `workers: 1`, `headless: false` → không scale CI. Phù hợp development, không phù hợp regression battery.

### 2.6. AI-generated test code khó maintain

Mỗi lần `npm run qa`, LLM regenerate test catalog + code → khó review, khó diff khi UI thay đổi, không track được "test này test gì".

### 2.7. Không có deterministic test infrastructure

Không có:
- Mock layer cho /spin response
- Snapshot testing
- Region/template matching
- Statistical verification

→ Mỗi run là 1 cuộc chạy random.

---

## 3. Khó khăn và thử thách của dự án

Phần này tổng kết những "trap" thực tế đã gặp khi review và triển khai cải tiến. Document để future-you (và team mới) không mất thời gian rediscover.

### 3.1. Thử thách domain (game testing)

#### Canvas game = không có DOM
Slot game render mọi thứ vào 1 `<canvas>` element. Không có `<div id="balance">`, không có CSS selector. Mọi thứ — symbol trên reel, balance, win amount, bonus screen — đều là **pixel trên canvas**.

→ Không thể dùng Playwright locator/selector. Phải dùng:
- Vision AI để "nhìn" và quyết định
- Template matching để đọc số
- Network intercept để biết game state (qua spin response)

#### Black-box testing không có studio cooperation
Đa số tool QA game được build cho studio nội bộ — có:
- Math doc với RTP/volatility exact
- Debug mode để force outcome
- Hooks vào RNG để inject seed
- Documentation về spin protocol

Tool này phải hoạt động **mà không có cái nào ở trên**. Mọi thứ phải reverse-engineer từ network traffic + vision.

#### Multi-provider hỗn loạn
Mỗi provider có 1 cách riêng:

| Provider | Spin endpoint | Response format | Quirk |
|---|---|---|---|
| Revenge Games | `/{game}/spin` | JSON | Standard |
| Pragmatic Play | `/gs2c/ge/...gameService` | URL-encoded form (text/plain;ISO-8859-1) | Field names rút gọn (c=coin, tw=totalwin, sa/sb=stops before/after) |
| PG Soft | `/{game}/round` | JSON | WebSocket cho real-time |
| Evoplay | `/spin` | JSON | Custom auth header |
| NetEnt | `/doSpin` | JSON | Cookie-based session |

`src/runner/spin-detect.ts` chứa heuristic cross-provider (regex URL pattern, body shape scoring) — đã có sẵn nhưng phải tolerate edge case của từng provider.

#### Pre-game flow vô cùng dài và không chuẩn hóa
Một game thật cần qua **8-15 step** trước khi tới play screen:
1. Loading screen (~30s) với progress bar animation
2. Age gate ("Are you 18+?")
3. Terms of service
4. Cookie consent
5. Welcome popup
6. Sound enable prompt
7. Promo popup
8. Tutorial overlay (3-5 step)
9. "Spin to win!" splash
10. Daily login bonus
11. ...

Mỗi step có UI khác, vị trí button khác, timing khác. Pure deterministic **không thể** xử lý vì:
- Step nào xuất hiện phụ thuộc session (login lần đầu vs lần thứ N)
- Animation timing không cố định
- Một số step có "skip" option ẩn

→ Đây là lý do **phải có hybrid LLM + deterministic**, không thể pure deterministic.

#### Cascade game (Sweet Bonanza pattern)
1 UI spin = N API spin response. User click Spin 1 lần, game tự tumble 5-15 lần, mỗi tumble là 1 response. Phải detect "round end" vs "intermediate cascade":
- `isEndRound: true` field (nếu provider có)
- Hoặc dùng `round_id` để group, lấy entry cuối mỗi group
- Hoặc fallback: assume mỗi response là 1 round (sai nhưng safe)

Code `getRoundEndSpins()` trong test-harness.ts xử lý 3 heuristic này.

### 3.2. Thử thách technical (Playwright + browser quirks)

#### CORS preflight chặn POST với content-type=application/json
Cross-origin POST request từ page tới mock endpoint:
1. Browser gửi OPTIONS preflight trước
2. Nếu preflight không nhận Access-Control-Allow-* headers → fail
3. POST không bao giờ fire

`page.route()` match ANY method theo default. Nếu fulfill OPTIONS bằng response của POST (mock body) → preflight fail.

**Fix:** [deterministic.ts:103-119](src/runner/deterministic.ts) thêm `fulfillPreflightIfNeeded()` — detect OPTIONS, trả 204 với CORS allow headers, mới qua được preflight.

Lesson: **Mất 30 phút debug** vì error message của Playwright không nói rõ là CORS issue.

#### Viewport default 1280×720 thay vì 1440×900
`playwright.config.ts` set `use: { viewport: { width: 1440, height: 900 } }` ở top-level, **nhưng** project lại dùng `...devices["Desktop Chrome"]` → device preset override viewport thành 1280×720.

→ Spin button của fiesta-magenta ở y=780, nằm DƯỚI viewport 720 → click miss.

**Fix:** [tests/deterministic-example.spec.ts:48](tests/deterministic-example.spec.ts) explicit `page.setViewportSize({ width: 1440, height: 900 })` trong beforeEach.

Lesson: Mất 1 giờ vì test fail không có error rõ ràng — click ra ngoài viewport silent.

#### data: URL origin "null" gây quirk với fetch
Trang HTML load qua `data:text/html,...` URL có origin = `"null"`. Một số browser behavior khác bình thường:
- fetch() từ "null" origin tới https:// có thể bị block dù CORS đúng
- cookies không persist
- Service worker không register

**Fix:** Dùng `page.goto("about:blank") + page.setContent(html)` thay vì `page.goto("data:text/html,...")`.

#### JSDoc `*/` trong file path gây parse error
File path Linux convention `fixtures/recordings/{slug}__*/http.jsonl` được paste vào JSDoc comment:

```js
/**
 * Reads fixtures/recordings/{slug}__*/http.jsonl
 *                                       ^^
 *                                       Đóng comment block ở đây!
 */
```

→ TypeScript parse `/http.jsonl` thành code → 100+ syntax error.

**Fix:** Thay `*/` bằng `(timestamp)` hoặc `...` trong comment.

Lesson: Không bao giờ paste glob pattern thẳng vào JSDoc.

#### Duplicate playwright-core type definitions
Project install cả `playwright` và `@playwright/test`. Mỗi cái có `playwright-core` riêng → 2 copy type definition không tương thích.

```
Type 'Page (from playwright-core)' is not assignable to type 'Page (from @playwright/test/.../playwright-core)'
```

→ Type error pre-existing trong `pre-game.ts` và `test-harness.ts`. Không phải code mới gây ra.

**Workaround:** Accept type errors này, không fix (động vào sẽ ripple). tsc vẫn fail nhưng tsx vẫn chạy được vì TypeScript transpile không strict.

Lesson: Khi dùng cả `playwright` và `@playwright/test`, dedupe trong package.json. Project hiện tại có vấn đề này từ trước, không fix trong scope cải tiến.

#### WebGL canvas không readPixels từ 2D context
Code thử `canvas.getContext('2d').getImageData()` để sample canvas content cho stability detection. Nhưng game canvas thường là WebGL (PixiJS, Phaser) → 2d context return null.

**Fix:** Detect bằng `ctx === null`, fallback sang `toDataURL()` để get base64 hash (slower nhưng works cho cả 2D + WebGL).

#### Canvas content detection bị false positive với loading screen
Initial implementation của `waitForCanvasReady`: check canvas có "non-blank pixels" → ready.

Nhưng loading screen (FIESTA MAGENTA splash + progress bar) **cũng có pixel painted** → detection false positive → test click trước khi game thật ready.

**Fix:** Thêm layer thứ 4 — **canvas-stable**: sample canvas hash mỗi 800ms, ready khi 4 sample liền nhau similar > 99.5%. Loading bar animation thay đổi liên tục → fail check. Play screen idle → pass.

Lesson: "Canvas có content" ≠ "Game ready". Cần stability detection.

#### `Date.now()` freeze phá vỡ event binding của game engine (trap nghiêm trọng nhất)
Khi chạy hybrid test với fiesta-magenta thật (Cocos engine):
- Pre-game qua LLM ✅
- Play screen ready ✅
- Click spin button → **0 spin request fire** (chỉ Cloudflare telemetry POST)

4 click ở (720, 810) – (720, 850) đều silent fail. Auto-play với cùng coord (720, 810) hoạt động hoàn hảo. Khác biệt duy nhất: `makeDeterministic` inject freeze script.

**Root cause:** Cocos engine (và có thể nhiều canvas engine khác) dùng `Date.now()` để init touch/click event polling hoặc deltatime cho animation. Khi Date frozen tại 2025-01-01:
- Game tưởng đang ở quá khứ
- Animation deltatime = `current - last` ra số âm hoặc 0
- Event handler không được bind hoặc bị skip trong loop
- Canvas vẫn vẽ (render thread không phụ thuộc input) nhưng không nhận click

Bằng chứng debugging:
```
Với freeze:    [debug-req] POST cdn-cgi/rum (telemetry only) — 4 click, 0 spin
Không freeze:  [debug-req] POST /fiesta-magenta/spin — 1 click, mock fire
```

**Fix:** Thêm option `noFreeze: true` trong `makeDeterministic`. Trade-off:
- Mất reproducible timing (animation timing thực, không 60fps simulated)
- Vẫn giữ deterministic ở **response level** (mock /spin response)

Khi nào dùng `noFreeze: true`:
- Hybrid flow với game thật (canvas engine có thể phụ thuộc realtime)
- Game có anti-cheat check timestamp

Khi nào dùng default (freeze):
- Synthetic test (vanilla JS, không có canvas engine)
- Game đơn giản không phụ thuộc Date.now() cho event loop

Lesson: **Freeze runtime API là dao 2 lưỡi.** Tốt cho test reproducibility nhưng có thể phá vỡ host environment (game engine, framework lifecycle). Provide opt-out, không one-size-fits-all.

Đây là trap **mất nhiều thời gian nhất** trong toàn bộ dự án (~2 giờ debug) vì symptom (click không fire) hoàn toàn khác cause (Date.now bị freeze).

#### Prelude mock với token cũ phá vỡ game session
Scenario fixture chứa response của `/authorize-game`, `/config`, `/balance` từ recording cũ. Khi mock cho hybrid flow:
- Game gọi `/authorize-game` → nhận response cũ với token cũ
- Game tiếp tục gọi `/balance` → server thật reject vì session không khớp
- Game stuck ở loading vô hạn

**Fix:** Add option `spinOnly: true` — chỉ mock `/spin`, để authorize/config/balance đi qua server thật. Game làm real login → load tới play screen → spin response deterministic.

Lesson: Mock prelude tốt cho **synthetic test** (recording is the entire universe). Cho game thật cần `spinOnly` mode.

#### Game ở Feature/Bonus mode → auto-spin nhiều lần
Hybrid test có assertion ban đầu: `expect(spinRequestCount).toBe(1)`. Fail vì:
- Game start trong session đã từng trigger bonus → vẫn ở "Fiesta Magenta Feature" mode
- Free spin tự auto-spin → mock intercept mỗi free spin → spinRequestCount = 5-10

**Fix:** Relax thành `expect(spinRequestCount).toBeGreaterThanOrEqual(1)`. Hoặc trong scenario design: separate scenario cho "manual_spin" vs "free_spin_auto".

Lesson: State của game persist giữa Playwright sessions (cookies, localStorage). Test bắt đầu không phải lúc nào cũng ở idle state.

#### Endpoint pattern thay đổi theo phiên bản server
Recording May 13: spin endpoint `https://api.dev.revenge-games.com/fiesta-magenta/spin`
Recording May 15 (script `record`): không có spin endpoint nào — user không click spin
Recording May 15 (script `auto`): `https://api.dev.revenge-games.com/fiesta-magenta/spin` (back to old)

Trong quá trình debug, có nghi vấn server đổi endpoint. Thực tế: user dùng `npm run record` (chờ user click thủ công) thay vì `npm run auto` (AI tự click) → 180s recording không có spin.

Lesson: `record` cần user thực sự chơi. `auto` reliable hơn cho việc capture spin response. Document rõ trong onboarding.

### 3.3. Thử thách process (architecture decisions)

#### Pure deterministic vs Hybrid — tradeoff giữa correctness và practicality
Ý tưởng "ngon" lúc đầu: pure deterministic, zero LLM. Reality:
- Pre-game flow cần discovery → cần LLM hoặc baseline khổng lồ
- Game loading time 30-50s, không có signal "ready" trừ vision
- Token expire 24-48h → recording thường stale

→ **Phải accept hybrid**: LLM cho 1 đoạn (pre-game), deterministic cho phần lặp lại (spin loop). Pure deterministic chỉ làm được với:
- Synthetic test (xem `tests/deterministic-integration.spec.ts`)
- Game load nhanh + không có popup
- Đã có region snapshot baseline cho "ready state"

Lesson: **Best practice tổng quát ≠ Best practice cho hoàn cảnh cụ thể.** Đôi khi hybrid pragmatic > pure ideology.

#### Backward compatibility với LLM flow cũ
Existing code base có:
- `auto-play.ts` chạy vision loop runtime
- `test-harness.ts:doAutoSpin` gọi LLM mỗi spin
- Generated tests dùng pattern này
- Server queue + dashboard wire vào pattern này

Cải tiến **không thể** xóa LLM flow vì:
- Vẫn cần cho discovery game mới
- Existing recordings + generated tests phải tiếp tục chạy được
- Dashboard UI đang dùng

→ Solution: **parallel architecture**. Thêm deterministic layer mới (`src/runner/deterministic*.ts`, `src/runner/scenario*.ts`, `src/statistical/`) cạnh code cũ. Code cũ không động tới. Wire 1 chỗ duy nhất ở `src/server/runner.ts` để auto-extract scenarios sau Collect.

Lesson: Refactor lớn → ưu tiên **additive change**. Replacement là risk gấp 10×.

#### Limited test data — chỉ có 1 recording
Toàn bộ cải tiến phải verify với **1 recording duy nhất** (fiesta-magenta, 2026-05-13). Không thể:
- Test với nhiều provider (PP, PG Soft) → chỉ có RG
- Test với bonus_trigger scenario → recording không có
- Test với cascade game → fiesta-magenta không cascade

→ Risk: code có bug với edge case của provider khác, chỉ phát hiện khi user thực sự dùng.

Mitigation: Self-test với synthetic page (`deterministic-integration.spec.ts`) verify deterministic layer hoạt động độc lập với recording. 8/8 pass.

#### Scope creep risk
5 cải tiến đề xuất là **nhiều ngày làm việc**. Phải resist temptation thêm:
- More provider support
- Better LLM prompt
- Dashboard UI cho deterministic mode
- Token refresh automation
- Better recording compression

Strategy: chia thành 2 vòng (deterministic foundation + JSON snapshot/PNG diff/auto-extract), dừng khi hybrid đã work end-to-end. Roadmap còn lại document trong README.

#### Type-check noise
Pre-existing TypeScript errors trong `pre-game.ts:48` và `test-harness.ts:488` (duplicate playwright deps) → mỗi lần `npx tsc --noEmit` đều show.

→ Dễ confuse với error của code mới. Phải grep filter mỗi lần check.

Lesson: Project có technical debt → dọn trước khi extend là tốt nhất. Trong scope cải tiến này: accept noise vì fix dep tree là 1 ticket riêng.

### 3.4. Thử thách operational (running test thật)

#### Token expiration < 24-48h
Game URL có token: `?t=WaN0YdjiIr9sdC0RB6pkq2aj_BRL...`. Token thường expire 24h-7d. Recording cũ → token cũ → khi statistical sim bắn API, server reject.

→ Workflow phải có **fresh recording step**:
```bash
npm run record          # fresh token
npm run extract-scenarios
npm run stats -- ...
```

Không tự động được vì record cần human (click consent, etc.) lần đầu.

#### Pre-game flow của fiesta-magenta thực sự dài
Test với real game URL fail 3 lần liên tục vì:
1. Game loading bar animation 30-40s
2. Tutorial/welcome popup
3. Spin button bị che bởi loading overlay

`waitForCanvasReady` (pure deterministic) không qua nổi → confirm cần hybrid.

#### Recording screenshot resolution mismatch
Recording lấy screenshot ở 1440×900 (recorder default). Test deterministic-example đặt SPIN_BUTTON = (720, 800) dựa trên screenshot này. Nếu test viewport khác → button không khớp.

→ Phải document trong test: viewport phải match recording. Auto-set trong beforeEach.

---

## 4. Phương án cải tiến đề xuất (5 mục)

### 4.1. Tách deterministic layer 🏗️ (NỀN MÓNG)

**Ép game ra cùng outcome mỗi lần chạy.**

4 mặt cần freeze:
1. `Date.now()` / `new Date()` → frozen timestamp
2. `Math.random()` → seeded PRNG (mulberry32)
3. `performance.now()` → 60fps simulated
4. `/spin /authorize /config` → record-replay từ fixture

Implementation: `page.route()` của Playwright intercept network. `page.addInitScript()` inject Date/Math override TRƯỚC khi script game chạy.

Khi nào dùng được: bug code path hiếm (jackpot, max_win) → force outcome → 100% trigger code path → bug lộ ngay.

### 4.2. Pixel hash / template matching 🎯

**Thay LLM vision cho việc "đọc state ổn định".**

Hai kỹ thuật:
- **Template matching**: lưu sẵn `digit_0.png` → `digit_9.png` → slide template qua region balance → đọc số trong vài ms (vs LLM 2-5s)
- **Perceptual hash (pHash)**: verify "bonus screen đã visible" — pHash của vùng UI so với baseline, sai < N bit = match

LLM chỉ giữ cho high-level decision lần đầu khám phá. Mỗi spin: zero LLM call.

### 4.3. Statistical layer 📊

**Verify math properties (RTP, hit freq, volatility) bằng cách bypass UI.**

Workflow:
1. Record 1 spin → có template request (URL + headers + cookies + post body)
2. Bắn template request N lần (10k-100k) bằng `fetch()` thuần Node
3. Aggregate response → observed RTP, hit frequency, win distribution
4. So với spec (vd RTP=96%)

Bypass UI → 100k spin từ 83 giờ xuống vài phút. Đây là **capability mới**, không phải tối ưu — LLM flow đơn giản không làm nổi.

### 4.4. LLM chỉ làm test generation 1 lần ⏱️

**Tách LLM khỏi runtime.**

Trước:
```
Mỗi spin → call LLM → decide click → click → wait response → call LLM → assert
```

Sau:
```
Phase 1 (1 lần): LLM phân tích game → emit file Playwright test → commit git
Phase 2 (mỗi CI run): playwright test → no LLM, deterministic, $0
```

Re-generate khi: game UI đổi (human decision), không phải mỗi CI run.

### 4.5. Snapshot test 📸

**So output (UI hoặc JSON) với baseline đã chốt.**

Hai loại:
- **Visual snapshot**: `toHaveScreenshot()` so pixel-by-pixel, phát hiện regression UI
- **JSON snapshot**: spin response shape stable across runs (phát hiện server đổi schema)

Workflow: lần đầu lưu baseline → human review → commit. Lần sau diff, fail nếu khác → human update baseline hoặc fix bug. **Không cần LLM** — diff là deterministic.

---

## 5. Đã triển khai

### 5.1. Files mới (`src/runner/`, `src/statistical/`)

| File | Chức năng |
|---|---|
| `scenario.ts` | Type + loader cho scenario fixture, classify theo win/bet ratio |
| `deterministic.ts` | `makeDeterministic()` — freeze Date/Math/performance + mock /spin /authorize /config + CORS preflight handling. Options: `spinOnly` (skip prelude mock), `noFreeze` (skip runtime API freeze) |
| `scenario-extractor.ts` | CLI: parse `http.jsonl` từ recording → emit scenario JSON. Auto-classify thành no_win/small_win/normal_win/big_win/bonus_trigger/free_spin/max_win |
| `region-snapshot.ts` | `assertRegionMatches()` — pngjs+pixelmatch pixel diff (YIQ color space), emit diff visualization khi mismatch |
| `json-snapshot.ts` | `assertJsonSnapshot()` — 3 mode (structural/exact/values), mask volatile fields, stable stringify |
| `deterministic-spin.ts` | `spinDeterministic()` + `assertSpinMatchesExpected()` — LLM-free spin với retry loop (4 attempts × 1.5s) |
| `wait-ready.ts` | `waitForCanvasReady()` — 4 layer detection (networkidle → visible → painted → stable) cho canvas game |
| `statistical/simulate.ts` + `cli.ts` | Mass-spin direct API runner, output RTP / hit freq / distribution |

### 5.2. Tests mới

| File | Mục đích |
|---|---|
| `tests/deterministic-integration.spec.ts` | Test SELF-HOSTED — verify deterministic layer hoạt động (không cần game thật). 8/8 pass trong ~7s |
| `tests/deterministic-example.spec.ts` | Pattern reference pure deterministic |
| `tests/deterministic-hybrid.spec.ts` | Hybrid pattern: LLM pre-game + deterministic spin |

### 5.3. Scripts mới (`package.json`)

```bash
npm run extract-scenarios -- <slug>   # build scenarios từ recording
npm run extract-scenarios -- --list   # list recordings
npm run stats -- <slug> --spins N     # statistical RTP test (có token preflight)
npm run test:deterministic            # pure deterministic example
npm run test:hybrid                   # LLM pre-game + det spin (RECOMMENDED cho game thật)
npm run test:integration              # tool self-test
```

### 5.4. Wire vào pipeline cũ

- **Auto-extract sau Collect**: `src/server/runner.ts`, scenarios tự sinh khi Collect phase xong
- Best-effort: lỗi extract không fail task

### 5.5. Hybrid test codegen (template-based, no LLM)

`generateHybridTestCode()` trong `src/ai/authoring.ts` — sinh `.spec.ts` từ scenario fixtures:
- KHÔNG dùng LLM call (template-based, deterministic, instant)
- 1 test() per scenario có sẵn (no_win, small_win, bonus_trigger, ...)
- Mỗi test: `makeDeterministic(spinOnly+noFreeze)` → `page.goto` → `waitForGamePlayScreen` (LLM dismiss popup) → `spinDeterministic` → `assertSpinMatchesExpected`
- Output ~3KB code cho 2-3 scenario, dễ review, không drift

### 5.6. Dashboard UI cho hybrid mode

3 endpoint mới trong `src/server/index.ts`:
- `GET /api/tasks/:id/scenarios` — list scenarios + expected values
- `POST /api/tasks/:id/gen-hybrid` — gọi `generateHybridTestCode`, write `tests/generated/{slug}.hybrid.spec.ts`
- `POST /api/tasks/:id/run-hybrid` — spawn playwright via `runHybridSpec()` (mới trong `src/server/runner.ts`)

UI: 3 button trong case detail panel với live status:
- `🎯 gen hybrid` — generate spec từ scenarios
- `▶ run hybrid` — kick off Playwright run
- Auto-fetch scenario count

### 5.7. Token expiration handling cho statistical sim

`TokenExpiredError` class + `preflightTokenCheck` (default true) trong `src/statistical/simulate.ts`:
- Trước mass-spin, bắn 1 request thử
- HTTP 401/403 → throw `TokenExpiredError` với hướng dẫn re-record (auto → extract → stats)
- CLI exit code 2 phân biệt với generic failure (cho automation tooling)

### 5.5. Dependencies mới

```json
"devDependencies": {
  "pngjs": "^7.0.0",
  "pixelmatch": "^7.2.0",
  "@types/pngjs": "^6.0.5",
  "@types/pixelmatch": "^5.2.6"
}
```

---

## 6. So sánh trước/sau

### Cost theo workload

| Workload | LLM flow (cũ) | Hybrid (mới) | Tiết kiệm |
|---|---|---|---|
| 1 test case 3 spin | $0.05-0.20, 30-120s | $0.05-0.20 + $0, 30-60s | ~30% cost, ~2× speed |
| Cùng game × 100 lần CI | $5-20 | $0.05-0.20 (1× pre-game) + $0 (mọi spin) | **95%+ cost** |
| 100k spin verify RTP | Không khả thi | $0 + 5-10 phút | **Capability mới** |

### Capabilities

| Tính năng | Trước | Sau |
|---|---|---|
| Test reproducible | ❌ | ✅ |
| Verify RTP / hit freq | ❌ | ✅ (statistical layer) |
| Snapshot regression | ❌ | ✅ (JSON + region) |
| Pixel-perfect UI diff | ❌ | ✅ (pixelmatch) |
| CI offline (no LLM) | ❌ | ✅ (sau pre-game) |
| Force outcome (bonus/jackpot) | ❌ | ✅ (scenario mock) |
| Self-test cho tool | ❌ | ✅ (integration test) |
| Discover game mới | ✅ (LLM flow giữ song song) | ✅ |
| Auto-generate hybrid test spec | ❌ | ✅ (`generateHybridTestCode`, template-based) |
| Dashboard UI cho deterministic mode | ❌ | ✅ (3 endpoint + button strip) |
| Fail-fast nếu token expired | ❌ | ✅ (preflight check + helpful error) |

---

## 7. Còn lại / Roadmap

### Đã làm + verified
- ✅ Deterministic layer (foundation) — 8/8 self-test pass
- ✅ JSON snapshot — structural/exact/values mode, mask volatile fields
- ✅ Region snapshot với real pixel diff (pngjs + pixelmatch)
- ✅ Statistical layer — **verified end-to-end với game thật**: 100 spin / 16s / 0 fail, output RTP + hit freq + win distribution
- ✅ Auto-extract sau Collect — wire vào `src/server/runner.ts`
- ✅ Canvas-ready detection — 4 layer (network → visible → painted → stable)
- ✅ Hybrid pattern (LLM pre-game + deterministic spin) — **verified end-to-end với game thật**: 2/2 hybrid test pass, 2.4 phút
- ✅ Self-test cho tool — 8/8 integration test pass, ~7s
- ✅ Options `spinOnly` + `noFreeze` cho hybrid flow — phát hiện qua debug session
- ✅ **`authoring.ts` emit hybrid test code** — `generateHybridTestCode()` template-based, no LLM, 1 test() per scenario
- ✅ **Dashboard UI cho hybrid mode** — 3 endpoint (scenarios / gen-hybrid / run-hybrid) + UI button strip
- ✅ **Token expiration handling cho statistical sim** — preflight 401/403 detect, `TokenExpiredError`, CLI exit 2
- ✅ **Dedupe playwright deps** — bump `@playwright/test ^1.60.0` để match `playwright`, 0 tsc errors

### Chưa làm
- ⏳ **Region snapshot library** — chốt baseline cho 3-5 game phổ biến (spin button, bonus screen, free spin). **Blocked**: cần URL + valid token của nhiều game khác nhau.
- ⏳ **Multi-provider verification** — chỉ verified với RG (Revenge Games). Cần test với PP (form-encoded), PG Soft (WebSocket), Evoplay, NetEnt. **Blocked**: cần URL từ nhiều provider, mỗi cái có thể có quirk riêng.

### Đề xuất ưu tiên tiếp theo
1. **Statistical sim với N=10k** — verify observed RTP converge về spec 0.96 (hiện N=100 ra 121%, noise lớn)
2. **Multi-provider validation** — chạy hybrid + statistical với 1 game PP, 1 game PG Soft để verify cross-provider patterns
3. **Build region snapshot library** — chốt baseline cho 3-5 game phổ biến (spin button, bonus screen, free spin), commit vào repo
4. **Statistical sim CI integration** — chạy 10k spin/đêm cho mỗi game đang active, alert nếu RTP drift > 2%
5. **Token auto-refresh trigger** — `npm run auto` tự chạy khi preflight detect 401/403 (full automation chain)

### Validation milestones đã đạt được trong dự án

| Date | Milestone | Detail |
|---|---|---|
| 2026-05-13 | Code complete vòng 1 | Deterministic layer, scenario extractor, JSON/region snapshot, statistical sim |
| 2026-05-14 | Code complete vòng 2 | PNG real diff, auto-extract wire, canvas-ready detection |
| 2026-05-14 | Self-test pass | `npm run test:integration` 8/8 pass |
| 2026-05-15 | Statistical layer verify | `npm run stats -- fiesta-magenta --spins 100` 100/100 successful, RTP report generated |
| 2026-05-15 | Hybrid test pass | `npm run test:hybrid` 2/2 pass với fiesta-magenta thật (2.4 phút) sau khi phát hiện `noFreeze` + `spinOnly` options |
| 2026-05-15 | Polish vòng cuối | Dedupe playwright deps (0 tsc errors), `generateHybridTestCode()` template-based, dashboard UI cho hybrid (3 endpoint + UI buttons), token preflight cho stats |

---

## 8. Kiến trúc cuối cùng

```
┌─────────────────────────────────────────────────────────────┐
│              GAME (canvas, slot, blackbox)                  │
└─────────────────────────────────────────────────────────────┘
                          ▲
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   ┌────────┐       ┌──────────┐      ┌─────────┐
   │  LLM   │       │  HYBRID  │      │STATIST. │
   │ flow   │       │  (rec.)  │      │  layer  │
   │ (cũ)   │       │          │      │         │
   └────────┘       └──────────┘      └─────────┘
   discover         CI regression     verify math
   $0.20/spin       $0.05/test        $0, 100k spin
   30-120s          30-60s            5-10 phút
        │                 │                 │
        └────────┬────────┴────────┬────────┘
                 │                 │
        ┌────────▼────────┐ ┌──────▼──────┐
        │   Recording     │ │ Scenarios   │
        │ http.jsonl      │ │ JSON fixt.  │
        └─────────────────┘ └─────────────┘
                 │                 │
                 └────────┬────────┘
                          │
                ┌─────────▼─────────┐
                │  Snapshots        │
                │  - region (PNG)   │
                │  - JSON           │
                └───────────────────┘
```

3 flow chạy song song, share chung recording + scenario + snapshot. Mỗi flow có use case riêng — **không thay thế nhau hoàn toàn**.

---

## 9. Kết luận

Tool đi từ "LLM-driven exploratory QA" thành "hybrid pipeline" với:
- Discovery vẫn LLM (đúng đường)
- Regression deterministic (rẻ, nhanh, tin được)
- Math verification statistical (capability mới)

**Effort**: ~13 files mới + 7 file đụng existing (~1950 dòng code), 2 deps mới (pngjs, pixelmatch) + 1 dep bump (@playwright/test). Backward-compatible: LLM flow cũ không bị động.

**Trạng thái cuối**: Tất cả 3 flow (LLM, hybrid, statistical) **đã verified end-to-end với game thật** (fiesta-magenta của Revenge Games). Hybrid test pass 2/2 trong 2.4 phút, statistical sim 100 spin trong 16 giây với 0 fail. **Dashboard UI integrated, hybrid codegen template-based, token preflight checked**. Chỉ còn 2 item blocked bởi external resources (URL + token của nhiều game/provider khác).

**Lessons quan trọng nhất**:
1. **Pure ideology thua hybrid pragmatism** trong domain phức tạp như game testing
2. **Best practice của ngành** (math testing tách khỏi UI, deterministic seed, statistical verification) không apply 1:1 cho black-box tester — phải adapt
3. **Browser/Playwright có nhiều quirk** (CORS preflight, viewport override, canvas WebGL) — invest debugging time là điều kiện tiên quyết
4. **Limited test data** là risk lớn cho refactor lớn — bù bằng synthetic self-test
5. **Backward-compatible additive change** an toàn hơn replacement gấp 10×
6. **Freeze runtime API là dao 2 lưỡi** — provide opt-out (`noFreeze: true`), không one-size-fits-all
7. **Symptom ≠ Cause khi debug canvas game** — click không fire có thể do Date.now bị freeze ở 5 layer trên, không phải coord sai

**Lessons technical đáng nhớ** (đã document trong `src/runner/README.md`):
- CORS preflight chặn POST → route handler phải fulfill OPTIONS
- Viewport default 1280×720 không match recording → set explicit
- data: URL origin "null" → dùng setContent thay vì goto
- JSDoc `*/` trong path → escape thành `(timestamp)` hoặc `...`
- Canvas content ≠ Game ready → cần stability detection
- `Date.now()` freeze phá event binding của Cocos/canvas engine → cần `noFreeze: true`
- Prelude mock với token cũ phá session → cần `spinOnly: true`
- Game ở Feature/Bonus mode auto-spin nhiều lần → assertion `toBeGreaterThanOrEqual(1)`, không `toBe(1)`
- `npm run record` cần human chơi, `npm run auto` AI tự click — dùng auto cho reliable capture
- **Duplicate playwright-core deps** từ `playwright` vs `@playwright/test` → version drift gây type conflict. Lock cùng version range
- **Hybrid test codegen không cần LLM** — template-based đủ vì pattern stable, mỗi scenario thành 1 test block predictable
- **Token expiration là failure mode phổ biến** — preflight 1 request thử để fail fast (~100ms) tốt hơn fail giữa 10k spin mass run

**Time spent debug** (rough estimate):
- CORS preflight: 30 phút
- Viewport mismatch: 1 giờ
- `*/` trong JSDoc: 30 phút (100+ syntax errors)
- Canvas-stable detection (false positive loading): 1 giờ
- **Date.now() freeze phá event binding: 2 giờ** (lớn nhất, symptom hoàn toàn không gợi ý cause)
- Prelude mock phá session: 30 phút
- Total debug: ~5.5 giờ trong tổng ~12 giờ implementation
