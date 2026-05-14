# Test Case Best Practices — Slot/Casino Games

Tài liệu này tổng hợp pattern test case dựa trên 5 game đã collect (`fortune-pig`, `prosperity-mouse`, `prosperity-tiger`, `prosperity-rabbit`, `prosperity-dragon` — tất cả là RG provider, slot mechanics) và thiết kế để mở rộng sang provider/mechanic khác (Pragmatic, Megaways, Cluster Pays, Hold-and-Spin...).

---

## 1. Triết lý

1. **Triple `Step / Input / Expect` rõ ràng** cho từng case. Không assert ngầm.
2. **Source of truth là `gameSpec` + collected artifacts**, không phải hardcoded magic number.
3. **Mọi assertion phải verify được offline** trước khi chạy live (validator + AST whitelist).
4. **Categories có điều kiện** — chỉ generate case nếu game thực sự có feature đó (không generate placeholder).
5. **UI consistency là first-class** — kiểm tra OCR display vs API response, không chỉ test API.
6. **Validation phải fail fast** — sai check_code thì regen ngay, không để chạy fail giữa chừng.

---

## 2. Nguồn dữ liệu & độ tin cậy

| Nguồn | File | Độ tin cậy | Dùng cho |
|---|---|---|---|
| **GameSpec** (derived) | `fixtures/specs/{slug}/{slug}.spec.json` | **Cao** — derived từ structured config | Invariants, bet_mechanics, features |
| **Spin samples** | `fixtures/recordings/.../http.jsonl` | **Cao** cho field shape | `field_validation`, response shape |
| **Paytable** (in-session OCR) | `fixtures/options/.../paytable.json` | **Trung bình** — OCR có thể sai | Symbols, features list (informational) |
| **Options catalog** (vision) | `fixtures/options/.../options.json` | **Trung bình** | UI controls (Bet±, Sound, Turbo, History) |
| **Play screen snapshot** | `fixtures/options/.../play-screen.json` | **Thấp-trung** | Buy feature, special bets, banner text |
| **Network hints** | `fixtures/specs/.../network-hints.json` | **Cao** với confidence | Field mapping (raw → normalized) |
| **Rules markdown** (synthesized) | runtime | **Trung bình** | Rationale cho LLM |

**Quy tắc**: khi data conflict, ưu tiên theo cột "độ tin cậy". Cụ thể:
- Bet ladder → spec, KHÔNG phải paytable OCR
- Symbol payout cho test → spec, KHÔNG phải paytable (đã thấy paytable mismatch ở `prosperity-tiger` — payTable rows toàn 0)
- Currency → spec, KHÔNG phải UI text (UI có thể chậm 1 spin)

---

## 3. Test case shape (1-1 với `TestCase` type)

```json
{
  "id": "kebab-case-unique",
  "name": "Single-line display name",
  "description": "2-3 câu chi tiết test gì + tại sao",
  "category": "base_game | bet_variation | ... | ui_consistency",
  "severity": "critical | major | minor",

  "setup_instructions": "Natural language cho AI driver — UI config TRƯỚC khi spin",
  "expected_bet": 0.20,
  "expected_config": { "betSize": 0.02, "betLevel": 1 },

  "spin_count": 1,
  "expected_feature": null,

  "invariant_ids": [],
  "custom_assertions": [
    { "id": "kebab-id", "description": "what is checked", "check_code": "JS expression" }
  ]
}
```

### Mapping `TestCase` → `Step/Input/Expect`

| QA format | Field | Note |
|---|---|---|
| **Step** | `setup_instructions` (split sentences thành ordered list) + dòng cuối "Run N spins" nếu `spin_count > 0` | Không nhúng spin vào setup (driver bị cấm click main Spin button) |
| **Input** | `expected_bet`, `expected_config.*`, `spin_count`, `expected_feature` | Chỉ list field non-null |
| **Expect** | `invariant_ids` (resolve description từ spec) + `custom_assertions[]` | `invariant_ids=[]` → dùng tất cả critical+major từ spec |

