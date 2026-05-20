# Slot Game Automation Testing Architecture

# 1. Mục tiêu hệ thống

Tool dùng để test:

```text
1. Logic game
2. RTP / thống kê
3. Balance
4. API/WebSocket response
5. UI hiển thị
6. API ↔ UI consistency
7. Bug report tự động bằng AI
```

---

# 2. Kiến trúc tổng thể

```text
                    ┌────────────────────┐
                    │ Test Scheduler      │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Playwright Bot      │
                    └─────────┬──────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
┌────────────────────┐                    ┌────────────────────┐
│ Network Capture    │                    │ UI Capture          │
│ API/WebSocket      │                    │ Screenshot/DOM      │
└─────────┬──────────┘                    └─────────┬──────────┘
          ▼                                           ▼
┌────────────────────┐                    ┌────────────────────┐
│ Spin Parser         │                    │ UI Validator        │
│ QueryString → JSON  │                    │ Visual/UI check     │
└─────────┬──────────┘                    └─────────┬──────────┘
          ▼                                           ▼
┌────────────────────┐                    ┌────────────────────┐
│ Game Adapter        │                    │ AI Vision Analyzer  │
│ per game logic      │                    │ optional            │
└─────────┬──────────┘                    └─────────┬──────────┘
          ▼                                           ▼
┌────────────────────┐                    ┌────────────────────┐
│ Rule Engine         │                    │ UI/API Consistency  │
│ payout/balance      │                    │ compare result      │
└─────────┬──────────┘                    └─────────┬──────────┘
          └─────────────────────┬─────────────────────┘
                                ▼
                       ┌────────────────────┐
                       │ Storage             │
                       │ PostgreSQL / S3     │
                       └─────────┬──────────┘
                                 ▼
                       ┌────────────────────┐
                       │ Dashboard / Report  │
                       └────────────────────┘
```

---

# 3. Modules chi tiết

## 3.1 Test Scheduler

Nhiệm vụ:

```text
- tạo test run
- cấu hình số spin
- cấu hình bet
- chọn game
- chạy nhiều worker
- retry khi lỗi
```

Ví dụ config:

```json
{
  "gameCode": "vswayscyhecity",
  "url": "https://game-url.com",
  "totalSpins": 100000,
  "betPerLine": 0.04,
  "lines": 25,
  "viewport": {
    "width": 1440,
    "height": 900
  },
  "mode": "demo"
}
```

---

## 3.2 Playwright Bot

Nhiệm vụ:

```text
- mở game URL
- đợi game load
- click nút Spin
- đổi bet nếu cần
- chạy auto spin
- capture request/response
- capture screenshot khi lỗi
```

Pseudo flow:

```ts
for (let i = 0; i < totalSpins; i++) {
  await clickSpin();
  const spinResult = await waitForSpinResponse();
  await saveSpinResult(spinResult);
}
```

---

## 3.3 Network Capture

Nhiệm vụ:

```text
- bắt request action=doSpin
- bắt response chứa kết quả reels
- bắt WebSocket message nếu game dùng socket
- lưu raw request + raw response
```

Request mẫu:

```text
action=doSpin&symbol=vswayscyhecity&c=0.04&l=25&sInfo=n&bl=0&index=7&counter=2&repeat=0&mgckey=...
```

Response mẫu:

```text
tw=0.32&rs_iw=0.32&reel_set=0&na=c&rs_t=1&bl=0&sa=eaihh&sb=igdia&rs_win=0.00&sh=3&st=rect&c=0.04&sw=5&sver=6&ntp=0&l=25&s=eaihhbeffbafgah&w=0.00&balance=999986.47
```

Không lưu nguyên `mgckey`, chỉ lưu masked token.

---

## 3.4 Spin Parser

Parser chuyển querystring thành object chuẩn.

Input:

```text
s=eaihhbeffbafgah&sw=5&sh=3&c=0.04&l=25&w=0.00&tw=0.32
```

Output:

```json
{
  "gameCode": "vswayscyhecity",
  "betPerLine": 0.04,
  "lines": 25,
  "totalBet": 1,
  "width": 5,
  "height": 3,
  "symbols": "eaihhbeffbafgah",
  "reels": [
    ["e", "a", "i"],
    ["h", "h", "b"],
    ["e", "f", "f"],
    ["b", "a", "f"],
    ["g", "a", "h"]
  ],
  "win": 0,
  "totalWin": 0.32,
  "balance": 999986.47
}
```

---

# 4. Logic Test cần kiểm tra

## 4.1 Bet validation

```text
totalBet = c * l
```

Ví dụ:

```text
0.04 * 25 = 1.00
```

Check:

