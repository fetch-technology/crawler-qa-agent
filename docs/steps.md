# Slot Game UI Automation Testing – Detailed Steps

## Goal

Test slot game chỉ từ URL bằng automation + AI.

Mục tiêu chính:

- Mở game tự động
- Detect UI
- Click được các button
- Capture network
- Parse dữ liệu game
- Verify UI/API/logic
- Sinh testcases
- Xuất report

---

# Overall Flow

```text
Game URL
  ↓
Step 1: Crawl game
  ↓
Step 2: Detect UI elements
  ↓
Step 3: Smoke UI test
  ↓
Step 4: Capture network
  ↓
Step 5: AI detect spin API
  ↓
Step 6: Parse game data
  ↓
Step 7: Verify UI/API/logic
  ↓
Step 8: Run massive spins
  ↓
Step 9: Statistical verification
  ↓
Step 10: Generate report
```

---

# Step 1 — Crawl Game From URL

## Mục tiêu

Mở game từ URL và hiểu cấu trúc ban đầu.

Cần detect:

- Game load được không
- Game nằm trong page chính hay iframe
- Game dùng DOM, Canvas, WebGL hay Unity
- Có lỗi console không
- Assets có lỗi không
- Provider là ai: JILI, PGSoft, Pragmatic, v.v.

---

## Cách implement

Dùng Playwright:

```ts
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

const page = await browser.newPage({
  viewport: {
    width: 1920,
    height: 1080,
  },
});

await page.goto(gameUrl, {
  waitUntil: "networkidle",
  timeout: 60000,
});
```

---

## Capture console error

```ts
page.on("console", msg => {
  if (msg.type() === "error") {
    console.log("Console error:", msg.text());
  }
});
```

---

## Detect iframe

```ts
const frames = page.frames();

for (const frame of frames) {
  console.log(frame.url());
}
```

---

## Detect canvas

```ts
const canvasCount = await page.locator("canvas").count();

if (canvasCount > 0) {
  console.log("Canvas/WebGL game detected");
}
```

---

## AI tham gia thế nào?

AI có thể phân tích screenshot ban đầu:

Input cho AI:

```text
Screenshot game lobby/game screen
DOM summary
iframe URLs
console logs
network domains
```

AI output:

```json
{
  "gameLoaded": true,
  "possibleProvider": "JILI",
  "renderingType": "Canvas",
  "detectedScreens": ["loading", "main_game"],
  "risk": ["iframe based", "canvas based"]
}
```

---

## Kết quả của step này

Output nên lưu:

```json
{
  "gameUrl": "...",
  "loaded": true,
  "iframeCount": 2,
  "canvasCount": 1,
  "providerGuess": "JILI",
  "consoleErrors": [],
  "screenshot": "initial.png"
}
```

---

# Step 2 — Detect UI Elements

## Mục tiêu

Tìm các thành phần UI quan trọng:

- Spin button
- Auto spin
- Turbo
- Bet plus/minus
- Buy bonus
- History
- Menu
- Close popup
- Confirm button

---

## Vì sao khó?

Slot game thường dùng:

```text
Canvas / WebGL / PixiJS / Phaser / Unity
```

Nên nhiều khi không có:

```html
<button id="spin">
```

Vì vậy không thể chỉ dùng selector.

---

## Cách implement chuẩn

Dùng chiến lược 4 lớp:

```text
1. DOM selector
2. Image template matching
3. OCR
4. AI Vision
```

---

## 2.1 Try DOM selector trước

```ts
const possibleSelectors = [
  "#spin",
  ".spin-button",
  "[data-testid='spin']",
  "button:has-text('Spin')",
];

for (const selector of possibleSelectors) {
  const count = await page.locator(selector).count();

  if (count > 0) {
    console.log("Found spin button:", selector);
  }
}
```

---

## 2.2 Nếu không có DOM → dùng screenshot

```ts
await page.screenshot({
  path: "screenshots/main-screen.png",
  fullPage: true,
});
```

---

## 2.3 Dùng OpenCV template matching

Chuẩn bị template:

```text
templates/spin_button.png
templates/buy_bonus.png
templates/history.png
```

Python/OpenCV:

```python
import cv2
import numpy as np

screen = cv2.imread("main-screen.png")
template = cv2.imread("spin_button.png")

result = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
_, max_val, _, max_loc = cv2.minMaxLoc(result)

if max_val > 0.8:
    x, y = max_loc
    print("Spin button found:", x, y)
```

---

## 2.4 Dùng OCR

Dùng OCR để tìm text:

```text
SPIN
AUTO
BUY
HISTORY
FREE SPIN
```

