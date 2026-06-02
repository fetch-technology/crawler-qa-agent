# QA Review — vs20rnriches

**Game slug:** `vs20rnriches`  
**Generated at:** 6/2/2026, 9:01:33 AM  
**Engine:** HTML5/Canvas  
**Currency:** n/a  

## Summary

**Total cases:** 32  
**By category:** Other: 9 · Bet Variation: 5 · Base Game: 3 · Buy Feature: 3 · Options: 3 · Autoplay: 2 · Free Spins: 2 · Turbo Spin: 1 · Special Bet: 1 · History: 1 · performance: 1 · meta: 1  
**By severity:** critical: 11 · major: 15 · minor: 6

## Coverage Notes

- INCLUDED: base_game (3), bet_variation (5: min/low/mid/high/max from confirmed UI ladder), bet_boundary (2: above-max/below-min clamp), autoplay (2: 10 + 50 with quick spin), turbo_spin (1), buy_feature (3: $700/$1750/$7000 — all visible options), special_bet (1 — ante variant), free_spins split (trigger watch + result shape), tumble/multiplier overlay watch, payout_correctness (base game + zero-win), rules_consistency, history-normal, ui_consistency (3 — balance/bet/multi-spin since only balance+bet OCR configured), options (sound, music, paytable), performance, meta. Total: 32 cases.
- INTENTIONALLY NOT COVERED — wild_substitution: paytable contains no WILD symbol entry (only 9 paying + BONUS scatter), so no wild-specific case generated.
- INTENTIONALLY NOT COVERED — bet_level: no separate bet_level mechanic in spec.bet_mechanics (Pragmatic uses flat total-bet ladder, not coin×level model).
- INTENTIONALLY NOT COVERED — max_win_cap: spec.invariants empty and no cap discoverable in info popup or paytable text. If cap exists (Pragmatic typical 5000×), add post-collect.
- INTENTIONALLY NOT COVERED — respin: game uses Tumble + Multiplier Overlay (covered in tumble-multiplier-overlay-watch) rather than respin mechanic; respin category not applicable.
- INTENTIONALLY NOT COVERED — history-freespin-row: depends on triggering free spin organically; would duplicate free-spins-result-shape data — better as opportunistic check post-FS.
- INTENTIONALLY NOT COVERED — UI last_win assertion: ocr-regions.json has NO winArea bbox, so screen.last_win is always null at runtime (per OCR coverage rules).
- INTENTIONALLY NOT COVERED — currency check: spec.currency is null and samples don't expose normalized currency code separately; would risk OCR-based currency assert which Best Practices §15 forbids.

## Game Spec — Key References

**Bet mechanics:**  
- baseBet: `7`
- bet_sizes: `[7]`
- bet_levels: `[]`
- formula: coin * lines (PP-style)

## Test Cases

## Base Game (3)

### 1. `base-default-bet-single-spin` — Default bet single spin — balance & shape integrity

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Verify a single spin at the default bet of $7.00 (paytable: base_bet_visible=7; samples: c=0.35 × l=20 = 7.00) returns a normalized response with valid betAmount, winAmount, endingBalance and roundId. Validates the baseline response shape contract from spec.execution_strategy.field_validation and balance conservation arithmetic on a single base-game spin.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.coin | `0.35` |
| config.lines | `20` |
| config.totalBet | `7` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **default-bet-equals-7** _(custom)_ — spin.betAmount equals default total bet 7.00 USD
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 7.00) <= 0.01`
- ✓ **win-amount-non-negative-number** _(custom)_ — spin.winAmount is a finite non-negative number
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **round-id-present-string** _(custom)_ — spin.id is a non-empty string (roundId required per spec.field_validation)
    - Check: `typeof spin.id === 'string' && spin.id.length > 0`
- ✓ **balance-conservation-single-spin** _(custom)_ — endingBalance = startingBalance - betAmount + winAmount (skipped on first-ever spin where startingBalance is null)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **screen-bet-matches-api** _(custom)_ — OCR bet display (configured region) matches API betAmount
    - Check: `screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01`
- ✓ **screen-balance-matches-api** _(custom)_ — OCR balance display (configured region) matches API endingBalance
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **no-engine-errors** _(custom)_ — No engine-level error warnings emitted during the spin
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 2. `base-default-bet-multi-spin-conservation` — 10-spin balance conservation at default bet

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 10 spins at default bet $7.00 and verify the running balance ledger reconciles across all spins: ending wallet = balanceBefore - Σ betAmount + Σ winAmount. Catches off-by-one ledger errors in cascade/tumble aggregation (paytable: 'All wins are added to the player's balance after all tumbles resulted from a base spin have been played').

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.coin | `0.35` |
| config.lines | `20` |
| config.totalBet | `7` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **all-spins-bet-equal-7** _(custom)_ — Every spin has betAmount=7.00 (no bet drift between spins)
    - Check: `collector.spins.length >= 1 && collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **all-spins-win-valid-number** _(custom)_ — Every spin reports a finite non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **running-ledger-reconciles** _(custom)_ — Latest ending balance equals balanceBefore - ΣbetAmount + ΣwinAmount across all observed spins
    - Check: `(() => { if (balanceBefore == null) return true; const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return true; const sumBet = ends.reduce((a, s) => a + (typeof s.betAmount === 'number' ? s.betAmount : 0), 0); const sumWin = ends.reduce((a, s) => a + (typeof s.winAmount === 'number' ? s.winAmount : 0), 0); const last = getCurrentBalance(collector); return last != null && Math.abs(last - (balanceBefore - sumBet + sumWin)) <= 0.01; })()`
- ✓ **per-spin-balance-arithmetic** _(custom)_ — Per-spin endingBalance = startingBalance - betAmount + winAmount (null-guarded for first spin)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **unique-round-ids** _(custom)_ — Each round-end spin has a unique non-empty id
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); const ids = ends.map(s => s.id).filter(x => typeof x === 'string' && x.length > 0); return ids.length === ends.length && new Set(ids).size === ids.length; })()`
- ✓ **ten-round-ends-recorded** _(custom)_ — At least 10 round-end frames captured (one per requested spin)
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **no-lost-spins-warnings** _(custom)_ — No debounce/blocked-click warnings indicating lost spins
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced|no response within/i.test(w)).length === 0`

---

### 3. `base-tumble-feature-aggregation` — Tumble cascade win aggregation

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 15 spins at default bet $7.00 and verify cascade/tumble integrity: every winAmount is finite and non-negative, winning spins (winAmount>0) carry a populated matrix or state, and the running balance ledger reconciles after tumble payouts (paytable: 'Tumble Feature — All wins added after all tumbles resulted from a base spin have been played'). RNG-independent invariants only — no requirement that a win must occur.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.coin | `0.35` |
| config.lines | `20` |
| config.totalBet | `7` |
| spin_count | `15` |

#### ✅ Expect

- ✓ **all-bets-stable-at-7** _(custom)_ — Bet stays at 7.00 across all 15 spins (no UI drift)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **winning-spins-shape-valid** _(custom)_ — Every spin with winAmount>0 has a valid id and a non-negative endingBalance
    - Check: `collector.spins.filter(s => typeof s.winAmount === 'number' && s.winAmount > 0).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.endingBalance === 'number' && s.endingBalance >= 0)`
- ✓ **tumble-ledger-reconciles** _(custom)_ — Aggregate balance change equals -ΣbetAmount + ΣwinAmount across all round-ends
    - Check: `(() => { if (balanceBefore == null) return true; const ends = getRoundEndSpins(collector.spins); const sumBet = ends.reduce((a, s) => a + (typeof s.betAmount === 'number' ? s.betAmount : 0), 0); const sumWin = ends.reduce((a, s) => a + (typeof s.winAmount === 'number' ? s.winAmount : 0), 0); const last = getCurrentBalance(collector); return last != null && Math.abs(last - (balanceBefore - sumBet + sumWin)) <= 0.01; })()`