> Ví dụ render trong UI: xem **QA View tab** ([app.js:loadQaView](src/ai/../public/app.js)).

---

## 4. Quy tắc viết `setup_instructions`

| Rule | Ví dụ tốt | Ví dụ tệ |
|---|---|---|
| **Mô tả TARGET state, không nêu cách click** (driver tự decide) | "Decrease bet to 0.10 USD using minus button" | "Click the - button at coordinates (1830, 985) twice" |
| **KHÔNG bao gồm spin** ngoại trừ category=`autoplay`/`buy_feature` | "Set bet to $1.00" | "Set bet to $1.00 and spin 5 times" |
| **Cite số cụ thể khi possible** | "Increase bet to maximum 100 USD" | "Increase bet to maximum" |
| Cho `autoplay`: phải có CẢ start | "Open Autoplay menu, select 10 rounds, **and press START**" | "Configure autoplay for 10 rounds" |
| Cho `buy_feature`: phải có CẢ confirm | "Click Buy Feature, select 'Free Spins' option, **click Confirm**" | "Click Buy Feature button" |
| Empty là OK cho observational case | "" cho `free_spins-organic-watch` | "Wait for free spins to trigger" (vô nghĩa với driver) |

---

## 5. Categories — universal vs conditional

### 5.1 Universal (mọi catalog phải có)

| Category | Tối thiểu | Lý do |
|---|---|---|
| `base_game` | ≥ 3 case | Verify shape, balance conservation, multi-spin integrity |
| `ui_consistency` | ≥ 2 case | OCR display ↔ API — không có ai tự kiểm tra UI khớp data |

### 5.2 Conditional — generate khi điều kiện match

| Category | Trigger điều kiện | Số case đề xuất |
|---|---|---|
| `bet_variation` | `bet_mechanics.bet_sizes.length > 1` | 4-5: min, 25%, mid, 75%, max |
| `bet_level` | `bet_levels.length > 1` AND tách biệt với `bet_sizes` | 2: level 1 vs level max |
| `autoplay` | options.json có `/auto.?play|auto.?spin/i` | 2: small batch (5-10), medium (25) |
| `turbo_spin` | options có `/turbo|quick.?spin/i` | 1: toggle + verify spin time giảm |
| `free_spins` | spec.features có `/free.?spin/i` | 1 organic watch (`expected_feature=null`) |
| `respins / bonus_watch` | spec.features có `/respin|bonus/i` | 1 organic watch |
| `buy_feature` | play-screen `.buy_feature.available=true` | 1 case PER buy option |
| `special_bet / ante` | play-screen `.special_bets.available=true` | 1 case per variant |
| `max_win_cap` | `gameSpec.invariants` có id=`max_win_cap` | 1 case (organic watch + assert cap) |
| `history` | options có `/history|rounds/i` | 1: open panel + verify rows match spins |
| `options` | options có audio/display toggle | 1-2: sound toggle, language picker |

### 5.3 Cấm generate

- **KHÔNG** generate category mà game không có (ví dụ `free_spins` cho `prosperity-tiger` chỉ có Respins, không Free Spins).
- **KHÔNG** placeholder ("test buy feature when available") — skip thẳng.
- **KHÔNG** category `other` trừ khi có lý do rõ ràng (vd: provider-specific quirk được nêu trong `observed_caveats`).

---

## 6. Invariants — chuẩn cho mọi slot

7 invariant cốt lõi đã thấy ở cả 5 game đã collect — đặt sẵn trong `gameSpec.invariants` và default được áp cho mọi case (`invariant_ids=[]`):

| ID | Severity | Check |
|---|---|---|
| `balance_conservation` | critical | `endingBalance === startingBalance - betAmount + winAmount` (±0.01) |
| `status_resolved` | critical | `status === "RESOLVED"` |
| `currency_consistency` | high | `currency === <session_currency>` |
| `bet_amount_positive` | critical | `betAmount > 0` (và trong range nếu spec có) |
| `win_amount_non_negative` | critical | `winAmount >= 0` |
| `round_id_present` | high | `typeof id === "string" && id.length > 0` |
| `matrix_present` | high | `Array.isArray(matrix) && matrix.length > 0` |