Output:

```json
{
  "text": "SPIN",
  "bbox": {
    "x": 1620,
    "y": 820,
    "width": 180,
    "height": 120
  }
}
```

---

## 2.5 Dùng AI Vision

Gửi screenshot cho AI và hỏi:

```text
Find the spin button, buy bonus button, history button.
Return coordinates only.
```

Expected output:

```json
{
  "spinButton": {
    "x": 1660,
    "y": 860
  },
  "buyBonusButton": {
    "x": 1450,
    "y": 870
  },
  "historyButton": {
    "x": 1800,
    "y": 100
  }
}
```

---

## AI tham gia thế nào?

AI rất hữu ích ở step này.

AI dùng để:

- Nhận diện button trong canvas
- Nhận diện popup
- Nhận diện trạng thái màn hình
- Gợi ý element nào là spin
- Gợi ý tọa độ click

Nhưng sau khi AI detect, hệ thống nên cache lại tọa độ:

```json
{
  "spinButton": {
    "strategy": "ai_vision",
    "x": 1660,
    "y": 860,
    "confidence": 0.91
  }
}
```

---

## Kết quả của step này

Output:

```json
{
  "uiElements": {
    "spin": {
      "type": "coordinate",
      "x": 1660,
      "y": 860
    },
    "buyBonus": {
      "type": "coordinate",
      "x": 1450,
      "y": 870
    },
    "history": {
      "type": "coordinate",
      "x": 1800,
      "y": 100
    }
  }
}
```

---

# Step 3 — Smoke UI Test

## Mục tiêu

Kiểm tra game có thao tác cơ bản được không.

Test cơ bản:

- Click spin được không
- Game có phản hồi không
- Reels có chuyển động không
- Spin kết thúc không
- Balance/win area có update không
- Không crash, không black screen

---

## Cách implement

Click bằng coordinate:

```ts
await page.mouse.click(1660, 860);
```

Hoặc nếu có selector:

```ts
await page.locator("#spin").click();
```

---

## Detect animation started

Cách đơn giản:

```ts
const before = await page.screenshot();
await page.mouse.click(1660, 860);
await page.waitForTimeout(500);
const after = await page.screenshot();

// so sánh before/after bằng pixel diff
```

Nếu pixel diff lớn:

```text
spin animation likely started
```

---

## Detect spin ended

Có thể dùng:

```text
1. Wait network spin response
2. Wait UI stable
3. Wait spin button enabled
4. Wait screenshot không thay đổi nhiều
```

Pseudo:

```ts
await waitUntilScreenStable(page, 2000);
```

---

## Screen stable logic

```ts
async function waitUntilScreenStable(page) {
  let previous = await page.screenshot();

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    const current = await page.screenshot();

    const diff = compareImages(previous, current);

    if (diff < 0.01) {
      return true;
    }

    previous = current;
  }

  return false;
}
```

---

## AI tham gia thế nào?

AI có thể xem screenshot sau khi click và trả lời:

```json
{
  "state": "spinning",
  "visibleIssues": [],
  "blackScreen": false,
  "popup": null
}
```

Hoặc sau khi spin xong:

```json
{
  "state": "spin_finished",
  "winDisplayed": true,
  "balanceVisible": true
}
```

---

## Verify ở step này

Có thể verify:

```text
PASS: game loaded
PASS: spin clickable
PASS: animation started
PASS: spin finished
FAIL: screen frozen
FAIL: black screen
FAIL: error popup shown
```

---

# Step 4 — Capture Network

## Mục tiêu

Bắt toàn bộ request/response để tìm API game.

Cần capture:

- Spin API
- Wallet/balance API
- History API
- Buy bonus API
- Free spin API
- WebSocket message

---

## Cách implement với Playwright

```ts
page.on("request", request => {
  console.log("REQ:", request.method(), request.url());
});

page.on("response", async response => {
  const url = response.url();

  if (url.includes("spin") || url.includes("game")) {
    const body = await response.text().catch(() => null);

    console.log("RES:", url, body);
  }
});
```

---

## Capture WebSocket

```ts
page.on("websocket", ws => {
  console.log("WebSocket opened:", ws.url());

  ws.on("framereceived", event => {
    console.log("WS received:", event.payload);
  });

  ws.on("framesent", event => {
    console.log("WS sent:", event.payload);
  });
});
```

---

## Lưu raw log

Nên lưu dạng:

```json
{
  "round": 1,
  "requests": [],
  "responses": [],
  "websocketFrames": [],
  "screenshots": []
}
```

---

## AI tham gia thế nào?

