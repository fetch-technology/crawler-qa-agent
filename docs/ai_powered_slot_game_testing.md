# AI-Powered Slot Game Automation Testing

# 1. Tổng quan

Hệ thống automation dùng để test slot/reels game theo hướng:

```text
Network-first
+
Logic validation
+
UI consistency
+
AI-assisted analysis
```

Mục tiêu:

```text
- tự spin game
- capture API/WebSocket
- parse reels/balance/win
- validate logic
- validate UI
- tính RTP
- detect anomalies
- sinh report QA tự động
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

# 3. Flow automation chính

```text
1. Spin thật liên tục
2. Capture request/response
3. Parse reels, bet, win, balance
4. Check balance từng spin
5. Check UI/API mismatch
6. Chạy nhiều spin để tính RTP
7. So sánh với expected RTP
8. Sinh report pass/fail
```

---

# 4. AI cần ở bước nào?

## 4.1 Không cần AI

Các bước deterministic:

```text
- spin game
- capture API/WebSocket
- parse querystring
- tính totalBet
- validate balance
- validate RTP
- validate timeout
```

Ví dụ:

```text
balanceAfter = balanceBefore - totalBet + totalWin
```

---

## 4.2 AI hỗ trợ

AI phù hợp để:

```text
- phân tích schema game mới
- detect field mapping
- sinh adapter draft
- sinh test cases
- detect anomaly
- summarize bugs
- analyze screenshots
```

---

# 5. Có cần detect game rule không?

## 5.1 Không cần full rule cho MVP

MVP vẫn test được:

```text
- API hợp lệ
- reels hợp lệ
- balance đúng
- RTP đúng
- UI/API consistency
```

Không cần:

```text
- paytable
- paylines
- multiplier rule
- scatter/wild rule
```

---

## 5.2 Cần detect rule khi muốn test payout sâu

Muốn validate:

```text
- payout đúng
- winning line đúng
- multiplier đúng
- free spin đúng
- bonus đúng
```

thì cần:

```text
- paytable
- symbol mapping
- paylines/ways rule
- multiplier rule
- free spin rule
```

---

# 6. AI Game Analyzer

## Input

```text
- 100–500 spin samples
- raw request/response
- screenshots
- paytable/rules page
- history logs
```

## Output

```json
{
  "gameCode": "vswayscyhecity",
  "transport": "http_querystring",
  "reelField": "s",
  "widthField": "sw",
  "heightField": "sh",
  "winField": "w",
  "totalWinField": "tw",
  "balanceField": "balance",
  "betFormula": "c * l",
  "features": [
    "base_spin",
    "free_spin",
    "bonus_possible"
  ]
}
```

---

# 7. Test types

## 7.1 Spin-by-spin validation

Mỗi spin:

```text
- request hợp lệ
- response parse được
- reels length đúng
- balance đúng
- symbol hợp lệ
- UI/API sync đúng
```

Ví dụ:

```text
balanceAfter
=
balanceBefore - bet + win
```

---

## 7.2 Long-run statistical validation

Chạy:

```text
1k
10k
100k
1M spins
```

Sau đó tính:

```text
- RTP
- hit rate
- volatility
- feature frequency
- symbol distribution
```

Ví dụ:

```text
100,000 spins

Total Bet = 100,000
Total Win = 96,200

RTP = 96.2%
```

---

# 8. UI testing

## 8.1 UI State

Check:

```text
- spin button disabled khi đang quay
- balance text đúng
- win text đúng
- popup đúng
- free spin counter đúng
```

---

## 8.2 Visual Validation

Check:

```text
- black screen
- missing texture
- symbol overlap
- animation freeze
- popup broken
```

---

## 8.3 API ↔ UI consistency

So sánh:

```text
API balance === UI balance
API win === UI win
API reels === UI reels
```

---

# 9. Game Adapter

```ts
interface GameAdapter {
  gameCode: string;

  detectSpinRequest(raw: string): boolean;

  detectSpinResponse(raw: string): boolean;

  parseRequest(raw: string): SpinRequest;

  parseResponse(raw: string): SpinResponse;

  decodeReels(
    symbols: string,
    width: number,
    height: number
  ): string[][];

  validateSpin(
    input: SpinValidationInput
  ): ValidationError[];

  generateTestCases(): TestCase[];
}
```

---

# 10. Database Design

## test_runs

```sql
id
game_code
status
total_spins
started_at
ended_at
```

## spin_results

```sql
id
test_run_id
bet
win
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
spin_result_id
error_type
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
rtp
hit_rate
volatility
max_win
created_at
```

---

# 11. Dashboard

```text
- Test Runs
- RTP Report
- Spin Results
- Validation Errors
- UI/API Mismatch
- Screenshots/Videos
```

---

# 12. Stack đề xuất

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

# 13. Roadmap MVP

## Phase 1

```text
- Playwright
- capture API/WebSocket
- save raw logs
```

## Phase 2

```text
- parse querystring
- decode reels
- calculate totalBet
```

## Phase 3

```text
- RTP report
- balance validation
- hit rate
```

## Phase 4

```text
- UI validation
- screenshot compare
```

## Phase 5

```text
- AI game analyzer
- AI bug summary
- AI testcase generation
```

---

# 14. Kết luận

## MVP

Không cần AI để validate lõi:

```text
- balance
- RTP
- reels
- API
```

## AI nên dùng để:

```text
- hiểu game mới
- phân tích schema
- detect rule
- sinh testcase
- summarize bug
- analyze screenshot
```

## Kiến trúc đúng

```text
Deterministic core
+
AI-assisted discovery and reporting
```