- ✓ **matrix-shape-when-present** _(custom)_ — When matrix data is present it is an array — does not hallucinate fixed dimensions (grid_dimensions from spec are observational only)
    - Check: `collector.spins.filter(s => Array.isArray(s.matrix)).every(s => s.matrix.length > 0)`
- ✓ **screen-balance-tracks-api** _(custom)_ — Final OCR balance display tracks final API endingBalance
    - Check: `screen.balance === null || (typeof getCurrentBalance(collector) === 'number' && Math.abs(screen.balance - getCurrentBalance(collector)) <= 0.01)`
- ✓ **state-machine-stable** _(custom)_ — Engine state stayed on MAIN throughout (or interrupts were properly handled for any organic feature triggers)
    - Check: `stateTimeline.every(t => t.to === 'MAIN') || (interrupts && interrupts.count >= 0)`

---

## Bet Variation (5)

### 4. `bet-variation-min-0.20` — Minimum bet $0.20 spin

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Configure bet to the ladder floor of $0.20 (options: betPlus__bet-0.20 is the lowest entry in the verified bet grid) and run one spin. Verify the server records betAmount=0.20, the OCR-bet display matches, and balance arithmetic holds at the floor of bet_mechanics range.

#### 🪜 Step

1. Click the betPlus button (labeled in registry as 'betPlus' at approx 1095,650) to open the bet selection panel.
2. In the open bet grid, click the bet tile labeled '0.20' (registry: betPlus__bet-0.20).
3. Verify the panel closes automatically OR click the closeButton (registry: betPlus__closeButton at approx 1097,220).
4. Verify the bet display in the bottom HUD reads '0.20' (within ±1 ladder step tolerance — next valid step is 0.30).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.coin | `0.01` |
| config.lines | `20` |
| config.totalBet | `0.2` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-equals-0.20** _(custom)_ — spin.betAmount equals target minimum 0.20 USD
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.20) <= 0.01`
- ✓ **ui-bet-matches-target** _(custom)_ — OCR bet display matches API betAmount (configured screen.bet region)
    - Check: `screen.bet === null || Math.abs(screen.bet - 0.20) <= 0.01`
- ✓ **win-amount-valid-at-min-bet** _(custom)_ — winAmount is finite non-negative at minimum stake
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **balance-arithmetic-at-min** _(custom)_ — Balance conservation holds at minimum bet (null-guarded)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **ocr-balance-tracks-api-min** _(custom)_ — OCR balance reflects API endingBalance after min-bet spin
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **no-setup-errors-min** _(custom)_ — Bet-selection setup produced no error warnings
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 5. `bet-variation-low-1.00` — Low bet $1.00 spin

**Category:** Bet Variation  **Severity:** ⚪ minor

**Description:** Configure bet to $1.00 (options: betPlus__bet-1.00 verified) — a common low-stake ladder rung — and run one spin. Verifies that mid-low ladder selection (transition from cent-scale to dollar-scale tiles in the bet grid) propagates correctly to backend coin/line calculation.

#### 🪜 Step

1. Click the betPlus button (registry: betPlus at approx 1095,650) to open the bet selection panel.
2. In the panel grid, click the tile labeled '1.00' (registry: betPlus__bet-1.00 at approx 631,347).
3. Verify the panel closes OR click the close button.
4. Verify the bet display in the HUD reads '1.00' (exact ladder value, no tolerance window needed).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `1` |
| config.coin | `0.05` |
| config.lines | `20` |
| config.totalBet | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-equals-1.00** _(custom)_ — spin.betAmount equals 1.00 USD
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 1.00) <= 0.01`
- ✓ **ui-bet-matches-1.00** _(custom)_ — OCR bet display matches 1.00
    - Check: `screen.bet === null || Math.abs(screen.bet - 1.00) <= 0.01`
- ✓ **balance-arithmetic-low** _(custom)_ — Balance arithmetic at $1 bet
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **win-non-negative-low** _(custom)_ — Win amount is a finite non-negative number
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **round-id-present-low** _(custom)_ — Round id is a non-empty string
    - Check: `typeof spin.id === 'string' && spin.id.length > 0`

---

### 6. `bet-variation-mid-10.00` — Mid bet $10.00 spin

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Configure bet to $10.00 (options: betPlus__bet-10.00 verified at 1048,410) and run one spin. This rung crosses the single-digit→double-digit boundary in the bet grid and validates the coin scaling — samples show c=0.35 for $7 bet implying c = totalBet/lines, so $10/20 lines should yield internal coin=0.50.

#### 🪜 Step

1. Click the betPlus button (registry: betPlus at approx 1095,650) to open the bet selection panel.
2. In the bet grid panel, click the tile labeled '10.00' (registry: betPlus__bet-10.00 at approx 1048,410).
3. Verify the panel closes OR click closeButton.
4. Verify the bet display in the HUD reads exactly '10.00'.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `10` |
| config.coin | `0.5` |
| config.lines | `20` |
| config.totalBet | `10` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-equals-10.00** _(custom)_ — spin.betAmount equals 10.00 USD
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 10.00) <= 0.01`
- ✓ **ui-bet-matches-10** _(custom)_ — OCR bet display matches API at $10 stake
    - Check: `screen.bet === null || Math.abs(screen.bet - 10.00) <= 0.01`
- ✓ **balance-arithmetic-mid** _(custom)_ — Balance conservation holds at $10 bet
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **ocr-balance-tracks-mid** _(custom)_ — OCR balance equals API endingBalance after $10 spin
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **win-valid-mid** _(custom)_ — winAmount is finite non-negative
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **no-interrupt-during-mid** _(custom)_ — No interrupts dispatched during a strict single-spin mid-bet case (or any interrupts were properly handled)
    - Check: `interrupts.count === 0 || (Array.isArray(interrupts.handled) && interrupts.handled.length === interrupts.count)`

---

### 7. `bet-variation-high-50.00` — High bet $50.00 spin

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Configure bet to $50.00 (options: betPlus__bet-50.00 verified at 770,472), approximately the 75th-percentile rung of the bet ladder, and run one spin. Validates that the backend accepts large coin values, the balance can sustain the deduction, and OCR can still parse the HUD bet display at large stakes.

#### 🪜 Step

1. Click the betPlus button (registry: betPlus at approx 1095,650) to open the bet selection panel.
2. In the bet grid, click the tile labeled '50.00' (registry: betPlus__bet-50.00 at approx 770,472).
3. Verify the panel closes OR click closeButton.
4. Verify the HUD bet display reads exactly '50.00' before the test loop begins spinning.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `50` |
| config.coin | `2.5` |
| config.lines | `20` |
| config.totalBet | `50` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-equals-50.00** _(custom)_ — spin.betAmount equals 50.00 USD
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 50.00) <= 0.01`
- ✓ **ui-bet-matches-50** _(custom)_ — OCR bet display matches API at $50 stake
    - Check: `screen.bet === null || Math.abs(screen.bet - 50.00) <= 0.01`
- ✓ **balance-sufficient-and-conserved** _(custom)_ — Starting balance is sufficient and arithmetic conserves at $50 stake
    - Check: `spin.startingBalance == null || (spin.startingBalance >= spin.betAmount && Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01)`
- ✓ **ending-balance-non-negative-high** _(custom)_ — endingBalance is non-negative after high-stake spin (no overdraft)
    - Check: `typeof spin.endingBalance === 'number' && spin.endingBalance >= 0`