**Game-specific** (chỉ thêm nếu spec có evidence):
- `max_win_cap` — `winAmount <= cap × betAmount`
- `matrix_shape_<NxM>` — chính xác kích thước reel grid
- `bet_within_total_limits` — bet trong `[totalBet.min, totalBet.max]`
- `ending_balance_non_negative` — chống overdraft

---

## 7. UI consistency — quy ước

OCR-based assertion dùng object `screen` (chỉ inject ở category=`ui_consistency`):

| Assertion | Pattern | Tolerance |
|---|---|---|
| Balance display | `screen.balance !== null && Math.abs(screen.balance - spin.endingBalance) <= 0.01` | 0.01 |
| Bet display | `screen.bet !== null && Math.abs(screen.bet - spin.betAmount) <= 0.01` | 0.01 |
| Last win | `screen.last_win === null \|\| Math.abs(screen.last_win - spin.winAmount) <= 0.01` | 0.01, allow null |
| Currency text | `screen.currency === null \|\| screen.currency.includes(spin.currency)` | substring match |
| Free spins counter | `screen.free_spins_remaining !== null` chỉ check khi đang trong free spin chain | — |

**Quy tắc bất biến**:
1. **LUÔN check `!== null`** trước khi so — OCR có thể fail/blur.
2. **LUÔN `Math.abs(...) <= 0.01`** cho float, không bao giờ `===`.
3. **KHÔNG so chuỗi exact** với UI text (vd `"$1,000.00"`) — strip currency/comma trong `transcribePlayScreenValues` đã làm.

---

## 8. Custom assertion `check_code` — rules

### 8.1 Whitelist identifier (top-level read)

```
spin, collector, screen, balanceBefore, spinIndex
detectBuyFeatureDeduction, getRoundEndSpins, getCurrentBalance
Math, Number, Array, Object, JSON, String, Boolean, Set, Map
isFinite, isNaN, parseFloat, parseInt
true, false, null, undefined, typeof, NaN, Infinity
```

Arrow function bindings (`x` trong `arr.map(x => ...)`) tự động được skip.

### 8.2 Forbidden

- Property: `._raw`, `.tw`, `.w`, `.c`, `.sa`, `.sb` (provider-specific raw fields)
- Global: `eval`, `Function`, `require`, `process`, `global`, `globalThis`, `import`

### 8.3 Syntax constraints

- **Single expression** — wrap qua `new Function('return (' + code + ')')` để force expression context
- Cho phép: regex literal `/^[A-Z]{26}$/`, object literal `{a:1}`, IIFE `(()=>{...})()`
- Không cho: `if/for/while/var/let/const` ở top level

### 8.4 Pattern phổ biến

| Mục đích | Code |
|---|---|
| Type guard trước check số | `typeof spin.winAmount === 'number' && spin.winAmount >= 0` |
| Buy feature deduction | `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()` |
| Free spin observed | `collector.spins.some(s => s.isFreeSpin === true)` |
| All resolved | `collector.spins.every(s => s.status === 'RESOLVED')` |
| Sum reconciliation | `(() => { const sumBet = collector.spins.reduce((a, s) => a + (s.betAmount \|\| 0), 0); const sumWin = collector.spins.reduce((a, s) => a + (s.winAmount \|\| 0), 0); return Math.abs(getCurrentBalance(collector) - balanceBefore - sumWin + sumBet) <= 0.01; })()` |
| ULID round id shape | `/^[0-9A-HJKMNP-TV-Z]{26}$/.test(spin.id)` |

---

## 9. Severity guidance