```text
- c hợp lệ không
- l hợp lệ không
- totalBet đúng không
- balance có bị trừ đúng không
```

---

## 4.2 Reels validation

Check field `s`.

```text
sw = 5
sh = 3
s length = 15
```

Điều kiện đúng:

```text
s.length === sw * sh
```

Check thêm:

```text
- symbol có hợp lệ không
- có symbol lạ không
- matrix parse đúng không
```

---

## 4.3 Win validation

Tool tự tính:

```text
calculatedWin = ruleEngine.calculate(reels, bet, paylines)
```

So sánh:

```text
calculatedWin === serverWin
```

Nếu lệch:

```text
PAYOUT_MISMATCH
```

---

## 4.4 Balance validation

Công thức:

```text
expectedBalance = balanceBefore - totalBet + totalWin
```

Check:

```text
expectedBalance === balanceAfter
```

Nếu đang free spin:

```text
expectedBalance = balanceBefore + totalWin
```

---

## 4.5 RTP validation

Sau nhiều spin:

```text
RTP = totalWin / totalBet
```

Metrics:

```text
- total spins
- total bet
- total win
- RTP
- hit rate
- max win
- average win
- volatility
```

---

## 4.6 Feature validation

Check:

```text
- free spin trigger
- bonus trigger
- multiplier
- scatter
- wild
- retrigger
- bonus total win
```

---

# 5. UI Test cần kiểm tra

## 5.1 DOM/UI State

Check:

```text
- nút Spin click được
- nút Spin disabled khi reels đang quay
- balance text update đúng
- win text update đúng
- bet text đúng
- popup bonus hiện đúng
- free spin counter đúng
```

---

## 5.2 Screenshot / Visual Test

Check lỗi:

```text
- black screen
- missing image
- symbol bị lệch
- popup vỡ layout
- reel đứng hình
- animation freeze
- text overlap
```

---

## 5.3 API ↔ UI Consistency

So sánh:

```text
API balance === UI balance
API win === UI win
API reels === UI rendered reels
```

Nếu khác:

```text
UI_API_MISMATCH
```

---

# 6. Game Adapter

Mỗi game có rule khác nhau nên cần adapter.

```ts
interface GameAdapter {
  gameCode: string;

  parseRequest(raw: string): SpinRequest;

  parseResponse(raw: string): SpinResponse;

  decodeReels(symbols: string, width: number, height: number): string[][];

  calculateWin(input: CalculateWinInput): number;

  validateFeature(input: SpinResponse): ValidationError[];
}
```

---

# 7. Database Design

## test_runs

```sql
id
game_code
url
status
total_spins
completed_spins
bet_per_line
lines
started_at
ended_at
created_at
```

## spin_results

```sql
id
test_run_id
round_index
counter
game_code
bet_per_line
lines
total_bet
server_win
total_win
balance_before
balance_after
symbols
reels_json
raw_request
raw_response
created_at
```

## validation_errors

```sql
id
test_run_id
spin_result_id
error_type
severity
expected_value
actual_value
message
screenshot_url
created_at
```

## stat_reports

```sql
id
test_run_id
total_spins
total_bet
total_win
rtp
hit_rate
max_win
average_win
volatility
created_at
```

---

# 8. Dashboard

Dashboard nên có:

```text
1. Test Runs
2. Spin Results
3. Validation Errors
4. RTP Report
5. UI/API Mismatch
6. Screenshots/Videos
```

---

# 9. AI áp dụng ở đâu?

```text
1. Bug summary
2. Phân loại lỗi
3. Sinh bug report
4. Phân tích pattern bất thường
5. Vision check screenshot
```

---

# 10. Stack khuyên dùng

```text
Language: TypeScript
Automation: Playwright
Backend: NestJS
Queue: Redis + BullMQ
Database: PostgreSQL
ORM: Prisma
Dashboard: Next.js
Storage: S3 / MinIO
AI: OpenAI API
```

---

# 11. Roadmap build MVP

## Phase 1 — Network Capture

```text
- Playwright mở game
- click spin
- capture doSpin request
- capture response
- lưu raw request/response
```

## Phase 2 — Parser

```text
- parse querystring
- decode s thành reels
- tính totalBet
- lưu spin_results
```

## Phase 3 — RTP Report

```text
- chạy 1k / 10k / 100k spin
- tính total bet
- total win
- RTP
- hit rate
```

## Phase 4 — Logic Validation

```text
- check balance
- check reels length
- check symbol hợp lệ
- check payout nếu có paytable
```

## Phase 5 — UI Validation

```text
- check spin button
- check balance text
- check win text
- screenshot khi lỗi
```

## Phase 6 — AI Analyzer

```text
- tự tóm tắt bug
- sinh report
- phân loại lỗi
```