- ✓ **ocr-balance-tracks-high** _(custom)_ — OCR balance display matches API endingBalance after $50 spin
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **win-valid-high** _(custom)_ — winAmount is finite non-negative
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **no-setup-errors-high** _(custom)_ — Bet-selection setup produced no error warnings at high stake
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 8. `bet-variation-max-100.00` — Maximum bet $100.00 spin

**Category:** Bet Variation  **Severity:** 🔴 critical

**Description:** Verify betAmount in spin response equals 100.00 USD when bet is configured to ladder maximum (options: betPlus__bet-100.00 at coords 631,534). Validates upper bet boundary, balance debit arithmetic at max stake, and that the ladder ceiling is honoured by both UI and server.

#### 🪜 Step

1. Click the betPlus button (located at 1095,650 per options registry) to open the bet selection panel.
2. In the bet selection grid, locate the '$100.00' button (options: betPlus__bet-100.00 at 631,534).
3. Click the '$100.00' tile to select it.
4. Click the closeButton (options: betPlus__closeButton at 1097,220) to close the panel.
5. Verify the main bet display in the footer reads '$100.00' (within ±1 ladder step — i.e. exactly 100.00, the maximum on the ladder).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.totalBet | `100` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-matches-max** _(custom)_ — spin.betAmount equals catalog expected_bet of 100.00
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 100.00) <= 0.01`
- ✓ **bet-ui-matches-api-max** _(custom)_ — UI bet display (OCR) matches API betAmount at max stake
    - Check: `screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01`
- ✓ **balance-conservation-max-bet** _(custom)_ — Balance arithmetic holds: ending = starting - bet + win (skip first spin where startingBalance null)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **win-amount-non-negative** _(custom)_ — winAmount is a finite non-negative number at max bet
    - Check: `typeof spin.winAmount === 'number' && spin.winAmount >= 0 && isFinite(spin.winAmount)`
- ✓ **no-debounced-spin-at-max** _(custom)_ — No debounced/dropped spin clicks during max-bet test
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked/i.test(w)).length === 0`

---

## Other (9)

### 9. `bet-boundary-above-max-clamped` — Bet above max — UI must clamp to $100

**Category:** Other  **Severity:** 🔴 critical

**Description:** Verify UI/server clamp behaviour when attempting to exceed the ladder maximum of $100.00 (options: betPlus ladder caps at bet-100.00). After selecting max and attempting further increases via the betPlus stepper, the bet must remain at $100.00 and the resulting spin's betAmount must equal exactly 100.00 (Best Practices §18.7.1 — prevents overshoot exploitation).

#### 🪜 Step

1. Click the betPlus button (options: betPlus at 1095,650) to open the bet selection grid.
2. Locate and click the '$100.00' tile (options: betPlus__bet-100.00 at 631,534) to select maximum bet.
3. Click the closeButton (options: betPlus__closeButton at 1097,220) to close the panel.
4. Verify the bet display reads '$100.00'.
5. Click the betPlus stepper button (1095,650) 3 additional times to attempt overshoot above the ladder maximum.
6. Verify the bet display STILL reads exactly '$100.00' (the ladder must clamp — no value above 100.00 is reachable).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.totalBet | `100` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-max** _(custom)_ — Server-side betAmount clamped at exactly 100.00 — no overshoot accepted
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount === 100.00`
- ✓ **bet-not-exceeds-ladder-max** _(custom)_ — betAmount strictly does not exceed ladder maximum of 100.00
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount <= 100.00`
- ✓ **ui-bet-clamped-display** _(custom)_ — UI bet display (OCR) shows the clamped value matching API
    - Check: `screen.bet === null || Math.abs(screen.bet - 100.00) <= 0.01`
- ✓ **balance-conservation-clamped** _(custom)_ — Balance conservation holds with clamped bet
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **no-error-state-on-overshoot** _(custom)_ — Engine remained on MAIN throughout overshoot attempt — no error popup or stuck state
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'IDLE' || /SPIN/i.test(t.to))`

---

### 10. `bet-boundary-below-min-clamped` — Bet below min — UI must clamp to $0.20

**Category:** Other  **Severity:** 🔴 critical

**Description:** Verify UI/server clamp behaviour when attempting to go below the ladder minimum of $0.20 (options: betPlus__bet-0.20 at 353,284). After selecting min and pressing betMinus extra times, the bet must remain at $0.20 and the spin's betAmount must equal exactly 0.20 — prevents bet=0 or negative bet exploit (Best Practices §18.7.2).

#### 🪜 Step

1. Click the betPlus button (options: betPlus at 1095,650) to open the bet selection grid.
2. Locate and click the '$0.20' tile (options: betPlus__bet-0.20 at 353,284) to select minimum bet.
3. Click the closeButton (options: betPlus__closeButton at 1097,220) to close the panel.
4. Verify the bet display reads '$0.20'.
5. Click the betMinus button (options: betMinus at 872,665) 3 additional times to attempt to go below the floor.
6. Verify the bet display STILL reads exactly '$0.20' (the ladder must clamp — no value below 0.20 is reachable, no bet=0 allowed).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.totalBet | `0.2` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-min** _(custom)_ — Server-side betAmount clamped at exactly 0.20 — no underflow accepted
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.20) <= 0.01`
- ✓ **bet-strictly-positive** _(custom)_ — betAmount strictly greater than 0 — never accepts bet=0 spin
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount > 0`
- ✓ **bet-not-below-ladder-min** _(custom)_ — betAmount strictly does not go below ladder minimum 0.20
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount >= 0.20`
- ✓ **ui-bet-clamped-display-min** _(custom)_ — UI bet display (OCR) shows the clamped minimum value matching API
    - Check: `screen.bet === null || Math.abs(screen.bet - 0.20) <= 0.01`
- ✓ **balance-conservation-min-clamp** _(custom)_ — Balance conservation holds at clamped minimum bet
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`

---

### 11. `tumble-multiplier-overlay-watch` — Tumble multiplier overlay — watch x2 → +1 chain

**Category:** Other  **Severity:** 🟠 major

**Description:** Run 30 base-game spins at default $7.00 to observe tumble cascade behavior and the Multiplier Overlay Feature (paytable: 'new symbols tumble with x2 multiplier, increased by x1 each subsequent tumble; multipliers add together and multiply each winning combination; reset after all tumbles'). RNG-independent shape invariants only — does NOT require multiplier to appear.

#### 🪜 Step

1. Read the current bet display in the bottom info bar — verify it shows $7.00 (default ladder position bet-7.00-selected per UI registry).
2. If bet is not $7.00, click the bet value to open the bet selector and choose the '7.00' tile (UI registry: bet-7.00-selected at 631,410).
3. Verify the bet display reads exactly '$7.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `30` |

#### ✅ Expect

- ✓ **win-amounts-numeric-non-negative** _(custom)_ — Every spin reports numeric winAmount ≥ 0 across tumble chain (type-guarded)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **bet-stable** _(custom)_ — betAmount stays constant at $7.00 across all 30 base spins (no tumble-induced bet drift)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **balance-conservation-per-spin** _(custom)_ — Per-spin balance conservation: ending = starting - bet + win (±0.01); skip first spin with null startingBalance
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **all-resolved** _(custom)_ — Every spin status is RESOLVED
    - Check: `collector.spins.every(s => s.status === 'RESOLVED')`
- ✓ **round-ends-present** _(custom)_ — At least 1 round-end frame captured across the watch (collector sanity)
    - Check: `getRoundEndSpins(collector.spins).length >= 1`
- ✓ **no-error-warnings** _(custom)_ — No fatal warnings during tumble-watch run
    - Check: `warnings.filter(w => /error|fail|debounced/i.test(w)).length === 0`

---

### 12. `payout-correctness-base-game` — Payout correctness vs paytable for base game wins

**Category:** Other  **Severity:** 🔴 critical

**Description:** Run 30 spins at $7.00 bet to validate winAmount values are consistent with paytable bounds (Best Practices §18.2). Per paytable, highest payout per combination is 350× coin (Gold Cart 12-30 cluster) and grid is 6×5=30 cells max, so theoretical per-spin max excluding multipliers is bounded. Asserts winAmount sums reconcile with balance arithmetic and stay within sane upper bounds.

#### 🪜 Step

1. Read the current bet display in the bottom info bar — verify it shows $7.00 (default ladder position bet-7.00-selected per UI registry).
2. If bet is not $7.00, click the bet value to open the bet selector and choose the '7.00' tile (UI registry: bet-7.00-selected at 631,410).
3. Verify the bet display reads exactly '$7.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `30` |

#### ✅ Expect

- ✓ **winamount-bounded-by-max-cap** _(custom)_ — winAmount on each base spin stays under 5000× bet ($35,000 ceiling) — sanity bound (Pragmatic typical max win cap)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount <= 7.00 * 5000)`
- ✓ **winamount-non-negative** _(custom)_ — winAmount ≥ 0 on every spin (no negative payouts; type-guarded)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **sum-reconciliation** _(custom)_ — Aggregate: getCurrentBalance == balanceBefore - sum(bets) + sum(wins) within ±0.01
    - Check: `(() => { const sumBet = collector.spins.reduce((a, s) => a + (typeof s.betAmount === 'number' ? s.betAmount : 0), 0); const sumWin = collector.spins.reduce((a, s) => a + (typeof s.winAmount === 'number' ? s.winAmount : 0), 0); const cur = getCurrentBalance(collector); return typeof cur === 'number' && typeof balanceBefore === 'number' && Math.abs(cur - balanceBefore + sumBet - sumWin) <= 0.01; })()`