| Severity | Khi nào dùng | Ví dụ |
|---|---|---|
| `critical` | Balance integrity, payout correctness — bug ở đây = MISSING MONEY | balance_conservation, max_win_cap, bet_amount_positive |
| `major` | Feature functionality không đúng — bug = feature bị break | autoplay rounds đếm sai, buy_feature deduction sai, history rows mismatch |
| `minor` | UX / display — bug = annoying nhưng không ảnh hưởng money | turbo speed không nhanh hơn, sound toggle không tắt được, menu mở không đúng |

---

## 10. Coverage tối thiểu cho game mới

Dựa trên 5 game đã có:

| Loại game | Cases tối thiểu | Bắt buộc có |
|---|---|---|
| Slot 3×3 (5 paylines) | 12 | base_game ×3, bet_variation ×3, ui_consistency ×2, options ×1, currency check ×1, response shape ×1, history ×1 |
| Slot 3-4-3 (line pay) | 14 | + symbol payout watch ×1, free_spins ×1 |
| Slot 5-reel với features | 18 | + buy_feature ×1, free_spins ×1, max_win_cap ×1, special_bet ×1 |
| Megaways / cluster | 22 | + tumble/cascade chain validation ×2, way count varies ×1 |

Coverage rules tự động warn ở [catalog-coverage-rules.ts](../src/ai/catalog-coverage-rules.ts) nếu thiếu.

---

## 11. Templates theo variant

### 11.1 Slot 3×3 (e.g. prosperity-tiger, prosperity-mouse, prosperity-rabbit)

```yaml
must_have:
  - base_game: 3+ (default bet, multi-spin, response shape)
  - bet_variation: 5 (min, 25%, mid, 75%, max)
  - bet_level: 2 (level 1 vs level max)
  - ui_consistency: 3 (balance, bet, last_win display)
  - options: 1-2 (sound toggle)

conditional:
  - history: 1 if option present
  - turbo_spin: 1 if option present
  - autoplay: 2 if option present
  - respins_watch: 1 if features mention respins (don't strict assert)
```

### 11.2 Slot 3-4-3 line pay (e.g. fortune-pig)

Như 3×3 + thêm:
- `matrix_shape_3-4-3` invariant
- `free_spins-organic-watch` (nếu có scatter)
- `wild-substitution-watch` (nếu có WILD)

### 11.3 Slot 5-reel với buy feature (e.g. Pragmatic Sweet Bonanza)

Như 3-4-3 + thêm:
- `buy_feature` 1 case per option (ratio 50x, 100x, 250x — verify deduction = N × bet)
- `special_bet` (Ante / Double Chance) 1 per variant
- `max_win_cap` strict assert (vd Sweet Bonanza cap 25,000×)

### 11.4 Mechanic mới (Megaways, Cluster, Hold-and-Spin)

Pattern bổ sung khi mở rộng:
- Megaways: `way_count_varies` — `collector.spins.map(s => s.wayCount).filter(unique).length > 1`
- Cluster: tumble chain detection — `collector.spins.filter(s => s.isCascade).length > 0`
- Hold-and-Spin: respin lock state — case-specific custom

---

## 12. Mở rộng sang provider khác (non-RG)

Khi crawler gặp provider mới (Pragmatic, Evoplay, ...):

1. **Cập nhật `extract-options.ts`** vision prompts để bắt được UI variants (Pragmatic có buy feature ở vị trí khác, ante bet panel...).
2. **Cập nhật `network-detect.ts`** để detect endpoint pattern mới.
3. **Cập nhật `network-hints.json`** field mapping nếu provider dùng key khác (vd `bet` vs `betAmount`, `balance` vs `endingBalance`).
4. **KHÔNG sửa whitelist trong validator** trừ khi provider có normalized field mới — luôn assert qua field đã normalize, KHÔNG qua `_raw`.
5. Nếu paytable layout khác hẳn (Evoplay ngang vs Pragmatic dọc), update `transcribeRulesPage` prompt.