AI phân tích network logs và gợi ý:

```json
{
  "candidateSpinApis": [
    {
      "url": "/api/spin",
      "confidence": 0.92,
      "reason": "called immediately after spin click and response contains win/balance"
    }
  ],
  "candidateHistoryApi": "/api/history",
  "candidateBuyBonusApi": "/api/buy-feature"
}
```

AI có thể giúp map field:

```json
{
  "betField": "cs",
  "winField": "tw",
  "balanceField": "bl",
  "reelField": "rl"
}
```

Ví dụ nhiều provider dùng field rất ngắn:

```json
{
  "cs": 0.2,
  "ml": 5,
  "tw": 12.4,
  "bl": 998.6,
  "rl": [1, 3, 5, 2, 2]
}
```

AI sẽ giúp đoán:

```text
cs = coin size
ml = multiplier/level
tw = total win
bl = balance
rl = reels
```

---

# Step 5 — AI Detect Spin API

## Mục tiêu

Từ nhiều request, chọn đúng API nào là spin.

---

## Heuristic không cần AI

Một request có khả năng là spin API nếu:

- Xảy ra ngay sau click spin
- Có request body chứa bet/line/coin
- Response chứa win/reels/balance
- Mỗi spin gọi 1 lần
- Round id thay đổi mỗi lần

---

## Implement scoring

```ts
function scoreCandidate(req, res) {
  let score = 0;

  if (req.timeAfterClick < 1000) score += 2;
  if (res.body.includes("win")) score += 2;
  if (res.body.includes("balance")) score += 2;
  if (res.body.includes("reel")) score += 2;
  if (req.method === "POST") score += 1;

  return score;
}
```

---

## AI tham gia thế nào?

AI nhận danh sách request/response rút gọn:

```json
[
  {
    "url": "/game/spin",
    "method": "POST",
    "requestBody": "...",
    "responseBody": "..."
  },
  {
    "url": "/wallet/balance",
    "method": "GET",
    "responseBody": "..."
  }
]
```

AI trả về:

```json
{
  "spinApi": "/game/spin",
  "confidence": 0.95,
  "fields": {
    "bet": "bet",
    "win": "winAmount",
    "balance": "balanceAfter",
    "roundId": "roundId",
    "reels": "matrix"
  }
}
```

---

## Best practice

Không tin AI 100%.

Nên confirm bằng test:

```text
Click spin 5 lần
API candidate phải xuất hiện đúng 5 lần
Mỗi response phải có roundId khác nhau
Balance phải thay đổi hợp lý
```

---

# Step 6 — Parser Game Data

## Mục tiêu

Chuyển raw response thành format chuẩn.

Raw response mỗi provider khác nhau, nhưng hệ thống cần chuẩn hóa thành:

```json
{
  "roundId": "abc123",
  "bet": 10,
  "win": 25,
  "balanceBefore": 1000,
  "balanceAfter": 1015,
  "reels": [],
  "state": "NORMAL"
}
```

---

## Implement base parser

```ts
interface NormalizedSpinResult {
  roundId: string;
  bet: number;
  win: number;
  balanceBefore?: number;
  balanceAfter: number;
  reels?: any[];
  state: "NORMAL" | "FREE_SPIN" | "BONUS" | "GAMBLE";
  raw: any;
}
```

---

## Provider parser

```ts
interface ProviderParser {
  canParse(payload: any): boolean;
  parseSpin(payload: any): NormalizedSpinResult;
  parseHistory?(payload: any): any;
  parseBuyBonus?(payload: any): any;
}
```

---

## Ví dụ JILI parser

```ts
class JiliParser implements ProviderParser {
  canParse(payload: any) {
    return payload?.data?.roundId && payload?.data?.balance !== undefined;
  }

  parseSpin(payload: any): NormalizedSpinResult {
    return {
      roundId: payload.data.roundId,
      bet: payload.data.bet,
      win: payload.data.win,
      balanceAfter: payload.data.balance,
      reels: payload.data.reels,
      state: payload.data.freeSpin ? "FREE_SPIN" : "NORMAL",
      raw: payload,
    };
  }
}
```

---

## AI tham gia thế nào?

AI hỗ trợ:

- Mapping field
- Sinh parser draft
- Giải thích field lạ
- Nhận diện state từ response
- Suggest provider adapter

Ví dụ prompt:

```text
Given this spin response, map fields to:
roundId, bet, win, balanceAfter, reels, freeSpinCount.
Return JSON mapping.
```

AI output:

```json
{
  "roundId": "data.rid",
  "bet": "data.cs * data.ml",
  "win": "data.tw",
  "balanceAfter": "data.bl",
  "reels": "data.rl",
  "freeSpinCount": "data.fs.count"
}
```

---

## Best practice

AI sinh parser được, nhưng parser phải có unit test.

Ví dụ:

```ts
expect(result.win).toBe(25);
expect(result.balanceAfter).toBe(1015);
expect(result.state).toBe("NORMAL");
```

---

# Step 7 — UI/API/Logic Verification

Đây là bước test thật sự.

---

# 7.1 UI Verification

## Verify gì?

- Spin button visible
- Spin button clickable
- Spin button disabled during spin
- Win amount hiển thị đúng
- Balance hiển thị đúng
- Free spin counter đúng
- Popup đúng
- History hiển thị đúng

---

## Cách implement

### Screenshot before/after

```ts
const before = await page.screenshot();

await clickSpin();

const during = await page.screenshot();

await waitSpinEnd();

const after = await page.screenshot();
```

---

### OCR balance/win

```text
OCR vùng balance
OCR vùng win
```

Output:

```json
{
  "uiBalance": 1015,
  "uiWin": 25
}
```

So sánh với API:

```ts
expect(uiBalance).toBe(api.balanceAfter);
expect(uiWin).toBe(api.win);
```

---

### AI tham gia UI verify thế nào?

AI có thể xác định:

```json
{
  "screenState": "main_game",
  "popupVisible": false,
  "winAmountVisible": true,
  "freeSpinBannerVisible": false,
  "visualIssues": []
}
```

Nhưng với tiền/balance, nên dùng OCR + API để verify deterministic.

---

# 7.2 API Verification

## Verify gì?

- Response status 200
- Có roundId
- roundId unique
- Có bet/win/balance
- Không duplicate transaction
- Response schema đúng

---

## Implement

```ts
expect(response.status()).toBe(200);
expect(result.roundId).toBeDefined();
expect(result.balanceAfter).toBeGreaterThanOrEqual(0);
```

---

# 7.3 Financial Verification

## Công thức

```text
expectedBalance = beforeBalance - bet + win
```

Với free spin:

```text
expectedBalance = beforeBalance + win
```

Với buy bonus:

```text
expectedBalance = beforeBalance - buyCost + bonusWin
```

---

## Implement

```ts
function verifyBalance(before, bet, win, after) {
  const expected = before - bet + win;
  return Math.abs(expected - after) < 0.0001;
}
```

---

## AI tham gia?

Không nên để AI verify tài chính.

AI chỉ giải thích lỗi:

```text
Balance mismatch because API deducted buy bonus cost twice.
```

---

# 7.4 Game Logic Verification

## Verify gì?

- 3 scatter trigger free spin
- Wild substitute đúng
- Multiplier apply đúng
- Free spin count giảm đúng
- Retrigger cộng thêm lượt
- Bonus kết thúc đúng state

---

## Implement bằng rule engine

```ts
interface Rule {
  name: string;
  check(result: NormalizedSpinResult, context: GameContext): RuleResult;
}
```

Ví dụ:

```ts
class FreeSpinNoDeductRule implements Rule {
  name = "free_spin_no_balance_deduct";

  check(result, context) {
    if (result.state !== "FREE_SPIN") return { pass: true };

    const expected = context.previousBalance + result.win;

    return {
      pass: expected === result.balanceAfter,
      expected,
      actual: result.balanceAfter,
    };
  }
}
```

---

# Step 8 — Run Massive Spins

## Mục tiêu

Chạy nhiều spin để thu thập thống kê.

Số lượng:

```text
Smoke: 10 spins
Regression: 1,000 spins
Statistical: 10,000–100,000 spins
RTP simulation: 1,000,000 spins nếu có môi trường test
```

---

## Cách implement

Không nên chạy bằng UI nếu cần số lượng cực lớn.

Có 2 mode:

```text
UI mode: dùng browser click thật
API mode: gọi spin API trực tiếp
```

---

## UI mode

Dùng để verify:

- animation
- UI state
- UI/API mismatch

Nhược điểm:

- chậm
- dễ flaky
- tốn resource

---

## API mode

Dùng để verify:

- RTP
- hit rate
- volatility
- logic
- balance

Nhanh hơn rất nhiều.

---

## Best practice

```text
10–100 spins bằng UI
10,000+ spins bằng API
```

---

## AI tham gia thế nào?

AI không cần tham gia từng spin.

AI tham gia sau khi có data:

- Detect anomaly
- Summarize failures
- Group lỗi
- Explain trend
- Suggest missing tests

---