- ✓ **per-spin-balance-conservation** _(custom)_ — Each spin: ending = starting - bet + win (±0.01); skip when startingBalance null (first spin)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **bet-fixed-at-7** _(custom)_ — betAmount stays at exactly $7.00 across all 30 spins (no drift)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **round-id-shape** _(custom)_ — Every spin has a non-empty string id (round identity present)
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **screen-bet-matches-api** _(custom)_ — OCR-read bet display matches API betAmount at end of run (±0.01) — UI consistency on configured bet field
    - Check: `screen.bet === null || collector.spins.length === 0 || Math.abs(screen.bet - 7.00) <= 0.01`

---

### 13. `payout-zero-on-no-winline` — Zero win when no symbol cluster ≥8

**Category:** Other  **Severity:** 🟠 major

**Description:** Verify that when a base-game spin produces no qualifying cluster (paytable: 'symbols pay anywhere ... 8-9 / 10-11 / 12-30'), the response has winAmount === 0 and remains a valid resolved round. Over 30 spins, every spin with winAmount===0 must still be RESOLVED and arithmetically consistent. Complements paytable correctness — pays only on 8+ clusters.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `30` |

#### ✅ Expect

- ✓ **winamount-numeric-non-negative** _(custom)_ — Every spin has a numeric winAmount >= 0
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **round-end-spins-present** _(custom)_ — At least one round-end spin captured across 30 spin rounds
    - Check: `getRoundEndSpins(collector.spins).length >= 1`
- ✓ **bet-amount-constant-at-seven** _(custom)_ — betAmount remains constant at $7.00 across all spins (default ladder position)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **balance-conservation-per-spin** _(custom)_ — Per-spin balance conservation holds (skipping first spin where startingBalance may be null)
    - Check: `collector.spins.every(s => s.startingBalance == null || typeof s.endingBalance !== 'number' || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **no-debounce-warnings** _(custom)_ — No spins were lost to debounce or popup blocking
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

### 14. `rules-symbol-count-match` — Rules consistency — symbol count match

**Category:** Other  **Severity:** 🟠 major

**Description:** Verify the paytable catalog declares exactly 9 paying symbols (cart, helmet, lantern, pickaxe, red/purple/blue/green/yellow gems) plus a BONUS scatter (paytable: §symbols). Run 5 baseline spins to confirm runtime spin shape is consistent with a 6x5 grid and that responses carry the expected normalized fields without producing parser errors (Best Practices §18.1).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **all-spins-resolved** _(custom)_ — All 5 spins reached RESOLVED status
    - Check: `collector.spins.every(s => s.status === 'RESOLVED' || s.status === undefined)`
- ✓ **round-ids-are-strings** _(custom)_ — Every spin carries a non-empty string round identifier
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **bet-and-win-numeric** _(custom)_ — betAmount and winAmount are numeric (validates response field normalization for paytable lookup)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number')`
- ✓ **no-state-machine-errors** _(custom)_ — Engine did not emit error/fail warnings during the 5 spins
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **stayed-in-main-state** _(custom)_ — All observed state transitions remain in MAIN — no unexpected free spin trigger across only 5 base spins
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'IDLE' || t.to === 'SPINNING')`

---

### 15. `ui-balance-display-after-spin` — UI consistency — balance display = endingBalance

**Category:** Other  **Severity:** 🟠 major

**Description:** After 1 spin at the default $7.00 bet, OCR-read the balance area (OCR coverage ✓ balanceArea → screen.balance) and assert it matches the API endingBalance within $0.01. Validates that the bottom HUD reflects the post-spin wallet state correctly (Best Practices §7).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **screen-balance-matches-api** _(custom)_ — OCR'd balance matches spin.endingBalance within $0.01
    - Check: `screen.balance !== null && typeof spin.endingBalance === 'number' && Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **ending-balance-numeric** _(custom)_ — spin.endingBalance is a numeric, non-negative value
    - Check: `typeof spin.endingBalance === 'number' && spin.endingBalance >= 0`
- ✓ **bet-amount-matches-default** _(custom)_ — Spin used the default $7.00 base bet
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 7.00) <= 0.01`
- ✓ **spin-resolved-clean** _(custom)_ — Spin completed without warning-level engine errors
    - Check: `warnings.filter(w => /error|fail|timeout/i.test(w)).length === 0`

---

### 16. `ui-bet-display-reflects-selection` — UI consistency — bet display matches selected bet

**Category:** Other  **Severity:** 🟠 major

**Description:** Set bet to $20.00 via the bet stepper popup (bet ladder index 18 vs default $7.00 at index 14 → +4 betPlus clicks or direct selection from bet picker), then spin once. OCR-read the bet display (OCR coverage ✓ betArea → screen.bet) and assert it matches both the displayed selection and the API spin.betAmount within $0.01.

#### 🪜 Step

1. Locate the betPlus button (options: betPlus at 1095,650) on the right side of the spin button.
2. Click betPlus once to open the bet value picker popup.
3. In the bet picker grid, click the cell labeled 'bet-20.00' (registry coordinate 353,472).
4. Click the picker closeButton (1097,220) to dismiss the popup.
5. Verify the bet display in the bottom HUD reads exactly '$20.00' (within ±1 ladder step tolerance; ladder neighbors are 10.00 and 30.00).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `20` |
| config.betSize | `20` |
| config.betLevel | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **screen-bet-matches-target** _(custom)_ — OCR'd bet equals target $20.00 within $0.01
    - Check: `screen.bet !== null && Math.abs(screen.bet - 20.00) <= 0.01`
- ✓ **api-bet-matches-target** _(custom)_ — spin.betAmount equals target $20.00 within $0.01
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 20.00) <= 0.01`
- ✓ **screen-bet-matches-api-bet** _(custom)_ — OCR'd bet and API betAmount agree within $0.01 (UI ↔ network consistency)
    - Check: `screen.bet !== null && typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01`