**Forbidden property list** (`_raw`, `tw`, `w`, ...) đặc biệt cho RG raw schema. Provider khác có key khác (Pragmatic dùng `bet_w`, `win_amt`...) → cần update `FORBIDDEN_PROPERTY_NAMES` trong [catalog-validator.ts](../src/ai/catalog-validator.ts) khi extend.

---

## 13. Workflow tổng thể

```
COLLECT phase
  ├─ record-traffic.ts  → http.jsonl, ws.jsonl
  ├─ auto-play.ts       → spin samples
  ├─ extract-options.ts → options.json + paytable.json + play-screen.json
  └─ derive spec        → {slug}.spec.json

PHASE A.5 — GENERATE CATALOG
  ├─ STEP 1 PLAN     (LLM, 30-60s)  → 12-40 case stubs
  ├─ STEP 2 EXPAND   (LLM, 60-180s) → full TestCase[]
  ├─ STEP 3 VALIDATE
  │   ├─ catalog-validator.ts (syntax + identifiers + category contracts)
  │   ├─ catalog-coverage-rules.ts (conditional category presence)
  │   └─ retry EXPAND once với feedback nếu errors
  └─ save: {slug}.test-cases.json

REVIEW (manual, optional)
  ├─ open UI → tab "QA View" → review Step/Input/Expect
  └─ catalog-snapshot.ts diff with previous version

PHASE B — GENERATE PLAYWRIGHT
  └─ tests/generated/{slug}.spec.ts (1 test() block per case)

PHASE C — RUN
  ├─ Playwright + setup-driver.ts (vision-driven UI config)
  ├─ EVENT:case_start / case_end → live update UI
  └─ case-report.json + .md
```

---

## 14. Quy ước file & path

```
fixtures/specs/{slug}/
  ├─ {slug}.spec.json              # GameSpec (derived, source of truth)
  ├─ {slug}.preflight.json         # Preflight check results
  ├─ {slug}.catalog-context.json   # Inputs used (provenance)
  ├─ {slug}.test-cases.json        # Test catalog (Phase A.5 output)
  ├─ {slug}.test-cases.NEW.json    # measure-catalog comparison output
  └─ network-hints.json            # Field mapping

fixtures/options/{slug}__{ts}/
  ├─ options.json                  # UI controls
  ├─ play-screen.json              # Vision + API combined snapshot
  ├─ paytable.json                 # Symbol + features OCR'd
  ├─ api-snapshot.json             # Structured network artifact
  └─ screenshots/                  # Raw captures

fixtures/recordings/{slug}__auto-{ts}/
  ├─ http.jsonl                    # All HTTP traffic
  ├─ ws.jsonl                      # WebSocket frames
  └─ video/                        # Playback

fixtures/tasks/{taskId}/
  ├─ log.jsonl                     # Per-task event log
  ├─ events.jsonl                  # Spin events
  ├─ case-report.json              # Test results (post-run)
  ├─ case-report.md                # Markdown summary
  └─ screenshots/{caseId}/
```

---

## 15. Anti-patterns đã thấy

Từ data đã collect — nên TRÁNH những thứ này khi viết catalog mới:

| Anti-pattern | Game ví dụ | Fix |
|---|---|---|
| Assert `config.code === game_slug` | fortune-pig (config.code=`fortune-mouse-two`!) | Bỏ assert này — provider hay share template |
| Strict free_spins spin count | tất cả game đã có | `expected_feature=null`, organic watch only |
| Symbol payout từ `paytable.json` | prosperity-tiger (rows toàn 0) | Dùng spec.symbols thay paytable OCR |
| `samples_field_varies` trên `betAmount` | prosperity-mouse (constant=1) | Chỉ áp trên `winAmount` hoặc `id` |
| Assume currency từ UI text | tất cả | Dùng `spec.currency`, UI có thể OCR sai |
| Hardcode coordinates click | — | Dùng natural-language `setup_instructions`, để AI driver tự decide |
| Assert sub-field `_raw.fortuneTigerMultiplier` | prosperity-tiger | Validator reject `_raw` — chỉ assert qua normalized fields |

