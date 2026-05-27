# Slot Game Automation Testing – Best Practice Architecture

## Overview

Mục tiêu:

Tự động test slot game chỉ từ URL game, bao gồm:

- UI testing
- API testing
- Financial verification
- Game logic verification
- RTP/statistical verification
- Feature testing
- Report generation

AI chỉ đóng vai trò hỗ trợ phân tích, KHÔNG thay thế deterministic validation.

---

# High Level Architecture

```text
Game URL
   ↓
Automation Engine (Playwright)
   ↓
Network Interceptor
   ↓
Provider Detector
   ↓
Protocol Parser
   ↓
Rule Engine
   ↓
Statistical Engine
   ↓
AI Analysis Layer
   ↓
HTML/PDF Report
```

---

# Testing Flow

## Step 1 — Crawl Game From URL

Mục tiêu:

- Open game
- Wait assets load
- Detect iframe
- Detect canvas/webgl
- Detect provider

Output:

```json
{
  "provider": "JILI",
  "gameName": "Candy Blitz",
  "platform": "HTML5"
}
```

---

## Step 2 — Detect Spin Button

Techniques:

- DOM analysis
- OCR
- Computer vision
- AI vision detection

Detect:

- Spin
- Auto
- Turbo
- Buy Bonus
- History
- Bet controls

Output:

```json
{
  "spinButton": "#spin-btn"
}
```

NOTE:

Đây KHÔNG phải testing.
Chỉ là discovery step.

---

## Step 3 — Run Smoke Spins

Run:

- 5–10 spins

Purpose:

- Ensure game functional
- Ensure no immediate crash
- Ensure APIs active

Verify:

- Spin clickable
- Spin returns response
- UI not frozen

---

## Step 4 — Capture Entire Network

Capture:

- XHR
- websocket
- fetch
- protobuf
- binary packets

Store:

```text
request
response
headers
timing
```

---

## Step 5 — AI Detects Spin API

AI analyzes:

- Request frequency
- Payload patterns
- Balance changes
- Reel data

AI suggests:

```text
Possible spin API:
POST /game/spin
```

Human/rule confirmation still required.

---

## Step 6 — Parse Game Data

Extract:

- bet
- win
- balance
- reels
- symbols
- paylines
- feature state
- free spin count

Example:

```json
{
  "bet": 10,
  "win": 25,
  "balance": 1015
}
```

---

# REAL TESTING STARTS HERE

---

# Step 7 — Rule Engine Verification

This is REAL testing.

---

## Financial Verification

Verify:

```text
expected_balance =
before_balance
- bet
+ win
```

Compare:

```text
expected vs actual
```

Possible checks:

- incorrect deduct
- incorrect payout
- duplicated payout
- missing payout

---

## Free Spin Verification

Verify:

- free spin does not deduct balance
- free spin count decreases correctly
- retrigger adds spins correctly

---

## Buy Bonus Verification

Verify:

- exact cost deducted
- feature triggered
- bonus state entered

---

## Jackpot Verification

Verify:

- jackpot amount correct
- jackpot persisted
- jackpot added once only

---

# Step 8 — Massive Spin Simulation

Run:

```text
1,000
10,000
100,000
1,000,000
```

Collect:

- RTP
- hit rate
- volatility
- feature frequency

---

# Step 9 — Statistical Verification

## RTP

Formula:

```text
RTP = total_win / total_bet
```

Verify:

```text
Expected RTP = 96.2%
Actual RTP = 96.1%
PASS
```

---

## Hit Rate

Verify:

```text
winning_spins / total_spins
```

---

## Feature Frequency

Verify:

- free spin trigger frequency
- jackpot frequency
- bonus frequency

---

# Step 10 — Report Generation

Generate:

- HTML report
- PDF report
- Screenshots
- Failure logs
- Replay links

Example:

```text
PASS: balance validation
PASS: RTP validation
FAIL: buy bonus deduct mismatch
```

---

# What Can Be Verified?

---

# LEVEL 1 — UI Verification

Verify:

- button exists
- popup opens
- animation works
- history visible
- no freeze
- no visual corruption

---

# LEVEL 2 — API Verification

Verify:

- request valid
- response valid
- session token valid
- unique round id
- no duplicated request

---

# LEVEL 3 — Financial Verification

Verify:

- balance exact
- payout exact
- free spin no deduct
- buy bonus exact deduct

---

# LEVEL 4 — Game Logic Verification

Verify:

- paylines
- scatter trigger
- wild logic
- multiplier
- retrigger
- bonus state

---

# LEVEL 5 — Statistical Verification

Verify:

- RTP
- hit rate
- volatility
- feature frequency

---

# Test Case Generation

## Generic Test Cases

Examples:

| Category | Test Case |
|---|---|
| Spin | Spin successful |
| Balance | Balance deduct correct |
| Free Spin | No deduct during free spin |
| Buy Bonus | Exact price deducted |
| History | History persists after refresh |
| RTP | RTP within expected range |
| Auto Spin | Auto stops correctly |

---

## AI Generated Test Cases

AI analyzes:

- paytable
- UI
- symbols
- feature menus
- network traffic

AI generates:

```text
1. Verify buy bonus deducts correct amount
2. Verify free spin retrigger
3. Verify gamble feature payout
4. Verify history replay
```

---

# State Machine Concept

Slot game is NOT CRUD app.

It is a state machine.

Example:

```text
NORMAL
  ↓
BUY BONUS
  ↓
FREE SPIN
  ↓
MULTIPLIER
  ↓
RETRIGGER
  ↓
END BONUS
```

Framework must understand state transitions.

---

# Feature Support

---

## Buy Free Spin

Verify:

- popup appears
- deduct correct
- enters bonus mode

---

## Special Spin

Verify:

- correct mode request
- correct payout logic
- no crash

---

## Gamble / Double

Verify:

- probability flow
- win/lose logic
- backend sync

---

## History

Verify:

- round stored
- replay correct
- persists after refresh

---

# Recommended Tech Stack

| Layer | Tech |
|---|---|
| Automation | Playwright |
| Language | TypeScript |
| Queue | BullMQ + Redis |
| DB | PostgreSQL |
| Storage | S3/GCS |
| AI | OpenAI / Claude |
| Dashboard | Next.js |
| Reporting | HTML/PDF |

---

# Provider Adapter Pattern

Each provider uses different protocol.

Recommended structure:

```text
BaseParser
 ├── PGSoftParser
 ├── JILIParser
 ├── PragmaticParser
 ├── EvolutionParser
```

Each parser handles:

- encryption
- symbols
- reels
- state format
- response structure

---

# AI Responsibilities

AI SHOULD:

- detect features
- analyze logs
- generate testcase
- explain failures
- detect anomalies

AI SHOULD NOT:

- verify financial correctness
- calculate RTP officially
- replace deterministic validation

---

# Best Practice Summary

Best practice architecture:

```text
Automation
+
Network Capture
+
Protocol Parsing
+
Rule Engine
+
Statistical Engine
+
AI Assistance
```

NOT:

```text
AI nhìn màn hình rồi tự kết luận PASS/FAIL
```

Deterministic rule validation vẫn là core của slot game automation testing.