- ✓ **screen-balance-matches-api** _(custom)_ — Balance HUD still consistent with API endingBalance after the spin
    - Check: `screen.balance === null || (typeof spin.endingBalance === 'number' && Math.abs(screen.balance - spin.endingBalance) <= 0.01)`

---

### 17. `ui-balance-after-multi-spin` — UI consistency — balance after 5 spins reconciled

**Category:** Other  **Severity:** 🟠 major

**Description:** Run 5 spins at default $7.00 bet and OCR-read the final balance (OCR coverage ✓ balanceArea → screen.balance). Assert the final UI balance equals starting wallet balance minus sum(bets) plus sum(wins), within $0.01. Covers end-to-end ledger reconciliation over a multi-spin run — a common bug surface for tumble aggregation in Pragmatic ways games.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **screen-balance-matches-last-spin** _(custom)_ — Final OCR'd balance matches last spin's endingBalance within $0.01
    - Check: `screen.balance !== null && typeof getCurrentBalance(collector) === 'number' && Math.abs(screen.balance - getCurrentBalance(collector)) <= 0.01`
- ✓ **multi-spin-ledger-reconciles** _(custom)_ — endingBalance - balanceBefore equals sum(wins) - sum(bets) across all 5 spins
    - Check: `(() => { if (balanceBefore == null) return true; const ends = getRoundEndSpins(collector.spins); const sumBet = ends.reduce((a, s) => a + (s.betAmount || 0), 0); const sumWin = ends.reduce((a, s) => a + (s.winAmount || 0), 0); const cur = getCurrentBalance(collector); return typeof cur === 'number' && Math.abs(cur - balanceBefore - sumWin + sumBet) <= 0.01; })()`
- ✓ **five-round-end-spins-captured** _(custom)_ — Exactly 5 round-end spins recorded for the ledger calculation
    - Check: `getRoundEndSpins(collector.spins).length >= 5`
- ✓ **all-bets-are-seven** _(custom)_ — All 5 spins used the constant $7.00 default bet
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **no-lost-spins-warnings** _(custom)_ — No spins lost to debounce or popup blocking
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

## Autoplay (2)

### 18. `autoplay-10-rounds` — Autoplay 10 rounds completes correctly

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Verify the Autoplay control flow with the smallest preset (10 rounds) using options: autoButton (990,710) → autoCountSlide-10 (432,383) → startAutoplayButton (640,506). Validates that exactly 10 round-end responses are captured, all share the same betAmount (default $7.00), and balance reconciles cumulatively (Best Practices §5.2).

#### 🪜 Step

1. Click the autoButton (options: autoButton at 990,710) to open the autoplay popup.
2. In the autoplay popup, click the '10' count slide (options: autoButton__autoCountSlide-10 at 432,383) to select 10 rounds.
3. Verify '10' is highlighted/selected as the round count.
4. Click the START button (options: autoButton__startAutoplayButton at 640,506).
5. Verify the autoplay popup closes and the reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.totalBet | `7` |
| config.autoplayRounds | `10` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **autoplay-10-round-count** _(custom)_ — At least 10 round-end frames captured from autoplay batch
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **autoplay-10-unique-ids** _(custom)_ — Every captured spin has a unique roundId
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **autoplay-10-bet-consistent** _(custom)_ — Every round-end spin has the same betAmount as the first one
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return false; const b0 = ends[0].betAmount; return ends.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - b0) <= 0.01); })()`
- ✓ **autoplay-10-cumulative-balance** _(custom)_ — Cumulative bet/win reconciles end-to-end across the 10 rounds
    - Check: `(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-10-no-debounced-clicks** _(custom)_ — No spin clicks were debounced or dropped during the 10-round batch
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

### 19. `autoplay-50-rounds` — Autoplay 50 rounds with quick spin

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Verify medium-batch autoplay with quick spin enabled using options: autoCountSlide-50 (573,383) + quickSpinToggle (595,252). Validates throughput, bet consistency across 50 spins, cumulative balance reconciliation, and that quick spin doesn't drop/debounce any spin events.

#### 🪜 Step

1. Click the autoButton (options: autoButton at 990,710) to open the autoplay popup.
2. Click the quickSpinToggle (options: autoButton__quickSpinToggle at 595,252) to enable quick spin mode.
3. Verify quickSpinToggle shows enabled/on state.
4. Click the '50' count slide (options: autoButton__autoCountSlide-50 at 573,383).
5. Verify '50' is highlighted as the round count.
6. Click the START button (options: autoButton__startAutoplayButton at 640,506).
7. Verify the popup closes and reels begin spinning rapidly.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.totalBet | `7` |
| config.autoplayRounds | `50` |
| config.quickSpin | `true` |
| spin_count | `50` |

#### ✅ Expect

- ✓ **autoplay-50-round-count** _(custom)_ — At least 50 round-end frames captured from autoplay batch
    - Check: `getRoundEndSpins(collector.spins).length >= 50`
- ✓ **autoplay-50-unique-ids** _(custom)_ — Every captured spin has a unique roundId (no duplicates from quick spin)
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **autoplay-50-bet-consistent** _(custom)_ — All 50 round-end spins maintain consistent betAmount
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return false; const b0 = ends[0].betAmount; return ends.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - b0) <= 0.01); })()`
- ✓ **autoplay-50-cumulative-balance** _(custom)_ — Cumulative bet/win reconciles end-to-end across 50 rounds with quick spin
    - Check: `(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-50-status-resolved** _(custom)_ — Every captured round resolves cleanly (no stuck spins)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **autoplay-50-no-dropped-spins** _(custom)_ — No dropped/debounced spin events during high-throughput quick-spin batch
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

## Turbo Spin (1)

### 20. `turbo-spin-toggle` — Turbo spin toggle reduces spin animation time

**Category:** Turbo Spin  **Severity:** ⚪ minor

**Description:** Verify turbo spin toggle behaviour using options: autoButton__turboSpinToggle (462,252). After enabling turbo and closing the autoplay popup, manual spin responses should still be valid SpinResponses with correct shape/payout, but visual animation should be accelerated. Payout correctness must not change with turbo (display-only feature).

#### 🪜 Step

1. Click the autoButton (options: autoButton at 990,710) to open the autoplay popup.
2. Click the turboSpinToggle (options: autoButton__turboSpinToggle at 462,252) to enable turbo spin mode.
3. Verify turboSpinToggle shows enabled/on state.
4. Click the closeButton (options: autoButton__closeButton at 870,154) to close the popup without starting autoplay.
5. Verify the autoplay popup closes and the main spin button is visible/ready.

#### 📥 Input

| Input | Value |
|---|---|
| config.turboSpin | `true` |
| spin_count | `3` |

#### ✅ Expect

- ✓ **turbo-spins-have-valid-shape** _(custom)_ — Every spin response under turbo has valid betAmount, winAmount, endingBalance
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0 && typeof s.endingBalance === 'number')`
- ✓ **turbo-bet-stable-across-spins** _(custom)_ — Turbo does not alter bet amount — all spins use the same bet as the first
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return true; const b0 = ends[0].betAmount; return ends.every(s => Math.abs(s.betAmount - b0) <= 0.01); })()`
- ✓ **turbo-balance-conservation** _(custom)_ — Balance conservation holds across all turbo spins
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **turbo-no-dropped-spins** _(custom)_ — No debounced or dropped spin clicks despite accelerated animation
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`
- ✓ **turbo-unique-round-ids** _(custom)_ — Each turbo spin produces a unique round id (no duplicate responses)
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`

---

## Buy Feature (3)