# Step 9 — Statistical Verification

## Mục tiêu

Tính toán:

- RTP
- Hit rate
- Volatility
- Bonus frequency
- Free spin frequency
- Max win distribution

---

## RTP

```ts
const rtp = totalWin / totalBet;
```

Ví dụ:

```text
totalBet = 1,000,000
totalWin = 962,000
RTP = 96.2%
```

---

## Hit rate

```ts
const hitRate = winningSpins / totalSpins;
```

---

## Bonus frequency

```ts
const bonusFrequency = bonusTriggered / totalSpins;
```

---

## Verify range

```ts
expect(rtp).toBeGreaterThan(0.94);
expect(rtp).toBeLessThan(0.98);
```

---

## AI tham gia thế nào?

AI có thể đọc report thống kê và kết luận:

```text
RTP is lower than expected.
Most failures come from buy bonus mode.
Free spin frequency is abnormal.
```

Nhưng số liệu phải do code tính.

---

# Step 10 — Generate Report

## Mục tiêu

Xuất report cho QA/dev/business.

Report nên có:

- Summary
- Pass/fail
- Failed test cases
- Screenshots
- Network logs
- RTP statistics
- UI/API mismatch
- Error details
- AI explanation

---

## Report structure

```json
{
  "game": "Candy Blitz",
  "url": "...",
  "totalTests": 120,
  "passed": 115,
  "failed": 5,
  "rtp": 0.961,
  "hitRate": 0.23,
  "failures": []
}
```

---

## AI tham gia thế nào?

AI rất hữu ích ở report:

Input:

```text
raw failures
logs
screenshots summary
network mismatch
```

AI output:

```text
Root cause summary:
Buy bonus deduct mismatch happens only when balance is below 500.
Possible duplicated transaction.
```

---

# Feature-specific Handling

---

# Buy Free Spin

## Test cases

- Buy bonus button visible
- Popup opens
- Price displayed correctly
- Confirm works
- Balance deduct exact cost
- Bonus state starts
- Bonus result recorded in history

## Implementation

```text
Click Buy Bonus
→ Read price by OCR/API
→ Click confirm
→ Capture response
→ Verify balance
→ Verify state = BONUS/FREE_SPIN
```

## AI role

- Detect buy button
- Detect popup
- Read visible price
- Generate missing testcases

---

# Special Spin

## Test cases

- Special spin selectable
- Request mode correct
- Cost correct
- Reward logic correct
- UI state correct

## Implementation

```text
Click special spin
→ Capture request
→ Verify request.mode = special
→ Verify cost/win/balance
```

## AI role

- Identify special spin UI
- Classify mode from screen
- Explain failures

---

# History

## Test cases

- History button visible
- History opens
- Last round appears
- Round id matches API
- Win/bet/balance match
- Replay works
- History persists after reload

## Implementation

```text
After spin
→ Save roundId
→ Open history
→ OCR/API read history row
→ Compare with spin result
```

## AI role

- Detect history popup
- Extract visible table if OCR fails
- Summarize mismatch

---

# Free Spin

## Test cases

- Free spin triggers with scatter
- Counter appears
- Counter decreases
- No bet deducted
- Retrigger adds count
- End returns to normal mode

## Implementation

```text
When API state = FREE_SPIN
→ Check UI banner
→ OCR counter
→ Verify no balance deduct
```

## AI role

- Detect free spin banner
- Detect counter area
- Validate visible state

---

# Final Best Practice

## AI is assistant, not final judge

Use AI for:

```text
Discovery
UI detection
Field mapping
Testcase generation
Failure explanation
Report summary
```

Do not use AI for:

```text
Balance calculation
RTP calculation
Final financial validation
Deterministic game rule validation
```

---

# Recommended Architecture

```text
Playwright Runner
  ↓
Screenshot Collector
  ↓
Network Recorder
  ↓
AI UI Detector
  ↓
Protocol Parser
  ↓
Rule Engine
  ↓
Statistical Engine
  ↓
Report Generator
```

---

# Practical Implementation Priority

## Phase 1 — MVP

Build:

- Open URL
- Detect spin button
- Click 10 spins
- Capture network
- Parse balance/win/bet
- Verify balance
- Export report

## Phase 2 — Feature Testing

Add:

- Buy bonus
- Free spin
- History
- Auto spin
- Turbo

## Phase 3 — AI Support

Add:

- AI screenshot detection
- AI API mapping
- AI testcase generation
- AI report explanation

## Phase 4 — Scale

Add:

- Provider adapters
- Massive spin API mode
- RTP dashboard
- CI/CD
- Parallel workers