---

## 16. Checklist trước khi commit catalog mới

Khi review catalog cho 1 game mới (chạy thủ công hoặc CI):

- [ ] Validator pass (`✔ catalog passed validation cleanly`)
- [ ] Coverage warnings ≤ 2 (mỗi warning có lý do trong `coverage_notes`)
- [ ] ≥ 12 cases tổng
- [ ] Universal categories đủ: `base_game ≥3`, `ui_consistency ≥2`
- [ ] Conditional categories khớp với options/spec evidence (no orphan)
- [ ] Mọi `setup_instructions` actionable, không nhúng spin (trừ autoplay/buy)
- [ ] Mọi `check_code` parse như single expression
- [ ] `expected_bet` consistent với `expected_config` (bet = baseBet × betSize × betLevel)
- [ ] `severity` phù hợp (xem mục 9)
- [ ] Không reference field `_raw`/provider-specific
- [ ] Snapshot diff vs previous version đã review (nếu rerun)

---

## 17. Tham khảo nhanh

- Validator implementation: [catalog-validator.ts](../src/ai/catalog-validator.ts)
- Coverage rules: [catalog-coverage-rules.ts](../src/ai/catalog-coverage-rules.ts)
- Snapshot diff: [catalog-snapshot.ts](../src/ai/catalog-snapshot.ts)
- LLM gen pipeline: [test-catalog.ts](../src/ai/test-catalog.ts)
- UI render: [QA View tab](../public/app.js) (function `loadQaView`)
- TestCase type: [test-catalog.ts:20-40](../src/ai/test-catalog.ts)
- Vision OCR for screen values: [vision.ts:transcribePlayScreenValues](../src/ai/vision.ts)

---

## 18. Advanced verification patterns (high-value gaps)

7 patterns sau đây đã được nghiên cứu trên data collected (5 game) và xác nhận **fields đều có sẵn trong API/config response**, nhưng trước đây catalog generator hay bỏ sót. Mọi catalog từ giờ phải emit chúng khi điều kiện trigger thoả.

### 18.1 `rules_consistency` — symbol mapping check (NEW category)

**Trigger**: luôn (universal).

**Mục đích**: phát hiện template mismatch giữa config code, paytable display và spec. Đã thấy ở fortune-pig: `config.code='fortune-mouse-two'` (template share), prosperity-dragon: spec dùng id `[0..6]` còn paytable dùng tên `[WILD, Golden Dragon, ...]`.

**Data**:
- `gameSpec.symbols: [{code, type, multipliers}]`
- `/config` response: `symbols: [{id, code, type}]`
- `paytable.json` (OCR): `pages[].symbols[].name`

**Cases** (1-2 case):
- `rules-symbol-count-match`: assert `gameSpec.symbols.length === config.symbols.length` AND number of WILD/SCATTER/PICTURE_SYMBOL types khớp với paytable rules text.
- `rules-symbol-types-consistent`: assert mọi symbol trong spec có ID/CODE khớp với config (nếu code dùng cùng convention). Note: paytable name có thể khác (OCR), không strict match.

**Severity**: major (bug ở đây = data drift giữa runtime và rules display).

### 18.2 `payout_correctness` — paytable × win combination (NEW category — CRITICAL gap)

**Trigger**: luôn — đây là test case **quan trọng nhất** mà catalog cũ thiếu hoàn toàn.

**Mục đích**: verify mỗi winline trả winAmount đúng theo paytable. Catalog cũ chỉ check `balance_conservation` (tổng tiền cộng đúng), KHÔNG check **payout có khớp paytable không**. Bug RNG hoặc payTable corruption sẽ qua được balance check nhưng fail paytable check.

**Data**:
- `/config` response: `payTable: [{id, multiple: {3: 500, 4: 100, 5: 50}}]` (1 entry per symbol id)
- Spin response: `result.winlines: [{symbolId, sameItem, lineId, winPosition, winAmount}]`
- `betAmount`, `betSize`, `betLevel`, `baseBet`