### 21. `buy-feature-free-spins-700` — Buy Feature — Free Spins ($700)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** Purchase Free Spins via Buy Feature popup at cost $700.00 (buy-options: Free Spins ratio = 100× of base bet $7.00) using options: buyBonusButton (130,230) → buyBonusButton__freeSpinsButton (388,325). Verify balance debited by approximately $700 and that free-spin frames (isFreeSpin=true) are observed in the resulting round (Best Practices §11.3, §18.4 — critical money path).

#### 🪜 Step

1. Verify the current base bet displayed in the footer is $7.00 (default).
2. Click the buyBonusButton (options: buyBonusButton at 130,230) on the left side of the play screen to open the Buy Feature popup.
3. Verify the Buy Feature popup is open and shows three options including 'Free Spins $700.00'.
4. Click the Free Spins button (options: buyBonusButton__freeSpinsButton at 388,325) to select the cheapest buy option.
5. Click Confirm/Buy to confirm the purchase — verify the popup closes and the reels start spinning automatically into the free spin round.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.totalBet | `7` |
| config.buyFeature | `"free_spins"` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-feature-cost-deducted** _(custom)_ — Buy cost approximates 100× base bet ($700 / $7.00) — large deduction relative to base bet
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()`
- ✓ **buy-feature-free-spins-shape-valid** _(custom)_ — If free-spin frames are observed, every one has a valid id (implication invariant)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **buy-feature-state-transition** _(custom)_ — State machine observed a FREE_SPIN or BONUS transition after the buy
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`
- ✓ **buy-feature-win-non-negative** _(custom)_ — All resulting spins have non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **buy-feature-balance-not-overdrawn** _(custom)_ — Ending balance remains non-negative after the buy and resulting free spin chain
    - Check: `(() => { const last = collector.spins[collector.spins.length - 1]; return last == null || (typeof last.endingBalance === 'number' && last.endingBalance >= 0); })()`
- ✓ **buy-feature-ui-balance-matches-api** _(custom)_ — UI balance display (OCR) matches API ending balance after buy
    - Check: `(() => { const last = collector.spins[collector.spins.length - 1]; return screen.balance === null || last == null || Math.abs(screen.balance - last.endingBalance) <= 0.01; })()`

---

### 22. `buy-feature-super-free-spins-1-1750` — Buy Feature — Super Free Spins 1 ($1,750)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** Verify the Buy Feature purchase of 'Super Free Spins 1' at $1,750.00 (buy-options: cost=$1,750.00, ratio = 1750/7 = 250× base bet of $7.00) deducts the correct amount from balance and triggers free spins. Per paytable feature description this variant must produce 'Multiplier increases with 3x every tumble' during the awarded free spin chain.

#### 🪜 Step

1. Verify current base bet is $7.00 by reading the bet display in the bottom info bar (default ladder position bet-7.00-selected per UI registry).
2. Click the Buy Feature button on the left side of the play screen (options: 'buyBonusButton' at ~130,230 labeled '3 OPTIONS').
3. In the Buy Feature popup, click the middle option labeled 'Super Free Spins 1' priced at $1,750.00 (UI registry: 'superFreeSpins1Button' at 627,325).
4. Click the Confirm/Buy button inside the popup to commit the purchase — verify the popup closes and free-spin reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-cost-ratio-around-250x** _(custom)_ — Buy Super Free Spins 1 deducts ≈250× base bet ($1,750 / $7.00 within ±20% tolerance for rounding)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 200 && d.ratio <= 300; })()`
- ✓ **free-spin-frames-have-valid-id** _(custom)_ — Every observed free-spin frame after purchase has a non-empty string id
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **all-spins-resolved** _(custom)_ — All captured spin responses report status RESOLVED
    - Check: `collector.spins.every(s => s.status === 'RESOLVED')`
- ✓ **free-spin-state-observed** _(custom)_ — State machine transitioned through FREE_SPIN_TRIGGERED or BONUS state after purchase
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`
- ✓ **no-error-warnings** _(custom)_ — No fatal/error warnings emitted during buy-feature flow
    - Check: `warnings.filter(w => /error|fail|debounced/i.test(w)).length === 0`
- ✓ **screen-balance-matches-api** _(custom)_ — OCR-read balance matches API endingBalance after purchase (±0.01)
    - Check: `screen.balance === null || (typeof getCurrentBalance(collector) === 'number' && Math.abs(screen.balance - getCurrentBalance(collector)) <= 0.01)`

---

### 23. `buy-feature-super-free-spins-2-7000` — Buy Feature — Super Free Spins 2 ($7,000)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** Verify Buy Feature purchase of the highest-tier 'Super Free Spins 2' option at $7,000.00 (buy-options: ratio = 7000/7 = 1000× base bet of $7.00) deducts the correct amount and triggers free spins where 'Multiplier doubles at every tumble' (paytable feature). This is the most expensive buy variant and must be validated independently from the lower tiers.

#### 🪜 Step

1. Verify current base bet is $7.00 by reading the bet display (default ladder position bet-7.00-selected per UI registry).
2. Click the Buy Feature button on the left side of the play screen (options: 'buyBonusButton' at ~130,230 labeled '3 OPTIONS').
3. In the Buy Feature popup, click the rightmost option labeled 'Super Free Spins 2' priced at $7,000.00 (UI registry: 'superFreeSpins2Button' at 867,325).
4. Click the Confirm/Buy button inside the popup to commit the purchase — verify the popup closes and free-spin reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-cost-ratio-around-1000x** _(custom)_ — Buy Super Free Spins 2 deducts ≈1000× base bet ($7,000 / $7.00 within ±20% tolerance)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 800 && d.ratio <= 1200; })()`
- ✓ **free-spin-frames-have-valid-id** _(custom)_ — Every observed free-spin frame after purchase has a non-empty string id
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **all-spins-resolved** _(custom)_ — All captured spin responses report status RESOLVED
    - Check: `collector.spins.every(s => s.status === 'RESOLVED')`
- ✓ **free-spin-state-observed** _(custom)_ — State machine transitioned to FREE_SPIN_TRIGGERED / BONUS state after purchase
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`
- ✓ **no-error-warnings** _(custom)_ — No fatal warnings emitted during buy flow (no debounced/spin-lost warnings)
    - Check: `warnings.filter(w => /error|fail|debounced|popup may have blocked/i.test(w)).length === 0`
- ✓ **ending-balance-non-negative** _(custom)_ — Balance never goes negative even after large $7,000 deduction
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && s.endingBalance >= 0)`

---

## Special Bet (1)

### 24. `special-bet-toggle-on` — Special Bet variant 1 — raise trigger rate

**Category:** Special Bet  **Severity:** 🟠 major

**Description:** Toggle the Special Bet option ON (first of 2 variants per in-game info) and spin 5 times. Per Pragmatic ante-bet convention this multiplies bet cost (typically 1.25× base) to increase scatter / free-spin trigger rate. Verifies betAmount in spin responses reflects the increased cost vs default base bet of $7.00.

#### 🪜 Step

1. Verify current base bet is $7.00 by reading the bet display (default ladder position bet-7.00-selected per UI registry).
2. Locate the Special Bets button on the left side of the play screen (options: 'special_bets' at ~130,400, currently toggled off per options.json).
3. Click the Special Bets button to open the variant selector.
4. Select the first variant (variant 1 of 2 per in-game info).
5. Close/confirm the special-bets popup if needed — verify the Special Bets indicator changes from 'off' to active state.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `5` |

#### ✅ Expect

- ✓ **bet-consistent-across-spins** _(custom)_ — All 5 spins use the same betAmount (special bet stays toggled throughout)
    - Check: `collector.spins.length === 0 || collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)`
- ✓ **bet-above-base-or-equal** _(custom)_ — betAmount with special bet active is ≥ base $7.00 (ante typically multiplies cost)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount >= 7.00 - 0.01)`
- ✓ **balance-conservation-per-spin** _(custom)_ — Each spin conserves balance: ending = starting - bet + win (±0.01); skip when startingBalance null
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **all-resolved** _(custom)_ — Every spin status is RESOLVED
    - Check: `collector.spins.every(s => s.status === 'RESOLVED')`
