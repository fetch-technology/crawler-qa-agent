# Dashboard Guide — Hướng dẫn sử dụng UI (chỉ Dashboard)

> Hướng dẫn dùng web dashboard của `crawler-qa-agent` — onboarding 1 slot game mới, verify UI elements, generate + run test cases, xem kết quả. Không đề cập CLI.

URL: `http://localhost:3200/` (sau khi server đã chạy)

---

## Mục lục

1. [Khái niệm cơ bản](#1-khái-niệm-cơ-bản)
2. [Trang Overview — `/`](#2-trang-overview)
3. [Trang Game Detail — `/game/<slug>`](#3-trang-game-detail)
4. [Panel: New / Active Session](#4-panel-new--active-session)
5. [Panel: Registry — Verify Elements & Discover](#5-panel-registry)
6. [Panel: Add Element (missed by AI)](#6-panel-add-element)
7. [Panel: OCR Regions](#7-panel-ocr-regions)
8. [Panel: Discovery Snapshots](#8-panel-discovery-snapshots)
9. [Panel: Test Cases — Inspect & Run](#9-panel-test-cases)
10. [Panel: App Log](#10-panel-app-log)
11. [Workflow chuẩn cho 1 game mới](#11-workflow-chuẩn)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Khái niệm cơ bản

| Thuật ngữ | Nghĩa |
|---|---|
| **Session** | 1 Playwright Chrome instance được mở cho 1 game cụ thể. Phải có session live mới chạy được Discover / Probe / Run cases. |
| **Registry** | Danh sách UI elements (uiKey + tọa độ x/y) đã được xác minh trong game. Lưu vào `fixtures/registry/<slug>/`. |
| **uiKey** | Tên định danh element, theo dạng `parent__child` (vd `menuButton`, `menuButton__historyButton`, `autoButton__autospins-10`). |
| **Discover** | AI vision quét screenshot → đề xuất các element + vị trí. QA confirm hoặc reject. |
| **Probe** | Backend tự click thử element → quan sát network / popup → tự verify (no AI needed sau khi đã propose). |
| **Auto-Onboard** | Pipeline 1-click: Deep Discover → Probe → Calibrate Payout. Có thể mất 30 phút – 1 tiếng. |
| **OCR Region** | Bounding box trên màn hình mà runtime sẽ OCR mỗi spin (Balance / Bet / Last Win / Free Spin). |
| **Catalog** | Bộ test case do AI sinh từ rules + game spec. Mỗi case có translated actions (list click). |
| **Calibrate Payout** | Spin ở ≥ 2 mức bet để derive payout model, dùng cho `payout-integrity` case. |

Pipeline tổng quan: **Start session → Discover/Probe elements → Define OCR Regions → Calibrate Payout → Generate Cases → Run Cases**.

---

## 2. Trang Overview

URL: `/` hoặc `/dashboard`.

```
┌────────────────────────────────────────────────────────┐
│  QA · Games Overview                  N live · M on disk│
├────────────────────────────────────────────────────────┤
│  N games registered · M active sessions      [Refresh] │
│  ┌──────────────────────────────────────────────────┐  │
│  │ URL: [https://pp.dev.../<slug>/?t=…]             │  │
│  │ ☐ auto-discover on start   [Start Session]       │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ vs20rnriches│ │ candy-blitz │ │ sweet-bon   │  …    │
│  │  live       │ │  idle       │ │  idle       │       │
│  │ Reg: 24 Ver:24                                       │
│  │ [Open] [Resume] [Delete]                             │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
└────────────────────────────────────────────────────────┘
```

### Phần tử

| Element | Mục đích |
|---|---|
| **Top bar — `N live · M on disk`** | N session đang chạy / M game đã lưu fixtures. |
| **URL input** | Paste full game URL (kèm token `?t=…`). Slug tự derive từ host + path. |
| **☐ auto-discover on start** | Nếu tick: ngay khi Start xong sẽ chạy AI Deep Discover. Không tick (mặc định): chỉ launch Chrome + load URL, sau đó QA tự bấm Discover khi cần. |
| **[Start Session]** | Tạo session mới + chuyển sang trang detail. Mất ~10–30s (Chrome warm-up + dismiss popup). |
| **[Refresh]** | Reload danh sách (cũng auto-refresh mỗi 5s). |
| **Card — Open** | Mở trang detail của game (kể cả khi không có session). |
| **Card — Resume** | Bật lại Chrome cho game đã có registry, không re-discover. |
| **Card — Delete** | **Xóa registry + toàn bộ fixtures** (cases / scenarios / stats / evidence). Có confirm dialog. Không undo được. |

> **Lưu ý**: Click vào thân card (ngoài button) = Open. Click button trong card không trigger card click (đã `stopPropagation`).

---

## 3. Trang Game Detail

URL: `/game/<slug>` (auto-rewrite sang `manual-verify.html?gameSlug=<slug>`).

```
[← All Games]   QA · Manual Verify   [vs20rnriches]

┌─ Registered Games · Resume Previous Work ────────────┐
│ Game | URL | Created | Verified | Actions            │
│ vs20rnriches | https://…/?t=…  [Save]  24  [Stop]    │
│                                  [Generate Cases]    │
│                                  [Load Cases]        │
│                                  [Run Stats] spins:N │
│                                  [Delete]            │
└──────────────────────────────────────────────────────┘
┌─ New / Active Session ───────────────────────────────┐
└─ Registry · Verify Elements & Discover ──────────────┘
┌─ Add Element ────────────────────────────────────────┐
┌─ OCR Regions · Define widget bounding boxes ─────────┐
┌─ Discovery Snapshots — what AI saw at each level ────┐
┌─ Test Cases · Inspect & Run ─────────────────────────┐
┌─ App Log · Dashboard ↔ Server ───────────────────────┐
```

Khi page được scope vào `?gameSlug=<slug>`, panel `Registered Games` chỉ show duy nhất row của game đó (cross-game overview chuyển hết về `/`).

### Trên cùng

- **`← All Games`** — quay về `/`.
- **Badge `vs20rnriches`** — slug đang scope. Title browser cũng đổi thành `QA · <slug>`.
- **Task banner xanh** — hiện khi có pipeline (Discover / Calibrate / Run All / …) đang chạy, có elapsed time real-time.

### Action buttons trên row của Registered Games

| Button | Mục đích | Khi nào enabled |
|---|---|---|
| **Save** (cạnh URL input) | Update URL/token mà giữ nguyên registry — dùng khi token cũ hết hạn. | Always |
| **Start session / Stop & Save** | Toggle session cho game này. | Theo trạng thái session |
| **Generate Cases** | Gọi AI catalog → sinh + translate test cases. ~30–90s (có polling fallback 30 phút khi proxy time-out). | Always (có registry là chạy được) |
| **Load Cases** | Đọc test cases từ disk vào panel "Test Cases". Không cần session live. | Always |
| **Run Stats** | Spin số lượng lớn (input ở `spins:`) → tính RTP / Hit Rate / Volatility (không chạy test cases). | Có session live |
| **Delete** | Xóa game + toàn bộ fixtures. Confirm dialog. | Always |
| **`spins:` input** | Số spin cho Run Stats / Run Cases (1–100000, default 100). | Always |

---

## 4. Panel: New / Active Session

```
URL: [https://pp.dev.revenge-games.com/<slug>/?t=…]
☐ Auto-discover AI at Start    [Start Session]  [Refresh State]
Not started.
```

| Control | Effect |
|---|---|
| **URL** | Paste game URL. Token bắt buộc còn hạn. |
| **Auto-discover AI at Start** | Tick → ngay sau Start sẽ chạy Deep Discover toàn bộ. Bỏ tick (mặc định) → chỉ load URL, QA tự bấm Discover. |
| **Start Session** | Launch Playwright Chrome. ~10–30s. Sau khi xong, các button khác (Discover, OCR, …) mới enable. |
| **Refresh State** | Re-fetch `/status` từ server và re-render registry/snapshots — dùng khi QA chỉnh fixtures bằng tay ngoài UI. |
| **`sessionInfo`** | Hiển thị slug + provider + state hiện tại (vd `vs20rnriches · pragmaticplay · running`). |

---

## 5. Panel: Registry

Danh sách UI elements + button hành động per row.

```
[Deep Discover (AI)] [Probe Pending] [Auto-Onboard] [⏸ Pause]

▼ menuButton                pending  (720, 32)  [Test][✓ Verify][Pick][Discover][+][⧉][×]
   ▼ menuButton__historyButton  verified  (480, 220) …
   ▼ menuButton__settingsButton verified  (480, 280) …
▼ autoButton                pending  (640, 810) …
…
```

### Hàng button trên cùng

| Button | Mục đích |
|---|---|
| **Deep Discover (AI)** | AI recursively explore: mở từng button → hash state → discover children → loop. Bounded bởi depth + AI calls + states. Mất ~5–15 phút. |
| **Probe Pending** | Auto-verify mọi element còn `pending`: click thử → quan sát network/popup → set verdict. Thay thế phần lớn QA Pick thủ công. |
| **Auto-Onboard** | One-click: Deep Discover + Probe Pending + Calibrate Payout. Mất 30 phút – 1 tiếng tùy game. |
| **⏸ Pause** | Pause Auto-Onboard sau khi phase hiện tại kết thúc (không pause giữa phase). Resume = bấm lại Auto-Onboard. |

> **Khi nào dùng cái nào?** Game mới hoàn toàn → Auto-Onboard. Game đã có registry nhưng UI vừa thay đổi → Deep Discover. Có 1 vài element pending sau Discover → Probe Pending.

### Onboard Progress panel

Khi Auto-Onboard chạy, một block dưới hàng button sẽ hiện:

```
Auto-Onboard Progress    3/5 phases done · 12m elapsed
 ✓ Deep Discover  (1m 24s)
 ✓ Probe Pending  (47s)
 ⏳ Calibrate Payout  (running 2m 11s)
 ⋯ Validate Catalog
 ⋯ Final Snapshot
```

Persist sau khi xong để QA review timings + skip reasons.

### Per-row actions

| Button | Effect |
|---|---|
| **Test** | Backend click trên Playwright Chrome — verify visual mà chưa update status. |
| **✓ Verify** | Đánh dấu element `verified` (status pill chuyển sang xanh). |
| **✓ All (N)** | Verify toàn bộ children của row đang đứng. |
| **Pick** | Mở picker overlay với screenshot tươi — QA click chính giữa element trên ảnh → set lại tọa độ. |
| **Discover** | Backend click element này → đợi popup → AI capture sub-state → thêm children nested. |
| **+** | Mở Add Element form với prefilled `<key>__`. |
| **⧉** | Copy uiKey vào Add Element form (để rename/repick). |
| **×** | Remove element khỏi registry. |
| **AI Recover** | (Trên element đã reject) AI tìm lại element trên screen hiện tại. |

### Status pill

- `pending` (xám) — đã propose, chưa verify
- `verified` (xanh) — đã verify (probe hoặc QA confirm)
- `rejected` (đỏ) — verify thất bại, cần AI Recover hoặc Pick lại

### Discovery Gaps

Sau Deep Discover, block `discoveryGaps` báo những element kỳ vọng (theo provider profile) mà chưa thấy — vd `turboButton ở autoplay popup`. Dùng làm checklist cho QA.

---

## 6. Panel: Add Element

Khi AI bỏ sót 1 element và QA muốn thêm thủ công.

```
uiKey: [autoplay_popup__autospins-10]   [Pick on Screenshot]
or fill manually: x: [___]  y: [___]   [Add]
```

| Field/Button | Mục đích |
|---|---|
| **uiKey input** | Theo convention `parent__child`. Vd `menuButton__historyButton`. |
| **Pick on Screenshot** | Mở picker với screenshot tươi — click vào element → tọa độ auto-fill. |
| **x / y manual** | Nhập trực tiếp pixel coord (đo bằng tay từ screenshot khác). |
| **Add** | Ghi vào registry với status `pending` (chưa verify). |

> Trên element parent có button **`+`** — dùng cái này thay vì panel để prefilled prefix tự động.

---

## 7. Panel: OCR Regions

Define bbox cho runtime để OCR `balance` / `bet` / `last_win` / `free_spin_count` mỗi spin.

```
[🔄 Refresh screenshot] [🤖 AI Auto-Detect] [✕ Cancel drawing]   (no session)

| Key             | Color | Bbox     | Test value | Actions      |
| balance widget  | green | not set  | —          | [✏️ Draw]    |
| bet widget      | blue  | …        | $1.00      | [Redraw][Test OCR][Remove]
| win widget      | orange|          |            |              |
| free spin count | purple|          |            |              |
```

### Workflow vẽ bbox

1. Click **`✏️ Draw`** trên row tương ứng (vd `balance widget`).
2. Screenshot tự load bên dưới. Banner cam: **STEP 1/2: Click TOP-LEFT corner**.
3. Click **góc trên-trái** của widget trên ảnh — chấm cam đánh dấu vị trí.
4. Di chuột → ghost rectangle preview. Banner đổi: **STEP 2/2: Click BOTTOM-RIGHT corner**.
5. Click **góc dưới-phải** → backend test OCR luôn + lưu bbox.

### Buttons khác

| Button | Effect |
|---|---|
| **🔄 Refresh screenshot** | Re-capture nếu game state đã đổi (vd vừa close popup). |
| **🤖 AI Auto-Detect** | AI vision đoán bbox của Balance / Bet / Win / Free Spin từ screenshot hiện tại. Pick có confidence ≥ threshold sẽ auto-save; thấp hơn sẽ propose để QA accept thủ công. |
| **✕ Cancel drawing** | Hủy giữa draw (sau Step 1 mà chưa Step 2). |
| **Test OCR** | OCR ngay bbox đã định nghĩa → hiển thị giá trị → confirm đúng. |
| **Remove** | Xóa bbox. |

> **Khi nào cần?** Test case dùng `screen.balance` / `screen.last_win` để assert, hoặc rule `UiBalanceMatchesApiRule`. Không define = case sẽ skip với `skipReason: missing OCR region`.

---

## 8. Panel: Discovery Snapshots

Visual record của những gì AI đã thấy ở mỗi state.

```
Discovery Snapshots — what AI saw at each level     [Refresh]

| State                  | Elements | Verified | Created  | Actions |
| main                   | 8        | 8        | 5m ago   | [View]  |
| menuButton popup       | 6        | 6        | 4m ago   | [View]  |
| autoButton popup       | 5        | 4        | 3m ago   | [View]  |
| buyBonusButton popup   | 3        | 3        | 2m ago   | [View]  |
```

Click **View** trên row → hiển thị screenshot full với markers màu (green = verified, yellow = pending, red = rejected) tại các tọa độ AI đã propose. Marker có icon:

- 🤖 — probe-verified (backend)
- 👤 — QA-verified manually

Dùng để verify sau Discover: AI đã thấy đúng popup chưa, có element nào bị miss/wrong coord không.

---

## 9. Panel: Test Cases

Panel quan trọng nhất sau khi onboard xong.

```
Test Cases · Inspect & Run
                       [Calibrate Payout][Run All cases][Run Unrun]
                       [Load Cases][Re-translate Skipped]
                       [Re-translate ALL][Clear Results]

Run All settings:
  Max wait per case (sec): [90]
  ☐ behavioral probe (uses 1 spin/case)
  ☑ 🤖 Auto-mode (heuristic + auto-apply high-conf patches)

CATEGORY: BET (3 cases)
| ▶ | Pass/Fail | Title              | Actions | Run | Edit |
| ▼ | ✓ PASS   | min-bet-spin       | 4       | [Run] [✎ Edit] [Re-translate] |
|   |          | ↳ Detailed assertions, OCR evidence, network capture, screenshot, video
```

### Action buttons header (theo thứ tự)

| Button | Effect |
|---|---|
| **Calibrate Payout** | Spin ở ≥ 2 mức bet → derive + self-validate payout model. One-time per game. Required cho `payout-integrity` case. |
| **Run All cases** | Chạy toàn bộ case runnable tuần tự. Hiện banner + progress table real-time. |
| **Run Unrun** | Chỉ chạy case chưa có verdict (unrun / skipped). |
| **Load Cases** | Đọc từ disk vào panel. Bấm sau khi `Generate Cases`. |
| **Re-translate Skipped** | Re-run AI translator chỉ với case có 0 actions hoặc skipReason. |
| **Re-translate ALL** | Re-run AI translator cho **mọi** case (kể cả case đang chạy được — sẽ overwrite). |
| **Clear Results** | Xóa cached run results trong localStorage cho game đang xem. |

### Run All settings

| Setting | Mục đích |
|---|---|
| **Max wait per case (sec)** | Tối đa bao lâu đợi game settle về main giữa 2 case. Poll mỗi 2s, đi tiếp khi detect "on main". Default 90s. |
| **Behavioral probe (uses 1 spin/case)** | Tick → trước mỗi case sẽ click spinButton + đợi 3s spin response. Xác nhận "on main" chắc chắn nhưng tốn 1 spin (= bet) mỗi case. |
| **🤖 Auto-mode** (tick mặc định) | Khi case FAIL_LOW / INCONCLUSIVE, tự run heuristic AI Review (free, không gọi LLM) + auto-apply patch nếu confidence ≥ 0.85 + rerun 1 lần. Capped 1 patch/case (cho full loop dùng button `🔁 Auto-Rerun Loop` per case). |

### Run Progress Table

Trong khi `Run All` chạy:

```
Running 24 cases…   13/24    [Cancel]
| Status   | Case ID            | Elapsed |
| ✓ PASS   | min-bet-spin       | 4.2s    |
| ✓ PASS   | mid-bet-spin       | 5.0s    |
| ⏳ run   | autospin-toggle    | 2.3s    |  ← highlighted blue, click → scroll xuống case row
| ⋯ queue  | …                  |         |
```

Click row → scroll case panel xuống case đó.

### Per-case row

Click `▼` để expand. Mỗi case có:

| Phần | Mục đích |
|---|---|
| **Pass/Fail badge** | Tổng verdict. Khi expand cho biết breakdown. |
| **Action count + skipReason** | Số click trong translated actions; nếu 0 thường do thiếu element hoặc OCR region. |
| **[Run]** | Chạy chỉ case này. |
| **[✎ Edit]** | Mở modal sửa JSON actions trực tiếp (bypass AI — edit của QA là final). |
| **[Re-translate]** | Re-run AI translator cho case này (dùng registry + game spec hiện tại). |
| **Detailed assertions** | Bảng rule + verdict + diff per rule. |
| **🔍 OCR Evidence (M/N)** | Show crop ảnh từng widget mỗi spin + OCR value. M/N = số pass / total. |
| **🔬 Parser Diagnostic** | Khi rule mismatch — show raw vs parsed value, color theo severity. |
| **📡 Network Capture (X spins / Y req)** | Bảng request/response. Có **`View full bodies →`** load chi tiết body. |
| **📋 Action Log** | Trace từng click thực tế: timestamp, element key, coord, before/after screenshot ref. |
| **📜 History Popup** | Khi case verify menu/history popup — show screenshot popup AI đã thấy. |
| **Case screenshot** | Toggle xem ảnh state cuối case. |
| **🎥 Case video** | Toggle video playback của case run (Playwright trace). |
| **🤖 AI Review / 🔍 Quick Diagnose** | Khi case fail. Quick Diagnose = heuristic only, free. AI Review = heuristic + AI classifier, ~$0.02–0.05/call. Cho ra root cause + optional patch. |
| **📝 Apply Patch** | Validate + apply patch (sau khi đã có review) + ghi audit log. |
| **🔁 Auto-Rerun Loop** | Apply patch → rerun → nếu fail tiếp → AI review nữa (max 3 iter). |

### Categories

Cases được group theo category (BET / SPIN / AUTOPLAY / BUY_BONUS / PAYOUT / UI / …). Mỗi group có header `▼ CATEGORY (N)`.

### Run Summary banner (sau khi Run All xong)

Khi run xong toàn bộ, panel summary hiện lên trên cùng case panel:

```
Run Summary — 18/24 passed · 4 failed · 2 skipped         [✕]
[Show all 4 failed]
▼ Mismatch table — 4 rows
  | Case          | Rule              | Expected | Actual |
  | …             | balance-match     | 1000     | 999.95 |
```

Click **`✕`** → dismiss (cũng clear pointer trong localStorage).

---

## 10. Panel: App Log

```
App Log · Dashboard ↔ Server                       [Clear]

[09:13:42] POST /api/qa/manual/start { url: '…', autoDiscover: false }
[09:13:54] ✓ session started, slug=vs20rnriches
[09:14:02] POST /api/qa/manual/deep-discover
[09:14:08] [discover] state=main, found 8 elements
…
```

Trace mọi API call frontend → server, kèm response status + timing. Dùng debug khi UI không phản hồi hoặc cần verify endpoint nào đang được gọi.

**[Clear]** wipe log (chỉ client-side).

---

## 11. Workflow chuẩn

### A. Onboard game mới từ zero (lần đầu)

```
1. /  → paste GAME_URL → [Start Session]
2. (Tự nhảy sang /game/<slug>)
3. Panel Registry → [Auto-Onboard]
   → Theo dõi Onboard Progress panel
   → ~30 phút – 1 tiếng
4. Khi xong: tất cả element verified, payout model calibrated
5. Panel OCR Regions → [🤖 AI Auto-Detect] → review + redraw nếu cần
6. Registered Games row → [Generate Cases]   (~30–90s)
7. Panel Test Cases → [Load Cases] → [Run All cases]
8. Sau khi xong: review Run Summary → fix các case fail
```

### B. Game đã có registry, token vừa expire

```
1. /  → row của game → [Resume]
   (HOẶC: trên detail page, Save URL mới rồi Start)
2. Nếu token mới → bấm Save trên row Registered Games
3. Panel Test Cases → [Run All cases]
```

### C. UI game thay đổi (ad-hoc Discover lại)

```
1. Resume session
2. Panel Registry → [Deep Discover (AI)]   (~5–15 phút)
3. Panel Discovery Snapshots → View → verify markers
4. Panel Registry → [Probe Pending] nếu có pending
5. Test lại từng case ảnh hưởng bằng [Run] per row
```

### D. Statistical RTP only (không cần case)

```
1. /  → Open game (không cần Run All)
2. Registered Games row → set spins=10000 → [Run Stats]
3. Theo dõi App Log + report cuối cùng
```

### E. Fix case fail bằng AI Auto-Rerun

```
1. Panel Test Cases — case nào fail → expand
2. Bấm [🤖 AI Review]  (~$0.02–0.05)
3. Review patch đề xuất
4. [🔁 Auto-Rerun Loop] → apply + rerun max 3 lần
5. Hoặc bấm [✎ Edit] tự sửa actions JSON
```

---

## 12. Troubleshooting

### Dashboard không load

- Verify server đang chạy (`http://localhost:3200/dashboard` mở được).
- Port 3200 bị chiếm → `lsof -i :3200`.

### Start session timeout (10–30s đáng lẽ là OK, đợi > 60s không xong)

- Token URL hết hạn → 401/403 khi load game → Playwright vẫn mở nhưng game không vào main → check App Log.
- Sửa URL trên Registered Games row → [Save] → bấm Resume lại.

### Buttons disabled (xám)

- Tất cả button Discover / OCR / Add yêu cầu có **session live**. Nếu chưa Start → button disabled.
- Kiểm tra `sessionInfo` (panel New / Active Session) — phải show slug + running state.

### Deep Discover dừng giữa chừng

- AI calls budget hoặc depth cap → check App Log line cuối.
- Bấm lại Deep Discover sẽ resume từ state cuối cùng đã hash.

### Probe Pending verify hết thành rejected

- Element thật sự không click được (overlay block, hoặc coord sai).
- Try [Pick] lại bằng screenshot tươi rồi probe lại.

### "Generate Cases" trả 504 nhưng không có toast lỗi

- Đây là proxy timeout, server vẫn chạy. Dashboard tự poll `/status` đến 30 phút.
- Quan sát App Log dòng `polling… Ns elapsed (server still running)`.

### Run All bỏ qua nhiều case (skipped)

- Case có 0 actions / có `skipReason` → [Re-translate Skipped] hoặc fix root cause:
  - Thiếu element trong registry → Add hoặc Discover
  - Thiếu OCR region → Define bbox
  - Thiếu payout model → Calibrate Payout

### Run All đứng lâu giữa 2 case

- Đang đợi game settle về main. Max wait = 90s default.
- Bật **behavioral probe** trong Run All settings cho game khó detect "on main" — tốn 1 spin/case nhưng chắc chắn.

### OCR widget output sai value

- Bbox bao thiếu hoặc bao thừa số → [Redraw] cho khít hơn.
- Test ngay bằng [Test OCR] sau khi redraw.

### Case fail với `payout-integrity` mặc dù logic đúng

- Payout model chưa calibrate → bấm [Calibrate Payout].
- Đã calibrate nhưng game cập nhật paytable → calibrate lại.

### "Stop & Save" không kết thúc Chrome

- Đợi 5–10s (Playwright shutdown). Nếu vẫn không xong → check process: `ps aux | grep playwright`.

### Toast lỗi `409 Conflict`

- Có operation đang chạy cho session đó (vd đang Discover mà bấm Run All) → đợi xong hoặc Cancel.

---

## TLDR — 30 giây

- `/` xem tất cả game → click card vào `/game/<slug>`.
- Game mới: **Auto-Onboard** (1 button làm hết Discover + Probe + Calibrate, mất 30p–1h).
- Định nghĩa OCR Regions (Draw bbox hoặc AI Auto-Detect) trước khi run case dùng `screen.*`.
- **Generate Cases** → **Load Cases** → **Run All cases**. Bật Auto-mode để auto-fix case fail confidence cao.
- Case fail → expand row → **🤖 AI Review** → **🔁 Auto-Rerun Loop**, hoặc **✎ Edit** sửa actions JSON tay.
- Mọi pipeline lớn (Auto-Onboard / Generate / Run All) có banner + Onboard Progress / Run Progress table real-time.

Đó là toàn bộ dashboard. Không cần CLI.