**Formula**:
```
expected_winline_amount = baseBet × betSize × betLevel × payTable[symbolId].multiple[sameItem]
                       OR (depending on game) coinValue × payTable[symbolId].multiple[sameItem]
```
Lưu ý: với **wild substitution**, `symbolId` trong winline là id của symbol **đã được wild thay** (không phải id của WILD). Verify bằng cách check matrix tại `winPosition` — nếu có WILD, payout dùng multiplier của symbol kia.

**Cases** (1-2 case):
- `payout-base-game-correctness`: chạy 20-30 spin → cho mỗi spin có `winAmount > 0`, iterate `result.winlines[]`, assert `Math.abs(winline.winAmount - expected) <= 0.01`. **Custom check_code dùng helper `verifyWinlinePayout(spin, payTable, betAmount)`** (cần thêm vào test-harness).
- `payout-zero-on-no-winline`: assert `winAmount === 0` nếu `result.winlines.length === 0`.

**Severity**: critical (bug = sai tiền thắng).

### 18.3 `wild_substitution` — Wild substitution rule (NEW category)

**Trigger**: spec.symbols có WILD (`type: "WILD"`).

**Mục đích**: xác nhận WILD thay được symbol khác để tạo combo. Đặc biệt với game có **multiplier × Wild** (fortune-pig x10, prosperity-tiger Fortune Tiger feature).

**Data**:
- Spin response `matrix`: array of `{symbol, value, type}` cells. WILD symbol có `id=0` hoặc `code="WD"` trong RG schema.
- `result.winlines[].winPosition`: list cells tham gia winline.

**Cases** (1 case):
- `wild-substitution-watch`: organic 50-spin. Khi observe spin có WILD trong matrix VÀ winline đi qua position của WILD → assert winAmount khớp với multiplier của symbol bị substitute (KHÔNG phải multiplier của WILD trong payTable). Logic verify:
  ```
  for each winline in spin.result.winlines:
    positions = winline.winPosition
    if any matrix[pos].symbol === WILD_ID:
      // WILD đã substitute. symbolId trong winline phải là symbol thật.
      assert winline.symbolId !== WILD_ID
      assert winline.winAmount === bet × payTable[winline.symbolId].multiple[sameItem]
  ```

**Severity**: critical (bug = WILD tính sai → payout sai).

### 18.4 `free_spins` SPLIT into trigger + result

Thay vì 1 case organic-watch chung, **split thành 2 case riêng**:

#### 18.4.1 `free-spins-trigger-watch`

**Mục đích**: verify ĐÚNG ĐIỀU KIỆN trigger free spin.

**Data**: `isFreeSpin`, `freeSpins`, matrix tại spin trigger, scatter symbol id (từ spec.symbols where type="SCATTER").

**Logic**:
```
organic 60-spin watch. For each transition where prev.isFreeSpin=false → curr.isFreeSpin=true:
  count_scatters = matrix(prev) cells where symbol === SCATTER_ID
  assert count_scatters >= 3  (or per game rules)
  assert curr.freeSpins > 0  (counter started)
```

**Severity**: major.

#### 18.4.2 `free-spins-result-shape`

**Mục đích**: với mỗi free spin, verify response shape correct.

**Logic**:
```
For each spin where isFreeSpin === true:
  assert betAmount === 0       // free spin không trừ bet
  assert spin.freeSpins decreased từ trước (counter đếm xuống)
  assert winAmount >= 0
  assert totalWinFreeSpin >= prev.totalWinFreeSpin  (cumulative không giảm)
```

**Severity**: critical.

### 18.5 `respin` SPLIT into trigger + result (NEW category — replaces "other")

#### 18.5.1 `respin-trigger-watch`

**Mục đích**: verify respin được trigger đúng cơ chế.