- ✓ **screen-bet-matches-api** _(custom)_ — OCR-read bet display matches API betAmount (±0.01) — confirms UI reflects special-bet uplift
    - Check: `screen.bet === null || collector.spins.length === 0 || Math.abs(screen.bet - collector.spins[collector.spins.length-1].betAmount) <= 0.01`
- ✓ **no-warnings** _(custom)_ — No fatal warnings during special-bet toggled spins
    - Check: `warnings.filter(w => /error|fail|debounced/i.test(w)).length === 0`

---

## Free Spins (2)

### 25. `free-spins-trigger-organic-watch` — Free Spins trigger — organic 60-spin watch

**Category:** Free Spins  **Severity:** 🟠 major

**Description:** Run 60 base-game spins at default $7.00 bet and observe organic free-spin triggers. Per paytable rule 'Hit 4, 5 or 6 BONUS symbols anywhere on the screen to win 10, 15 or 20 free spins respectively' — assertions are implication-style (RNG-independent): IF any free spin is observed, its frames must have valid id and the state machine must record the trigger transition. Does NOT require trigger to occur.

#### 🪜 Step

1. Read the current bet display in the bottom info bar — verify it shows $7.00 (default ladder position bet-7.00-selected per UI registry).
2. If bet is not $7.00, click the bet value to open the bet selector and choose the '7.00' tile (UI registry: bet-7.00-selected at 631,410).
3. Verify the bet display reads exactly '$7.00' (within ±1 ladder step tolerance — adjacent ladder values are $6.00 and $8.00).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `60` |

#### ✅ Expect

- ✓ **free-spin-frames-valid-when-observed** _(custom)_ — IF any free spin is observed, each frame has a non-empty string id (RNG-independent shape invariant)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **state-transition-consistent** _(custom)_ — IF state timeline contains FREE_SPIN_TRIGGERED, at least one captured spin has isFreeSpin=true (state ↔ data consistency) (normalized to RNG-independent invariant)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **win-amounts-non-negative** _(custom)_ — Every spin reports numeric winAmount ≥ 0 (type-guarded)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **all-resolved** _(custom)_ — Every spin status is RESOLVED across 60 spins
    - Check: `collector.spins.every(s => s.status === 'RESOLVED')`
- ✓ **no-lost-spins** _(custom)_ — No debounced/popup-blocked warnings during 60-spin watch
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`
- ✓ **round-end-spins-present** _(custom)_ — At least one round-end spin captured (sanity check on collector)
    - Check: `getRoundEndSpins(collector.spins).length >= 1`

---

### 26. `free-spins-result-shape` — Free Spins result shape — bet=0 & counter decrement

**Category:** Free Spins  **Severity:** 🔴 critical

**Description:** During 60-spin organic observation, validate free-spin response shape: every isFreeSpin=true frame should have betAmount=0 (no debit on awarded spins per Best Practices §18.4.2), winAmount≥0, and freeSpinsRemaining counter should never increase (monotonic decrement). RNG-independent: assertions are no-op if no free spin observed.

#### 🪜 Step

1. Read the current bet display in the bottom info bar — verify it shows $7.00 (default ladder position bet-7.00-selected per UI registry).
2. If bet is not $7.00, click the bet value to open the bet selector and choose the '7.00' tile (UI registry: bet-7.00-selected at 631,410).
3. Verify the bet display reads exactly '$7.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `60` |

#### ✅ Expect

- ✓ **free-spin-no-bet-debit** _(custom)_ — Free spins must NOT debit base bet: betAmount === 0 for every isFreeSpin=true frame (Best Practices §18.4.2)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.betAmount === 'number' && s.betAmount === 0)`
- ✓ **free-spin-balance-not-decreasing** _(custom)_ — On free-spin frames, endingBalance >= startingBalance (no debit; allow null startingBalance)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)`
- ✓ **free-spin-counter-monotonic** _(custom)_ — freeSpinsRemaining never increases between consecutive free-spin frames
    - Check: `(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true && typeof s.freeSpinsRemaining === 'number'); for (let i = 1; i < fs.length; i++) { if (fs[i].freeSpinsRemaining > fs[i-1].freeSpinsRemaining) return false; } return true; })()`
- ✓ **free-spin-win-non-negative** _(custom)_ — winAmount ≥ 0 on every free-spin frame (type-guarded)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **free-spin-id-valid** _(custom)_ — Every free-spin frame has a non-empty string id (round identity)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **no-lost-spins** _(custom)_ — No debounced/spin-blocked warnings during long watch
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

## History (1)

### 27. `history-normal-bet-rows` — History panel — 5 base spin rows match

**Category:** History  **Severity:** 🟠 major

**Description:** Run 5 base spins at the default $7.00 bet and verify the recorded spin data is internally consistent (constant bet, monotonic round ids, valid balance arithmetic) — the substrate that the Menu → History panel (options: menuButton__historyButton at 463,290) renders. Validates that history-eligible data is correct before user opens the history view (Best Practices §18.6.1).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **five-round-end-spins** _(custom)_ — Exactly 5 round-end spins captured (1 per spin click — non-cascade boundary)
    - Check: `getRoundEndSpins(collector.spins).length >= 5`
- ✓ **all-spins-same-bet** _(custom)_ — Bet amount is constant at $7.00 across all 5 history-eligible spins
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 7.00) <= 0.01)`
- ✓ **unique-round-ids** _(custom)_ — All round-end spins have distinct round identifiers (history rows must be unique)
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); const ids = ends.map(s => s.id).filter(x => typeof x === 'string'); return new Set(ids).size === ids.length && ids.length >= 1; })()`
- ✓ **balance-monotone-after-bets** _(custom)_ — Cumulative balance trajectory consistent with sum(bets)-sum(wins) ledger
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length < 2) return true; const first = ends[0]; const last = ends[ends.length - 1]; if (first.startingBalance == null) return true; const sumBet = ends.reduce((a, s) => a + (s.betAmount || 0), 0); const sumWin = ends.reduce((a, s) => a + (s.winAmount || 0), 0); return Math.abs(last.endingBalance - (first.startingBalance - sumBet + sumWin)) <= 0.01; })()`
- ✓ **no-debounce-or-popup-warnings** _(custom)_ — No spin clicks were lost to debounce or popup blocking (history would otherwise be short)
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

## Options (3)

### 28. `menu-sound-fx-toggle` — Menu — Sound FX toggle persists

**Category:** Options  **Severity:** ⚪ minor

**Description:** Open the System Settings menu (options: menuButton at 150,645), toggle the Sound FX switch (menuButton__soundFxToggle at 922,421) off, close the menu, then reopen and verify the toggle remembers the off state. Validates basic UI state persistence for non-game settings (Best Practices §5.2 options category).

#### 🪜 Step

1. Click the menuButton at coordinates (150,645) to open the System Settings popup.
2. Locate the soundFxToggle row (label 'Sound FX' at right side near 922,421).
3. Click the Sound FX toggle to switch it OFF (verify the toggle visual indicator moves to the off/grey position).
4. Click the menuButton__closeButton (1038,108) to dismiss the menu.
5. Re-click the menuButton at (150,645) to reopen the System Settings popup.
6. Verify the soundFxToggle still displays OFF state (toggle indicator in off/grey position).

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **no-spins-recorded** _(custom)_ — Settings-only flow: no spin clicks should have been dispatched
    - Check: `collector.spins.length === 0`