**Game-specific fields** (đã observe):
- prosperity-mouse: `_raw.fortuneMouseFeatureProcessResult` (validator phải allowlist field này)
- prosperity-tiger: `_raw.fortuneTigerMultiplier`, `multiplier`
- fortune-pig: `multiplier` field

**Logic**: organic watch — khi `multiplier > 1` xuất hiện, assert matrix tại spin đó có Wild stacked (game-specific position check).

**Severity**: major.

#### 18.5.2 `respin-result-multiplier`

**Mục đích**: khi respin triggered, verify multiplier áp dụng đúng vào winAmount.

**Logic**:
```
For each spin where multiplier > 1:
  base_win = paytable_calculated_win
  assert spin.winAmount === base_win × spin.multiplier (±0.01)
```

**Severity**: critical.

### 18.6 `history` SPLIT into normal vs freespin

#### 18.6.1 `history-normal-bet`

**Mục đích**: verify history rows khớp với normal bet samples.

**Steps**:
1. Run 5 base spin (record bet, win, balance, round_id của mỗi spin).
2. Open history panel (UI).
3. Read top 5 rows via `transcribeHistoryRows()`.
4. Match từng row với spin samples theo round_id (hoặc theo timestamp + bet).
5. Assert `row.bet === spin.betAmount`, `row.win === spin.winAmount`, `row.balance_after === spin.endingBalance`.

**Severity**: major.

#### 18.6.2 `history-freespin-row`

**Mục đích**: verify free spin rounds hiển thị riêng biệt trong history.

**Steps**: organic-watch — sau khi observe free spin chain, mở history, assert row(s) tương ứng có distinguishing flag (FS tag, bet=0, hoặc total_bet="bonus"). Cụ thể tùy provider — đọc UI text.

**Severity**: minor (display correctness).

### 18.7 `bet_boundary` — bet limit boundary (NEW category — security/integrity)

**Trigger**: luôn (universal).

**Mục đích**: server PHẢI reject bet ngoài range `[totalBet.min, totalBet.max]`. Nếu UI cho phép set bet > max bằng cách click `+` quá nhiều, hoặc bet < min, server phải clamp hoặc reject. Bug ở đây = security vulnerability (player có thể spin với bet âm hoặc 0).

**Data**: `gameSpec.bet_mechanics` total range, UI bet stepper.

**Cases** (2 case):

#### 18.7.1 `bet-above-max-rejected`

**Steps**:
1. Click bet `+` button đến khi reach max ($100 fortune-pig / $600 mouse-tiger-rabbit).
2. Click `+` thêm 5 lần nữa (overshoot attempt).
3. Spin 1 lần.
4. Verify: bet display **STILL** = max value (UI clamped) AND `spin.betAmount === max` (server clamped).

#### 18.7.2 `bet-below-min-rejected`

**Steps**:
1. Click bet `-` đến khi reach min ($0.10 / $0.50).
2. Click `-` thêm 5 lần nữa.
3. Spin 1 lần.
4. Verify: bet display = min, `spin.betAmount === min`.

**Severity**: critical (player tiền integrity).

---

## 19. Coverage rules update (auto-enforce)

Bảng dưới phản ánh `catalog-coverage-rules.ts` mới (auto-warn nếu thiếu):

| Rule ID | Trigger | Expected |
|---|---|---|
| `rules-consistency-required` | always | ≥ 1 case category=rules_consistency |
| `payout-correctness-required` | always | ≥ 1 case category=payout_correctness |
| `wild-substitution-when-wild-exists` | spec.symbols có type=WILD | ≥ 1 case category=wild_substitution |
| `free-spins-split-when-feature` | features mentions free_spins | ≥ 2 case category=free_spins (trigger + result) |
| `respin-split-when-feature` | features mentions respin | ≥ 2 case category=respin |
| `history-split-when-option` | options có History + features có free_spins | ≥ 2 case category=history (normal + freespin) |
| `bet-boundary-required` | bet_mechanics có range | ≥ 2 case category=bet_boundary |