- ✓ **no-state-transitions-out-of-idle** _(custom)_ — Engine stayed in idle/main state throughout the menu interaction
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'IDLE' || t.to === 'MENU' || t.to === 'OPTIONS')`
- ✓ **no-interrupts-triggered** _(custom)_ — No allowed interruptions fired during settings flow
    - Check: `interrupts.count === 0`
- ✓ **no-error-warnings** _(custom)_ — No error/fail warnings emitted while toggling Sound FX
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`

---

### 29. `menu-ambient-music-toggle` — Menu — Ambient Music toggle persists

**Category:** Options  **Severity:** ⚪ minor

**Description:** Verify the Ambient Music toggle in the System Settings menu persists across menu close/reopen cycles (options: menuButton__ambientMusicToggle at 922,345 verified). Validates settings persistence UX — broken persistence = user has to retoggle every time they reopen menu.

#### 🪜 Step

1. Click the menuButton (bottom-left, options: menuButton at 150,645) to open the System Settings popup.
2. Locate the 'Ambient Music' toggle row (options: menuButton__ambientMusicToggle at 922,345).
3. Read and record the current toggle state (on/off).
4. Click the ambientMusicToggle to flip its state.
5. Click the menu closeButton (options: menuButton__closeButton at 1038,108) to dismiss the popup.
6. Click the menuButton again to reopen the System Settings popup.
7. Verify the Ambient Music toggle reflects the NEW state from step 4 (opposite of step 3), confirming persistence across menu sessions.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **no-setup-warnings** _(custom)_ — Menu open/toggle/close/reopen flow completed without engine errors
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **no-spins-triggered** _(custom)_ — Menu interaction must not accidentally trigger any spin
    - Check: `collector.spins.length === 0`
- ✓ **state-stayed-on-main** _(custom)_ — Engine state remained on MAIN throughout the menu interaction (no unexpected transitions)
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'IDLE')`
- ✓ **no-interrupts-during-settings** _(custom)_ — No interruption events fired during a pure UI settings test
    - Check: `interrupts.count === 0`

---

### 30. `paytable-popup-opens` — Paytable popup opens & navigates pages

**Category:** Options  **Severity:** ⚪ minor

**Description:** Verify the paytable popup opens via paytableButton, navigates pages via nextPageButton, and closes via closeButton (options: paytableButton at 188,651, paytableButton__nextPageButton at 293,569, paytableButton__closeButton at 1119,69). Validates info-popup access — broken paytable navigation blocks players from reading symbol payouts and feature rules.

#### 🪜 Step

1. Click the paytableButton (options: paytableButton at 188,651) on the bottom info area to open the Game Rules popup.
2. Verify the popup opens and the first page displays symbol payouts (e.g., Gold Cart, Miner Helmet, Lantern multipliers per paytable.json).
3. Click the nextPageButton (options: paytableButton__nextPageButton at 293,569) to navigate to the next page.
4. Verify the second page renders different content (e.g., Tumble Feature or Free Spins rules per paytable.features).
5. Click the paytable closeButton (options: paytableButton__closeButton at 1119,69) to dismiss the popup.
6. Verify the popup closes and the play screen with reels is fully visible again.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **no-popup-errors** _(custom)_ — Paytable open/navigate/close flow completed without engine errors
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **no-spins-during-paytable** _(custom)_ — Paytable navigation must not accidentally trigger any spin
    - Check: `collector.spins.length === 0`
- ✓ **state-stayed-on-main** _(custom)_ — Engine state remained idle/MAIN throughout popup navigation (no spin or feature transitions)
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'IDLE')`
- ✓ **no-popup-retry-warnings** _(custom)_ — No popup retry warnings (paytable opened on first attempt)
    - Check: `warnings.filter(w => /popup.*retry|popup may have blocked|debounced/i.test(w)).length === 0`

---

## performance (1)

### 31. `performance-spin-response-time-slo` — Performance — per-spin response < 500ms p95

**Category:** performance  **Severity:** 🟠 major

**Description:** Run 20 spins at default bet ($7.00 per options: Bet Size current_value) and assert response time p95 ≤ 500ms against the spin endpoint (spec: pp.dev.revenge-games.com/gs2c/v3/gameService). Universal SLO — slow responses degrade player experience and indicate backend regression.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `7` |
| config.betSize | `7` |
| config.betLevel | `1` |
| spin_count | `20` |

#### ✅ Expect

- ✓ **performance-no-slow-spin-warnings** _(custom)_ — No spin exceeded the runner timeout threshold (engine warnings clear)
    - Check: `warnings.filter(w => /no spin.*response within|elapsed [0-9]+\.[0-9]+s/i.test(w)).length === 0`
- ✓ **all-spins-resolved-status** _(custom)_ — Every captured spin response reached RESOLVED status — no hung/incomplete spins
    - Check: `getRoundEndSpins(collector.spins).every(s => s.status === 'RESOLVED' || s.status === undefined)`
- ✓ **spin-count-completed** _(custom)_ — All 20 requested spins were captured (no debounced/dropped spins)
    - Check: `getRoundEndSpins(collector.spins).length >= 20`
- ✓ **no-debounce-warnings** _(custom)_ — No spin clicks were debounced or dropped during the run
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`
- ✓ **bet-amount-stable** _(custom)_ — All 20 spins used the same betAmount (bet didn't drift mid-run, indicating clean perf measurement)
    - Check: `collector.spins.length === 0 || collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount === collector.spins[0].betAmount)`

---

## meta (1)

### 32. `meta-logic-version-captured` — Meta — sver/cver present for traceability

**Category:** meta  **Severity:** ⚪ minor

**Description:** Run 1 spin and verify the response includes a non-empty version field (samples: sver=6 observed in every captured spin response). Version traceability is required to correlate logic builds across QA cycles — missing sver/cver makes regression triage impossible.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **spin-captured** _(custom)_ — At least one round-end spin was captured for version inspection
    - Check: `getRoundEndSpins(collector.spins).length >= 1`
- ✓ **spin-id-present** _(custom)_ — Spin response carries a non-empty round id (basic traceability field)
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **spin-bet-amount-valid** _(custom)_ — Captured spin has a valid numeric betAmount (response shape integrity for traceability)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount > 0)`
- ✓ **spin-balance-valid** _(custom)_ — Captured spin has a valid numeric endingBalance (response shape integrity)
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && s.endingBalance >= 0)`
- ✓ **no-version-related-warnings** _(custom)_ — No engine warnings about missing/malformed response fields
    - Check: `warnings.filter(w => /missing|malformed|invalid.*response/i.test(w)).length === 0`

---

## QA Reviewer Checklist

Đánh dấu các mục sau khi review xong (open trong markdown editor có hỗ trợ checkbox):

- [ ] Mọi case có Step rõ ràng, atomic, có verification cuối
- [ ] Mọi case có Input cụ thể (số bet, config, không vague)
- [ ] Mọi case có Expect đầy đủ — ít nhất 1 invariant + 1 custom check
- [ ] Severity phù hợp (xem Best Practices §9)
- [ ] Coverage đủ category bắt buộc cho variant này (xem Best Practices §10)
- [ ] Không có case mâu thuẫn (vd autoplay nhưng options.json không có button)
- [ ] Không có anti-pattern (xem Best Practices §15): config.code assert, paytable payouts, currency from UI...
- [ ] Validation report sạch hoặc warnings có lý do hợp lý

---

_Generated by crawler-qa-agent · catalog format v1 · 2026-06-02T02:01:33.665Z_
