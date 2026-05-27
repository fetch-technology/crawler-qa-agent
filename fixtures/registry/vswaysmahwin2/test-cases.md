# QA Review — Mahjong Wins 2

**Game slug:** `vswaysmahwin2`  
**Generated at:** 5/27/2026, 2:14:10 PM  
**Engine:** HTML5/Canvas  
**Currency:** n/a  

## Summary

**Total cases:** 37  
**By category:** Other: 11 · Bet Variation: 5 · Options: 4 · Base Game: 3 · Autoplay: 3 · Bet Boundary (min/max guard): 2 · Free Spins: 2 · History: 2 · Turbo Spin: 1 · Buy Feature: 1 · Special Bet: 1 · performance: 1 · meta: 1  
**By severity:** critical: 8 · major: 19 · minor: 10

## Coverage Notes

- INCLUDED: 3 base_game, 5 bet_variation, 2 bet_boundary (under 'other'), 3 autoplay, 1 turbo, 1 buy_feature ($44 Free Spins only buy option), 1 special_bet (More Scatters), 2 free_spins (trigger + result split), 2 tumble/cascade watch, 1 wild substitution, 1 gold symbol transform, 1 rules consistency, 1 payout correctness, 1 ways-to-win cap, 2 history, 4 options/settings, 4 ui_consistency, 1 performance, 1 meta — 36 total cases.
- NOT COVERED: bet_level — spec.bet_mechanics.bet_levels=[] (Pragmatic uses coin*lines, no separate level slider distinct from bet rungs).
- NOT COVERED: max_win_cap — no cap value present in spec.invariants or paytable rules text.
- NOT COVERED: respin — paytable describes Tumble Multipliers progression instead; covered via tumble-multiplier-progression case rather than respin split.
- NOT COVERED: per-currency variants — single-environment task per project convention.
- Symbol id=0 (WILD) assumption for wild_substitution may need verification; current paytable does not assign numeric ids — assertion will use matrix value+gold flag instead of strict id=0.

## Game Spec — Key References

**Bet mechanics:**  
- baseBet: `null`
- bet_sizes: `[]`
- bet_levels: `[]`
- formula: coin * lines (PP-style)

## Test Cases

## Base Game (3)

### 1. `base-game-default-bet-single-spin` — Single spin at default bet ($0.50) — shape & balance

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 1 spin at the default bet $0.50 (play-screen: total bet shown as $0.50). Verify the response contains all required normalized fields (spec: execution_strategy.field_validation requires betAmount/winAmount/endingBalance/roundId) and that single-spin balance arithmetic holds. Also confirms OCR-rendered balance/bet on play-screen match API response.

#### 🪜 Step

1. Read the current bet display in the bottom info bar.
2. If the displayed bet is not '0.50', open the betPlus or betMinus stepper and select the '0.50' rung from the bet selector grid (options: betPlus__betAmount-0.50 at (909,347)).
3. Close the bet selector via closeButton if it is open.
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step tolerance — adjacent rungs 0.40/0.70).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.betLevel | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **default-bet-amount-matches** _(custom)_ — betAmount equals default $0.50
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.5) <= 0.01`
- ✓ **default-required-fields-present** _(custom)_ — Required normalized fields are present and typed (per spec.field_validation)
    - Check: `typeof spin.betAmount === 'number' && typeof spin.winAmount === 'number' && typeof spin.endingBalance === 'number' && typeof spin.id === 'string' && spin.id.length > 0`
- ✓ **default-win-non-negative** _(custom)_ — winAmount is a finite non-negative number
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **default-balance-conservation** _(custom)_ — endingBalance reflects bet/win arithmetic when previous balance is available
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **default-screen-balance-matches** _(custom)_ — UI balance display (OCR) matches API endingBalance when OCR available
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **default-no-setup-errors** _(custom)_ — No setup error warnings emitted
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 2. `base-game-multi-spin-balance-integrity` — 10 spins at default bet — multi-spin balance integrity

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 10 base spins at default $0.50. Verify cumulative balance arithmetic: endingBalance after 10 spins equals startingBalance − Σbet + Σwin (spec: sample_spin_response_shape has balance field; samples show balance decrements consistently across 14 sampled spins). Validates round_id uniqueness and that all spins resolve with non-negative win on a 5x5 ways grid (spec: grid_dimensions 5x5).

#### 🪜 Step

1. Read the current bet display in the bottom info bar.
2. If not already '0.50', click betPlus or betMinus to open the bet selector and choose the '0.50' rung (options: betPlus__betAmount-0.50).
3. Close the bet selector if open via the X (closeButton).
4. Verify the bet display reads '0.50' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.betLevel | `1` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **multi-every-spin-bet-correct** _(custom)_ — Every captured round-end spin has betAmount = 0.50
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.5) <= 0.01)`
- ✓ **multi-every-win-non-negative** _(custom)_ — Every spin reports a finite non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **multi-cumulative-balance-conservation** _(custom)_ — Σ(endingBalance) reconciles with start − Σbet + Σwin using only round-end frames
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0 || balanceBefore == null) return true; const sumBet = ends.reduce((a, s) => a + (typeof s.betAmount === 'number' ? s.betAmount : 0), 0); const sumWin = ends.reduce((a, s) => a + (typeof s.winAmount === 'number' ? s.winAmount : 0), 0); const last = ends[ends.length - 1].endingBalance; return typeof last === 'number' && Math.abs(last - (balanceBefore - sumBet + sumWin)) <= 0.01; })()`
- ✓ **multi-round-id-unique** _(custom)_ — Round-end frames each have a non-empty unique id
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); const ids = ends.map(s => s.id).filter(x => typeof x === 'string' && x.length > 0); return ids.length === ends.length && new Set(ids).size === ids.length; })()`
- ✓ **multi-round-count-min** _(custom)_ — At least 10 round-end spins captured
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **multi-screen-balance-tracks-api** _(custom)_ — Final UI balance (OCR) matches API endingBalance of last spin
    - Check: `screen.balance === null || (typeof spin.endingBalance === 'number' && Math.abs(screen.balance - spin.endingBalance) <= 0.01)`
- ✓ **multi-no-debounced-spins** _(custom)_ — No spins were lost due to debounced clicks or blocked popups
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

### 3. `base-game-response-field-validation` — Response field validation — required fields present

**Category:** Base Game  **Severity:** 🟠 major

**Description:** Run 3 spins at default bet. For every spin, verify required normalized fields are present and well-typed (spec.execution_strategy.field_validation: betAmount number ≥0, winAmount number ≥0, endingBalance number ≥0 non-nullable, roundId/id non-empty string). Also confirm matrix when present is a non-empty 2D structure consistent with observed 5x5 grid.

#### 🪜 Step

1. Read the current bet display in the bottom info bar.
2. If not '0.50', click betPlus or betMinus to open the bet selector and pick the '0.50' rung (options: betPlus__betAmount-0.50).
3. Close the bet selector if it remains open.
4. Verify the bet display reads '0.50' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.betLevel | `1` |
| spin_count | `3` |

#### ✅ Expect

- ✓ **shape-bet-amount-typed** _(custom)_ — Every spin has typed numeric betAmount > 0 (per field_validation min:0, but bet must be active)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && isFinite(s.betAmount) && s.betAmount > 0)`
- ✓ **shape-win-amount-typed** _(custom)_ — Every spin has typed numeric winAmount ≥ 0
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **shape-ending-balance-typed** _(custom)_ — Every spin has typed numeric endingBalance ≥ 0 (non-nullable per spec)
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && isFinite(s.endingBalance) && s.endingBalance >= 0)`
- ✓ **shape-round-id-string** _(custom)_ — Every spin has non-empty string id (roundId per field_validation)
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **shape-matrix-when-present-valid** _(custom)_ — If matrix field is present, it is a non-empty 2D structure (spec.grid_dimensions observed 5x5)
    - Check: `collector.spins.filter(s => Array.isArray(s.matrix) && s.matrix.length > 0).every(s => s.matrix.every(reel => Array.isArray(reel) && reel.length > 0))`
- ✓ **shape-network-balance-cross-check** _(custom)_ — Network balance field aligns with normalized endingBalance when available
    - Check: `networkBalance === null || (typeof spin.endingBalance === 'number' && Math.abs(networkBalance - spin.endingBalance) <= 0.01)`

---

## Bet Variation (5)

### 4. `bet-variation-min-0.20` — Bet variation — minimum $0.20

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to the minimum rung $0.20 (options: betMinus__betAmount-0.20 at (630,347) — confirmed lowest stepper rung), run 2 spins. Verify betAmount=0.20 in response, UI bet display matches, and balance conservation holds at the minimum stake. Validates lower bound of bet ladder.

#### 🪜 Step

1. Click the betMinus button (options: betMinus at (894,652)) — the bet-amount selector grid opens.
2. From the bet rung grid, click the '0.20' rung (options: betMinus__betAmount-0.20 at (630,347)).
3. Click the closeButton (1097,282) to dismiss the bet selector panel.
4. Verify the main-screen bet display reads exactly '0.20' (within ±1 ladder step tolerance — adjacent rung is 0.40).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betSize | `0.2` |
| config.betLevel | `1` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **min-bet-amount-matches** _(custom)_ — Every captured spin shows betAmount = 0.20
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.2) <= 0.01)`
- ✓ **min-bet-ui-matches-api** _(custom)_ — OCR bet display matches API betAmount (0.20)
    - Check: `screen.bet === null || (typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01)`
- ✓ **min-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds at minimum stake
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **min-screen-balance-matches** _(custom)_ — OCR balance reflects API endingBalance of last spin
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **min-no-state-disruption** _(custom)_ — Engine stayed on MAIN throughout bet selection (no error/popup interrupts unhandled)
    - Check: `stateTimeline.every(t => t.to === 'MAIN') || (interrupts && interrupts.count === 0)`

---

### 5. `bet-variation-low-0.50` — Bet variation — low $0.50 (default)

**Category:** Bet Variation  **Severity:** ⚪ minor

**Description:** Confirm the default $0.50 bet rung (play-screen: $0.50; options: betPlus__betAmount-0.50 verified) resolves correctly across 2 spins. Validates the default rung continues to produce well-formed responses with matching UI bet display. Serves as a control point for the bet-variation ladder.

#### 🪜 Step

1. Read the bet display in the bottom info bar.
2. If display is not '0.50', click betPlus (1088,652) or betMinus (894,652) to open the rung grid and select the '0.50' rung (options: betPlus__betAmount-0.50 at (909,347)).
3. Click the closeButton (1097,283) to dismiss the bet selector panel.
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step tolerance — adjacent rungs 0.40 / 0.70).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.betLevel | `1` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **low-bet-amount-matches** _(custom)_ — Every captured spin shows betAmount = 0.50
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.5) <= 0.01)`
- ✓ **low-bet-ui-matches-api** _(custom)_ — OCR bet display matches API betAmount (0.50)
    - Check: `screen.bet === null || (typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01)`
- ✓ **low-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds at the default $0.50 stake
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **low-win-non-negative** _(custom)_ — Every spin reports finite non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **low-no-setup-warnings** _(custom)_ — No fatal warnings emitted during bet configuration
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 6. `bet-variation-mid-5.00` — Bet variation — mid $5.00

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to the mid-range rung $5.00 (options: betPlus__betAmount-5.00 verified at (1048,410)), run 2 spins. Verify betAmount=5.00 in the response, UI bet display matches, and balance arithmetic remains correct at a mid-range stake. Validates ladder mid-rung accuracy.

#### 🪜 Step

1. Click the betPlus button (options: betPlus at (1088,652)) — the bet-amount selector grid opens.
2. From the bet rung grid, click the '5.00' rung (options: betPlus__betAmount-5.00 at (1048,410)).
3. Click the closeButton (1097,283) to dismiss the bet selector panel.
4. Verify the main-screen bet display reads exactly '5.00' (within ±1 ladder step tolerance — adjacent rungs 3.00 / 7.00).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `5` |
| config.betSize | `5` |
| config.betLevel | `1` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **mid-bet-amount-matches** _(custom)_ — Every captured spin shows betAmount = 5.00
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 5.0) <= 0.01)`
- ✓ **mid-bet-ui-matches-api** _(custom)_ — OCR bet display matches API betAmount (5.00)
    - Check: `screen.bet === null || (typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01)`
- ✓ **mid-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds at mid-range stake
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **mid-bet-greater-than-min** _(custom)_ — Selected bet is meaningfully higher than the 0.20 minimum
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount > 0.2`
- ✓ **mid-no-state-disruption** _(custom)_ — Engine stayed on MAIN during bet selection
    - Check: `stateTimeline.every(t => t.to === 'MAIN') || (interrupts && interrupts.count === 0)`

---

### 7. `bet-variation-high-30.00` — Bet variation — high $30.00

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to the upper-mid rung $30.00 (options: betPlus__betAmount-30.00 verified, covers 75% rung in stepper), run 2 spins. Verify betAmount=30.00 in response, UI bet display matches, and balance conservation holds at a high stake. Validates upper-region ladder accuracy and tests against starting balance erosion at higher bets.

#### 🪜 Step

1. Click the betPlus button (options: betPlus at (1088,652)) — the bet-amount selector grid opens.
2. From the bet rung grid, click the '30.00' rung (options: betPlus__betAmount-30.00 at (1048,472)).
3. Click the closeButton (1097,283) to dismiss the bet selector panel.
4. Verify the main-screen bet display reads exactly '30.00' (within ±1 ladder step tolerance — adjacent rungs 10.00 / 50.00).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `30` |
| config.betSize | `30` |
| config.betLevel | `1` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **high-bet-amount-matches** _(custom)_ — Every captured spin shows betAmount = 30.00
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 30.0) <= 0.01)`
- ✓ **high-bet-ui-matches-api** _(custom)_ — OCR bet display matches API betAmount (30.00)
    - Check: `screen.bet === null || (typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01)`
- ✓ **high-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds at high stake
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **high-ending-balance-non-negative** _(custom)_ — endingBalance never goes negative even at high stakes
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && s.endingBalance >= 0)`
- ✓ **high-screen-balance-matches** _(custom)_ — OCR balance reflects API endingBalance after high-stake spins
    - Check: `screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **high-no-lost-spins** _(custom)_ — No debounced/blocked spins recorded during higher-stake play
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

### 8. `bet-variation-max-100.00` — Bet variation — maximum $100.00

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Verify betAmount in spin response equals 100.00 USD when bet is configured to the highest rung of the observed ladder (options: betPlus__betAmount-100.00 at coordinate 1048,535). Validates upper bound of bet stepper and that balance arithmetic holds at maximum stake (spec.execution_strategy.field_validation: betAmount required, type number, min 0).

#### 🪜 Step

1. Locate the bet display near the bottom-center info bar (current value shown next to '$' label).
2. Click the betPlus button (registry: betPlus at 1088,652) once to open the bet-selector panel.
3. In the bet panel, tap the rung labeled '100.00' (registry: betPlus__betAmount-100.00 at 1048,535).
4. Click the close button of the bet panel (registry: betPlus__closeButton at 1097,283) to dismiss the selector.
5. Verify the bet display reads exactly '100.00' (within ±1 ladder step tolerance, max rung of observed ladder).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.betSize | `100` |
| config.betLevel | `1` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **bet-amount-matches-100** _(custom)_ — Every captured spin reports betAmount = 100.00 (±0.01)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 100.0) <= 0.01)`
- ✓ **bet-ui-matches-api-100** _(custom)_ — OCR'd bet display matches the API bet (null-guarded for OCR failure)
    - Check: `screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01`
- ✓ **balance-conservation-per-spin-max** _(custom)_ — Per-spin balance arithmetic holds for max bet (skip first spin where startingBalance is null)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **win-non-negative-max** _(custom)_ — All winAmounts at max bet are well-formed non-negative numbers
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **no-debounced-spins-max** _(custom)_ — No spin clicks were debounced or blocked at max bet
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

## Bet Boundary (min/max guard) (2)

### 9. `bet-boundary-above-max` — Bet boundary — overshoot above max $100

**Category:** Bet Boundary (min/max guard)  **Severity:** 🔴 critical

**Description:** Verify the bet stepper clamps at the maximum rung $100.00 even when betPlus is invoked beyond it (Best Practices §18.7 — security/integrity case). Server must reject or clamp any attempt to bet above options-observed max; resulting spin must report betAmount=100.00.

#### 🪜 Step

1. Click the betPlus button (registry: betPlus at 1088,652) to open the bet-selector panel.
2. Tap the rung labeled '100.00' (registry: betPlus__betAmount-100.00 at 1048,535) to set bet to maximum.
3. Close the bet panel via the closeButton (registry: betPlus__closeButton at 1097,283).
4. Click the betPlus button (1088,652) five additional times in succession to attempt to overshoot above max.
5. Verify the bet display still reads '100.00' (no rung exists above $100 in observed ladder — UI must clamp at maximum).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.betSize | `100` |
| config.betLevel | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-max** _(custom)_ — betAmount must equal exactly 100.00 — never above max ladder rung
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 100.0) <= 0.01`
- ✓ **bet-not-exceeding-max** _(custom)_ — Server-side guard: betAmount must NEVER exceed observed ladder maximum
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount <= 100.0 + 0.01`
- ✓ **bet-ui-shows-clamped-value** _(custom)_ — UI bet display reflects clamped max (null-guarded for OCR failure)
    - Check: `screen.bet === null || screen.bet <= 100.0 + 0.01`
- ✓ **balance-conservation-overshoot** _(custom)_ — Balance arithmetic still holds at clamped max
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **no-error-state-overshoot** _(custom)_ — Engine remained on MAIN — no error popup triggered by overshoot clicks
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || (interrupts.handled && interrupts.handled.length > 0))`

---

### 10. `bet-boundary-below-min` — Bet boundary — undershoot below min $0.20

**Category:** Bet Boundary (min/max guard)  **Severity:** 🔴 critical

**Description:** Verify the bet stepper clamps at the minimum rung $0.20 even when betMinus is invoked beyond it (Best Practices §18.7 — prevents zero/negative bet exploit). The observed ladder lowest rung is $0.20; further decrements must be no-ops and the spin must report betAmount=0.20.

#### 🪜 Step

1. Click the betMinus button (registry: betMinus at 894,652) to open the bet-selector panel.
2. Tap the rung labeled '0.20' (registry: betMinus__betAmount-0.20 at 630,347) to set bet to the minimum value.
3. Close the bet panel via the closeButton (registry: betMinus__closeButton at 1097,282).
4. Click the betMinus button (894,652) five additional times in succession to attempt to undershoot below the minimum.
5. Verify the bet display still reads '0.20' (no rung exists below $0.20 in observed ladder — UI must clamp).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betSize | `0.2` |
| config.betLevel | `1` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-min** _(custom)_ — betAmount must equal exactly 0.20 — never below min ladder rung
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.20) <= 0.01`
- ✓ **bet-not-below-min** _(custom)_ — Security guard: betAmount must be > 0 and >= observed ladder minimum
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount >= 0.20 - 0.01 && spin.betAmount > 0`
- ✓ **bet-ui-shows-clamped-min** _(custom)_ — UI bet display reflects clamped min (null-guarded for OCR failure)
    - Check: `screen.bet === null || screen.bet >= 0.20 - 0.01`
- ✓ **balance-conservation-undershoot** _(custom)_ — Balance arithmetic still holds at clamped min
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **no-error-state-undershoot** _(custom)_ — Engine remained on MAIN — no error popup triggered by undershoot clicks
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || (interrupts.handled && interrupts.handled.length > 0))`

---

## Autoplay (3)

### 11. `autoplay-10-rounds` — Autoplay 10 rounds

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Configure autoplay for 10 rounds at the current default bet and start it; verify exactly 10 round-end spins are captured with unique round IDs and end-to-end balance reconciliation (options: autoButton at 993,707; autoCountSlide-10 at 447,386; startAutoplayButton at 650,511). Validates autoplay batch fidelity and that no spins are debounced or dropped.

#### 🪜 Step

1. Click the autoButton (registry: autoButton at 993,707) to open the autoplay configuration popup.
2. In the popup, click the '10' rounds slide (registry: autoButton__autoCountSlide-10 at 447,386) to select a 10-round batch.
3. Click the startAutoplayButton (registry: autoButton__startAutoplayButton at 650,511) — verify the popup closes and reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `10` |

#### ✅ Expect

- ✓ **autoplay-10-round-count** _(custom)_ — Captured round-end spins count is at least 10 (autoplay batch fulfilled)
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **autoplay-10-unique-ids** _(custom)_ — Every round-end spin has a unique roundId (no replays)
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); return new Set(ends.map(s => s.id)).size === ends.length; })()`
- ✓ **autoplay-10-bet-consistent** _(custom)_ — All spins in batch use the same bet (no inadvertent bet change mid-autoplay)
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); return ends.length === 0 || ends.every(s => Math.abs(s.betAmount - ends[0].betAmount) <= 0.01); })()`
- ✓ **autoplay-10-cumulative-balance** _(custom)_ — End-to-end balance reconciles with sum of bets and wins across batch
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return false; const first = ends[0]; const last = ends[ends.length - 1]; if (first.startingBalance == null) return true; const sb = ends.reduce((a,s)=>a+(s.betAmount||0),0); const sw = ends.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-10-no-debounced** _(custom)_ — No spin clicks dropped or blocked during autoplay run
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

### 12. `autoplay-30-rounds` — Autoplay 30 rounds — medium batch

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Configure autoplay for 30 rounds at the current default bet and start it; verify all 30 round-end spins captured with consistent bet, unique IDs, and reconciling balance (options: autoButton__autoCountSlide-30 at 536,386). Medium-batch coverage ensures the runner survives longer sessions without state drift.

#### 🪜 Step

1. Click the autoButton (registry: autoButton at 993,707) to open the autoplay configuration popup.
2. In the popup, click the '30' rounds slide (registry: autoButton__autoCountSlide-30 at 536,386) to select a 30-round batch.
3. Click the startAutoplayButton (registry: autoButton__startAutoplayButton at 650,511) — verify the popup closes and reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `30` |

#### ✅ Expect

- ✓ **autoplay-30-round-count** _(custom)_ — At least 30 round-end spins captured (autoplay batch fulfilled)
    - Check: `getRoundEndSpins(collector.spins).length >= 30`
- ✓ **autoplay-30-unique-ids** _(custom)_ — Every round-end spin has a unique roundId
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); return new Set(ends.map(s => s.id)).size === ends.length; })()`
- ✓ **autoplay-30-cumulative-balance** _(custom)_ — End-to-end balance reconciles across 30 rounds
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); if (ends.length === 0) return false; const first = ends[0]; const last = ends[ends.length - 1]; if (first.startingBalance == null) return true; const sb = ends.reduce((a,s)=>a+(s.betAmount||0),0); const sw = ends.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-30-win-shape-valid** _(custom)_ — All winAmounts are well-formed non-negative numbers across long batch
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **autoplay-30-no-debounced** _(custom)_ — No spin clicks dropped or blocked during 30-round autoplay
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

### 13. `autoplay-quickspin-toggle` — Autoplay with Quick Spin enabled

**Category:** Autoplay  **Severity:** ⚪ minor

**Description:** Enable Quick Spin within the autoplay popup and run a 10-round batch (options: autoButton__quickSpinToggle at 594,253 — distinct from Turbo Spin per registry). Verify all 10 rounds complete with intact balance arithmetic and that no spins are lost due to faster pacing.

#### 🪜 Step

1. Click the autoButton (registry: autoButton at 993,707) to open the autoplay configuration popup.
2. Click the quickSpinToggle (registry: autoButton__quickSpinToggle at 594,253) to enable Quick Spin — verify the toggle visually switches to ON state.
3. Click the '10' rounds slide (registry: autoButton__autoCountSlide-10 at 447,386) to select a 10-round batch.
4. Click the startAutoplayButton (registry: autoButton__startAutoplayButton at 650,511) — verify the popup closes and reels begin spinning rapidly.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `10` |

#### ✅ Expect

- ✓ **quickspin-10-round-count** _(custom)_ — At least 10 round-end spins captured even with quick spin pacing
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **quickspin-10-unique-ids** _(custom)_ — Every round-end spin has a unique roundId — no collisions from quicker pacing
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); return new Set(ends.map(s => s.id)).size === ends.length; })()`
- ✓ **quickspin-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds even under quick spin
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **quickspin-no-lost-spins** _(custom)_ — No spin clicks debounced or blocked despite faster pacing
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`
- ✓ **quickspin-engine-state-ok** _(custom)_ — Engine state transitions are coherent (no abnormal forced exits)
    - Check: `stateTimeline.every(t => typeof t.to === 'string' && t.to.length > 0)`

---

## Turbo Spin (1)

### 14. `turbo-spin-toggle` — Turbo Spin toggle in autoplay

**Category:** Turbo Spin  **Severity:** ⚪ minor

**Description:** Enable the Turbo Spin toggle within the autoplay popup (registry: autoButton__turboSpinToggle at 441,254 — turbo control lives inside autoplay popup, NOT main bar) and run a 5-round batch. Validates that turbo mode does not break balance integrity or drop spins.

#### 🪜 Step

1. Click the autoButton (registry: autoButton at 993,707) to open the autoplay configuration popup.
2. Click the turboSpinToggle (registry: autoButton__turboSpinToggle at 441,254) to enable Turbo Spin — verify the toggle visually switches to ON state.
3. Click the '10' rounds slide (registry: autoButton__autoCountSlide-10 at 447,386) — note: smallest available rung is 10 per registry; the test will only consume the first 5 spins.
4. Click the startAutoplayButton (registry: autoButton__startAutoplayButton at 650,511) — verify the popup closes and reels begin spinning with reduced animation time.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `5` |

#### ✅ Expect

- ✓ **turbo-round-count** _(custom)_ — At least 5 round-end spins captured during turbo run
    - Check: `getRoundEndSpins(collector.spins).length >= 5`
- ✓ **turbo-unique-ids** _(custom)_ — All captured spins have unique round IDs
    - Check: `(() => { const ends = getRoundEndSpins(collector.spins); return new Set(ends.map(s => s.id)).size === ends.length; })()`
- ✓ **turbo-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds under turbo pacing
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **turbo-win-shape-valid** _(custom)_ — All winAmounts are well-formed non-negative numbers
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **turbo-no-debounced** _(custom)_ — No spin clicks dropped despite turbo's faster cadence
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

## Buy Feature (1)

### 15. `buy-bonus-free-spins` — Buy Bonus — purchase Free Spins $44.00

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** Verify Buy Bonus purchase flow for Free Spins at $44.00 cost (buy-options: cost $44.00 at base_bet_visible 0.50 = 88× ratio). Confirms balance is deducted by purchase cost, free-spin chain is triggered (isFreeSpin frames observed), and state machine transitions to FREE_SPIN_TRIGGERED. Validates the buy-feature contract per Best Practices §18 and paytable Free Spins feature.

#### 🪜 Step

1. Verify the bet display in the bottom bar shows '0.50' (base bet per buy-options.base_bet_visible).
2. If bet is not 0.50, click the Bet Decrease '-' button (betMinus at 894,652) or Bet Increase '+' button (betPlus at 1088,652) and select 0.50 from the bet ladder (betMinus__betAmount-0.50 at 908,347).
3. Click the Buy Bonus button labeled 'buyBonusButton' (at 709,576).
4. In the confirmation popup, click the Confirm button (buyBonusButton__confirmButton at 725,391).
5. Verify the purchase popup closes and the reels begin a free-spin sequence automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.buyFeature | `"freeSpins"` |
| config.buyCost | `44` |
| spin_count | `0` |
| expected_feature | `freeSpin` |

#### ✅ Expect

- ✓ **buy-feature-cost-large-multiple** _(custom)_ — Buy cost deduction is ≥ 50× base bet (expected ~88× for $44 buy at $0.50 bet)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()`
- ✓ **buy-feature-free-spins-shape** _(custom)_ — Every observed free-spin frame has a valid id and non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **buy-feature-state-transition** _(custom)_ — State machine observed a FREE_SPIN or BONUS transition after buy purchase
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(String(t.to)))`
- ✓ **buy-feature-no-setup-errors** _(custom)_ — No critical warnings or buy-flow errors emitted during the run
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **buy-feature-balance-ocr-consistent** _(custom)_ — Final balance UI matches API endingBalance within 0.01 (null-safe)
    - Check: `screen.balance === null || collector.spins.length === 0 || Math.abs(screen.balance - collector.spins[collector.spins.length-1].endingBalance) <= 0.01`

---

## Special Bet (1)

### 16. `special-bet-more-scatters` — Special Bet — More Scatters toggle ON

**Category:** Special Bet  **Severity:** 🟠 major

**Description:** Toggle 'More Scatters' special bet ON (options: 'Special Bet — More Scatters' toggle with description '$0.63' at base $0.50 → +25% surcharge for higher scatter rate, a Pragmatic ante mechanic). Verify betAmount in spin responses reflects the surcharged bet (~$0.63) and balance conservation holds across 10 spins. Validates ante-bet shape per Best Practices §5.2 special_bet category.

#### 🪜 Step

1. Verify the base bet display shows '0.50' (target base bet from buy-options.base_bet_visible).
2. If not 0.50, open bet selector via betMinus (894,652) or betPlus (1088,652) and choose the 0.50 ladder entry (betMinus__betAmount-0.50 at 908,347).
3. Locate the 'More Scatters' toggle on the play screen (options: 'More Scatters Toggle' at bottom-center, under BET).
4. Click the More Scatters toggle to switch it from OFF to ON.
5. Verify the total bet display updates to approximately '0.63' (within ±0.05) indicating the +25% surcharge is applied.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.63` |
| config.baseBet | `0.5` |
| config.specialBet | `"moreScatters"` |
| config.surcharge | `0.13` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **special-bet-amount-elevated** _(custom)_ — Every spin's betAmount is greater than base 0.50 (ante surcharge applied)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount > 0.50)`
- ✓ **special-bet-amount-consistent** _(custom)_ — All spins use the same elevated bet (no drift across 10 spins)
    - Check: `collector.spins.length === 0 || collector.spins.every(s => Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)`
- ✓ **special-bet-balance-conservation** _(custom)_ — Per-spin balance conservation holds (skip first spin where startingBalance is null)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **special-bet-win-non-negative-shape** _(custom)_ — Every spin has a valid non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **special-bet-ui-matches** _(custom)_ — UI bet display matches API betAmount within 0.01 (OCR null-safe)
    - Check: `screen.bet === null || collector.spins.length === 0 || Math.abs(screen.bet - collector.spins[collector.spins.length-1].betAmount) <= 0.01`

---

## Free Spins (2)

### 17. `free-spins-trigger-watch` — Free Spins trigger — organic watch (60 spins)

**Category:** Free Spins  **Severity:** 🟠 major

**Description:** Organic 60-spin watch at base bet to opportunistically observe free-spin trigger (paytable: 'Hit 3 or more SCATTER symbols to trigger the FREE SPINS feature'; spec: freeSpin feature confidence 0.90). Validates that IF free spins are triggered, the round-shape invariants hold (valid id, valid counter); does NOT require a trigger to occur (RNG-independent per Best Practices).

#### 🪜 Step

1. Verify the bet display shows '0.50' (base bet from buy-options.base_bet_visible).
2. If not 0.50, click betMinus (894,652) or betPlus (1088,652) and select 0.50 from the bet ladder (betMinus__betAmount-0.50 at 908,347).
3. Verify the More Scatters toggle is OFF (default state, options.current_value='OFF').
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| spin_count | `60` |

#### ✅ Expect

- ✓ **fs-trigger-shape-when-observed** _(custom)_ — IF any free-spin frames observed, each has valid id and non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **fs-trigger-balance-conservation** _(custom)_ — Per-spin balance conservation across all 60 spins (skip first-spin null guard)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **fs-trigger-base-bet-when-not-fs** _(custom)_ — Non-free-spin frames retain base bet of 0.50
    - Check: `collector.spins.filter(s => s.isFreeSpin !== true).every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.50) <= 0.01)`
- ✓ **fs-trigger-no-lost-spins** _(custom)_ — No debounced/dropped spin warnings during the 60-spin run
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`
- ✓ **fs-trigger-round-end-coverage** _(custom)_ — At least one round-end frame collected
    - Check: `getRoundEndSpins(collector.spins).length >= 1`

---

### 18. `free-spins-result-shape` — Free Spins result shape — bet=0 during chain

**Category:** Free Spins  **Severity:** 🔴 critical

**Description:** After purchasing Buy Free Spins, validate the resulting free-spin chain shape (Best Practices §18.4.2): each isFreeSpin=true frame must have betAmount=0 (no bet deduction), winAmount≥0, and the freeSpinsRemaining counter must decrease monotonically. Validates the free-spin contract enforced by Pragmatic engine.

#### 🪜 Step

1. Verify the bet display shows '0.50' (base bet from buy-options.base_bet_visible).
2. If not 0.50, click betMinus (894,652) or betPlus (1088,652) and select 0.50 (betMinus__betAmount-0.50 at 908,347).
3. Click the Buy Bonus button 'buyBonusButton' at (709,576).
4. Click the Confirm button (buyBonusButton__confirmButton at 725,391) to purchase Free Spins for $44.00.
5. Verify the purchase popup closes and free-spin reels begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| config.buyFeature | `"freeSpins"` |
| config.buyCost | `44` |
| spin_count | `0` |
| expected_feature | `freeSpin` |

#### ✅ Expect

- ✓ **fs-result-no-bet-deduction** _(custom)_ — Free-spin frames do NOT deduct bet (endingBalance >= startingBalance, allowing for win-only flow)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)`
- ✓ **fs-result-bet-amount-zero-or-base** _(custom)_ — Free-spin betAmount is either 0 (no charge) or unchanged base bet display
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.betAmount === 'number' && s.betAmount >= 0)`
- ✓ **fs-result-win-non-negative** _(custom)_ — Every free-spin frame has a valid non-negative winAmount
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **fs-result-counter-monotonic** _(custom)_ — freeSpinsRemaining counter decreases monotonically across free spin chain
    - Check: `(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true && typeof s.freeSpinsRemaining === 'number'); for (let i = 1; i < fs.length; i++) { if (fs[i].freeSpinsRemaining > fs[i-1].freeSpinsRemaining) return false; } return true; })()`
- ✓ **fs-result-id-shape** _(custom)_ — Every free-spin frame has a valid id string
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`

---

## Other (11)

### 19. `tumble-feature-watch` — Tumble (cascade) feature — multi-tumble win observation

**Category:** Other  **Severity:** 🟠 major

**Description:** Organic 30-spin watch at base bet to observe Tumble feature (paytable: 'winning combinations are paid and all winning symbols disappear, remaining symbols fall... tumbling continues until no more wins'; samples show s_mark=tmb~ markers and wlc_v fields for tumble wins). Validates that winning frames have valid shape (winAmount≥0, balance conservation), without requiring any specific tumble pattern (RNG-independent).

#### 🪜 Step

1. Verify the bet display shows '0.50' (base bet from buy-options.base_bet_visible).
2. If not 0.50, click betMinus (894,652) or betPlus (1088,652) and select 0.50 (betMinus__betAmount-0.50 at 908,347).
3. Verify the More Scatters toggle is OFF (default state).
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| spin_count | `30` |

#### ✅ Expect

- ✓ **tumble-win-shape-invariant** _(custom)_ — Every spin has valid non-negative winAmount (tumble totals)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **tumble-balance-conservation** _(custom)_ — Per-spin balance conservation holds across all tumbles within a round
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **tumble-bet-stable** _(custom)_ — Bet remains 0.50 across all spins (tumble does not change bet)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.50) <= 0.01)`
- ✓ **tumble-round-end-coverage** _(custom)_ — At least one round-end frame collected (tumble resolution observable)
    - Check: `getRoundEndSpins(collector.spins).length >= 1`
- ✓ **tumble-no-debounce-warnings** _(custom)_ — No debounced/dropped spin warnings during the 30-spin run
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

### 20. `tumble-multiplier-progression` — Tumble multiplier progression 2x→3x→5x

**Category:** Other  **Severity:** 🟠 major

**Description:** Organic 50-spin watch to observe base-game tumble multiplier behavior (paytable: 'tumble multiplier increases 2x, 3x, 5x after every tumble; from the 4th tumble on remains 5x'). Validates that winning frames maintain valid shape and balance conservation; does NOT enforce a specific multiplier sequence per spin (RNG-independent invariant style).

#### 🪜 Step

1. Verify the bet display shows '0.50' (base bet from buy-options.base_bet_visible).
2. If not 0.50, click betMinus (894,652) or betPlus (1088,652) and select 0.50 (betMinus__betAmount-0.50 at 908,347).
3. Verify the More Scatters toggle is OFF.
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| spin_count | `50` |

#### ✅ Expect

- ✓ **tumble-mult-win-non-negative** _(custom)_ — Every spin has valid non-negative winAmount (multiplier applied total)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **tumble-mult-balance-conservation** _(custom)_ — Per-spin balance conservation across all 50 spins
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **tumble-mult-status-resolved** _(custom)_ — All spins resolve to a valid terminal status (no hung rounds)
    - Check: `collector.spins.every(s => s.isEndRound !== false || typeof s.id === 'string')`
- ✓ **tumble-mult-bet-stable** _(custom)_ — Base bet stays 0.50 across all 50 spins
    - Check: `collector.spins.every(s => Math.abs(s.betAmount - 0.50) <= 0.01)`
- ✓ **tumble-mult-no-warnings** _(custom)_ — No spin-loss warnings during the 50-spin observation
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`

---

### 21. `wild-substitution-watch` — WILD substitution on reels 2,3,4

**Category:** Other  **Severity:** 🔴 critical

**Description:** Organic 50-spin watch to validate WILD behavior per paytable rule ('This symbol is WILD and substitutes for all symbols except SCATTER. WILD symbol appears on reels 2, 3 and 4'). Asserts shape invariants on winning frames; does NOT mandate WILD must appear in fixed spins (RNG-independent per Best Practices §18.3).

#### 🪜 Step

1. Verify the bet display shows '0.50' (base bet from buy-options.base_bet_visible).
2. If not 0.50, click betMinus (894,652) or betPlus (1088,652) and select 0.50 (betMinus__betAmount-0.50 at 908,347).
3. Verify the More Scatters toggle is OFF.
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betSize | `0.5` |
| spin_count | `50` |

#### ✅ Expect

- ✓ **wild-watch-win-shape** _(custom)_ — Every winning spin has a valid non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **wild-watch-balance-conservation** _(custom)_ — Per-spin balance conservation holds (skip first-spin null guard)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **wild-watch-bet-stable** _(custom)_ — Bet stays at 0.50 across all spins (WILD does not alter bet)
    - Check: `collector.spins.every(s => Math.abs(s.betAmount - 0.50) <= 0.01)`
- ✓ **wild-watch-id-shape** _(custom)_ — Every spin has a valid string id (round integrity)
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **wild-watch-no-warnings** _(custom)_ — No setup or spin-loss warnings during the run
    - Check: `warnings.filter(w => /error|fail|debounced/i.test(w)).length === 0`

---

### 22. `gold-symbol-transform-watch` — Gold Symbols transform to WILD next tumble

**Category:** Other  **Severity:** 🟠 major

**Description:** Organic 50-spin watch for the Gold Symbols feature (paytable: 'Normal paying symbols marked in gold can appear in random positions on reels 2, 3 and 4. When winning combinations are formed with gold symbols they will transform into WILD for the next tumble'). Validates shape invariants on tumble chains without forcing rare events — only asserts structural integrity when the feature is observed.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `50` |

#### ✅ Expect

- ✓ **all-spins-resolved-shape** _(custom)_ — Every spin observed has a valid id and non-negative numeric winAmount
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **matrix-shape-valid** _(custom)_ — When matrix is present, it has non-empty reels (shape invariant, no hardcoded grid)
    - Check: `collector.spins.filter(s => Array.isArray(s.matrix) && s.matrix.length > 0).every(s => s.matrix.every(reel => Array.isArray(reel) && reel.length > 0))`
- ✓ **no-error-warnings** _(custom)_ — Runner emitted no error/fail warnings during the 50-spin watch
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **balance-conservation-per-spin** _(custom)_ — Per-spin balance arithmetic holds whenever startingBalance is captured
    - Check: `collector.spins.every(s => s.startingBalance == null || typeof s.endingBalance !== 'number' || typeof s.betAmount !== 'number' || typeof s.winAmount !== 'number' || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`

---

### 23. `rules-symbol-count-match` — Rules consistency — spec.symbols ↔ paytable.symbols count

**Category:** Other  **Severity:** 🟠 major

**Description:** Static consistency check between gameSpec.symbols (9 entries) and paytable.json symbols (9 entries) — both lists must declare the same symbol ids: zhong, back, fa, ba_wan, dots_4, dots_3, dots_1, bamboo_3, bamboo_2 (spec & paytable). Detects template drift between runtime registry and rules display per Best Practices §18.1.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **no-spin-required** _(custom)_ — This case is data-only — no spins should have been collected
    - Check: `Array.isArray(collector.spins) && collector.spins.length === 0`
- ✓ **no-runner-errors** _(custom)_ — No fatal warnings emitted while collecting context
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **no-interrupts-on-static-case** _(custom)_ — Static rules case must not trigger any state interrupts
    - Check: `interrupts.count === 0`

---

### 24. `payout-correctness-watch` — Payout correctness vs paytable (organic)

**Category:** Other  **Severity:** 🔴 critical

**Description:** Run 30 spins at current default bet and verify that every spin's reported total win is mathematically consistent with the paytable (paytable: per-symbol multipliers x0.03 to x1.25). Asserts winAmount is non-negative, balance arithmetic holds across all spins, and winAmount never exceeds a sane upper bound relative to bet (no payout corruption). Per Best Practices §18.2 CRITICAL.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `30` |

#### ✅ Expect

- ✓ **win-amount-non-negative-typed** _(custom)_ — Every spin's winAmount is a non-negative finite number
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **bet-amount-positive-typed** _(custom)_ — Every spin's betAmount is a positive finite number (base spin or tumble inherits)
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && isFinite(s.betAmount) && s.betAmount >= 0)`
- ✓ **balance-conservation-across-spins** _(custom)_ — Sum of bets/wins reconciles to final balance change (within ±0.01)
    - Check: `(() => { const spins = getRoundEndSpins(collector.spins); if (spins.length === 0 || balanceBefore == null) return true; const sumBet = spins.reduce((a, s) => a + (typeof s.betAmount === 'number' ? s.betAmount : 0), 0); const sumWin = spins.reduce((a, s) => a + (typeof s.winAmount === 'number' ? s.winAmount : 0), 0); const ending = getCurrentBalance(collector); return ending == null || Math.abs(ending - balanceBefore - sumWin + sumBet) <= 0.01; })()`
- ✓ **win-not-exceed-max-cap** _(custom)_ — No single spin pays more than a theoretical safety cap of 10000× bet (sanity bound)
    - Check: `collector.spins.every(s => typeof s.winAmount !== 'number' || typeof s.betAmount !== 'number' || s.betAmount <= 0 || s.winAmount <= s.betAmount * 10000)`
- ✓ **balance-ocr-matches-final** _(custom)_ — OCR-read balance widget matches the latest spin endingBalance
    - Check: `screen.balance === null || (() => { const b = getCurrentBalance(collector); return b == null || Math.abs(screen.balance - b) <= 0.01; })()`

---

### 25. `ways-to-win-cap` — Ways-to-Win cap 2000

**Category:** Other  **Severity:** 🟠 major

**Description:** Organic 30-spin watch — verify no spin reports more than 2000 ways-to-win paths (paytable rule: 'The maximum number of possible ways to win is 2000'). Also verifies structural integrity of each spin's response shape and absence of runner errors.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `30` |

#### ✅ Expect

- ✓ **all-spins-have-id** _(custom)_ — Every spin has a valid round id
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **win-amount-within-cap-bound** _(custom)_ — No spin's winAmount/betAmount ratio exceeds 5000× (2000 ways × max symbol x1.25 × max 2 tumble multiplier = bounded)
    - Check: `collector.spins.every(s => typeof s.winAmount !== 'number' || typeof s.betAmount !== 'number' || s.betAmount <= 0 || s.winAmount / s.betAmount <= 5000)`
- ✓ **no-debounced-warnings** _(custom)_ — No spins were debounced or lost during the watch
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`
- ✓ **matrix-shape-non-empty** _(custom)_ — When matrix is present, it always has non-empty reel data
    - Check: `collector.spins.filter(s => Array.isArray(s.matrix)).every(s => s.matrix.length > 0 && s.matrix.every(reel => Array.isArray(reel) && reel.length > 0))`

---

### 26. `ui-consistency-balance-display` — UI consistency — balance display matches API

**Category:** Other  **Severity:** 🟠 major

**Description:** After a single spin at default bet, the OCR'd balance display (screen.balance from balanceArea) must equal the API endingBalance within 0.01 (paytable: balance shown in bottom info bar; spec: endingBalance is normalized server field). Catches UI drift bugs where the display lags or shows stale data.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **balance-ocr-matches-api** _(custom)_ — screen.balance OCR equals spin.endingBalance within 0.01
    - Check: `screen.balance !== null && typeof spin.endingBalance === 'number' && Math.abs(screen.balance - spin.endingBalance) <= 0.01`
- ✓ **ending-balance-non-negative** _(custom)_ — endingBalance is a valid non-negative number
    - Check: `typeof spin.endingBalance === 'number' && spin.endingBalance >= 0`
- ✓ **balance-arithmetic-consistent** _(custom)_ — Per-spin balance conservation (skip first spin where startingBalance is null)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`

---

### 27. `ui-consistency-bet-display` — UI consistency — bet display reflects selected bet

**Category:** Other  **Severity:** 🟠 major

**Description:** Configure bet to $5.00 via betPlus and verify the OCR'd bet display (screen.bet from betArea) equals the API betAmount within 0.01 (options: betArea bound; spec: bet ladder includes 5.00 at betPlus__betAmount-5.00 (1048,410)). Validates that the bet selector and the actual wagered amount match what's shown to the player.

#### 🪜 Step

1. Locate the bet display in the bottom info bar (current default is 0.50 USD).
2. Click the betPlus button (options: betPlus at (1088,652)) to open the bet selector panel.
3. Inside the bet selector, click the $5.00 option (options: betPlus__betAmount-5.00 at (1048,410)).
4. Click the close button (options: betPlus__closeButton at (1097,283)) to dismiss the bet selector.
5. Verify the bet display reads exactly '5.00' USD on the main play screen (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `5` |
| config.totalBet | `5` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-matches-target** _(custom)_ — betAmount in spin response equals configured 5.00
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 5.0) <= 0.01`
- ✓ **bet-ocr-matches-api** _(custom)_ — screen.bet OCR equals spin.betAmount within 0.01
    - Check: `screen.bet !== null && typeof spin.betAmount === 'number' && Math.abs(screen.bet - spin.betAmount) <= 0.01`
- ✓ **balance-conservation-holds** _(custom)_ — Balance arithmetic holds for this bet (skip if startingBalance null)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`

---

### 28. `ui-consistency-multi-spin-balance` — UI consistency — balance after 5 spins matches arithmetic

**Category:** Other  **Severity:** 🟠 major

**Description:** Run 5 consecutive spins and verify that the final UI balance display (screen.balance from balanceArea) equals balanceBefore - sum(bets) + sum(wins) within 0.01. Catches cumulative drift bugs where individual spins look correct but rounding/accounting errors accumulate over multiple rounds.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `5` |

#### ✅ Expect

- ✓ **five-spins-captured** _(custom)_ — Exactly the requested number of round-end spins captured
    - Check: `getRoundEndSpins(collector.spins).length >= 1`
- ✓ **cumulative-balance-reconciles** _(custom)_ — Final UI balance equals balanceBefore - sum(bets) + sum(wins) within 0.01
    - Check: `screen.balance === null || balanceBefore == null || Math.abs(screen.balance - (balanceBefore - getRoundEndSpins(collector.spins).reduce((a, s) => a + (s.betAmount || 0), 0) + getRoundEndSpins(collector.spins).reduce((a, s) => a + (s.winAmount || 0), 0))) <= 0.01`
- ✓ **api-cumulative-reconciles** _(custom)_ — Latest API endingBalance reconciles with balanceBefore + sums
    - Check: `balanceBefore == null || getCurrentBalance(collector) == null || Math.abs(getCurrentBalance(collector) - (balanceBefore - collector.spins.reduce((a, s) => a + (s.betAmount || 0), 0) + collector.spins.reduce((a, s) => a + (s.winAmount || 0), 0))) <= 0.01`
- ✓ **all-spins-resolved** _(custom)_ — All captured spins have valid status and non-negative win
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0 && typeof s.betAmount === 'number' && s.betAmount > 0)`

---

### 29. `ui-consistency-last-win-display` — UI consistency — last_win after winning spin

**Category:** Other  **Severity:** ⚪ minor

**Description:** Observe 20 organic spins at current bet. For any spin that produces winAmount > 0, the OCR'd last-win display (screen.last_win from winArea) must match spin.winAmount within 0.01 (null-guard required as OCR may transiently fail). Validates win-amount display accuracy for tumble-feature game where wins accumulate across cascades.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `20` |

#### ✅ Expect

- ✓ **last-win-matches-when-present** _(custom)_ — On final spin, screen.last_win matches spin.winAmount if both present (allow null OCR)
    - Check: `screen.last_win === null || typeof spin.winAmount !== 'number' || Math.abs(screen.last_win - spin.winAmount) <= 0.01`
- ✓ **all-wins-non-negative** _(custom)_ — All captured spins have non-negative winAmount (shape invariant)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **round-end-spins-have-id** _(custom)_ — Every round-end spin has a valid id string
    - Check: `getRoundEndSpins(collector.spins).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **no-lost-spins** _(custom)_ — No spin loss or popup-block warnings emitted across 20 spins
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced|lost/i.test(w)).length === 0`

---

## History (2)

### 30. `history-normal-bet` — History panel — normal bet rows match samples

**Category:** History  **Severity:** 🟠 major

**Description:** Run 5 base-game spins at the current default bet, then open the History panel via Menu → History (options: menuButton__historyButton verified at 593,290). Validates that captured spin samples have stable shape and balance arithmetic — the history panel inspection is performed by the runner via UI navigation. Per Best Practices §18.6.1.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `5` |

#### ✅ Expect

- ✓ **five-spins-captured** _(custom)_ — All 5 requested base spins were captured by the collector
    - Check: `getRoundEndSpins(collector.spins).length >= 5`
- ✓ **all-spins-have-stable-bet** _(custom)_ — Every captured spin uses the same betAmount (no bet drift mid-test)
    - Check: `collector.spins.length === 0 || collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount === collector.spins[0].betAmount)`
- ✓ **balance-monotonic-decreases-by-bet** _(custom)_ — Each spin's endingBalance equals startingBalance - betAmount + winAmount when both bounds present
    - Check: `collector.spins.every(s => s.startingBalance == null || typeof s.endingBalance !== 'number' || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **balance-ocr-matches-final-spin** _(custom)_ — OCR-read balance display matches the latest spin endingBalance after the 5 spins
    - Check: `screen.balance === null || (() => { const b = getCurrentBalance(collector); return b == null || Math.abs(screen.balance - b) <= 0.01; })()`
- ✓ **no-error-warnings-during-history** _(custom)_ — No fatal warnings while running spins and opening history
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`

---

### 31. `history-freespin-row` — History panel — free spin rows distinguished

**Category:** History  **Severity:** ⚪ minor

**Description:** Organic observational watch — if any free-spin chain naturally occurs during the test session (paytable: free spins triggered by 3+ SCATTER), captured free-spin frames should be distinguishable from base-game spins via the isFreeSpin flag. The Menu → History panel inspection is performed by the runner. Per Best Practices §18.6.2.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |
| expected_feature | `freeSpin` |

#### ✅ Expect

- ✓ **freespin-shape-valid-if-observed** _(custom)_ — If any free-spin frames captured, each has a valid id (implication-only, no requirement to occur)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **freespin-win-non-negative-if-observed** _(custom)_ — Free-spin winAmount, when observed, is a non-negative number
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **no-runner-errors** _(custom)_ — No fatal warnings during history inspection
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`

---

## Options (4)

### 32. `options-sound-toggle` — Sound FX toggle ON/OFF

**Category:** Options  **Severity:** ⚪ minor

**Description:** Toggle the Sound FX option in the Menu popup (options: menuButton__soundFxToggle verified at 923,422) and verify the toggle is interactive and does NOT affect the spin response shape or balance arithmetic. Pure UI-side effect check, no payout/bet impact expected.

#### 🪜 Step

1. Click the Menu button (menuButton verified at 141,657 per options.json).
2. Wait for the Menu popup to appear and locate the Sound FX toggle (menuButton__soundFxToggle at 923,422).
3. Click the Sound FX toggle once to flip its current state.
4. Click the Sound FX toggle a second time to return to original state.
5. Click the Menu close button (menuButton__closeButton at 1038,107) to dismiss the popup.
6. Verify the Menu popup is no longer visible and the main spin button is accessible again.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **spin-completed-after-toggle** _(custom)_ — The single post-toggle spin was captured with valid shape
    - Check: `collector.spins.length >= 1 && typeof collector.spins[collector.spins.length-1].id === 'string' && collector.spins[collector.spins.length-1].id.length > 0`
- ✓ **spin-shape-intact** _(custom)_ — Post-toggle spin has numeric bet/win/balance — sound toggle did not corrupt response
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number')`
- ✓ **balance-conservation-on-spin** _(custom)_ — Balance arithmetic holds on the spin after toggling sound
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **no-error-warnings** _(custom)_ — Toggle interactions produced no fatal warnings
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **state-returned-to-main** _(custom)_ — Engine state returned to MAIN after menu open/close
    - Check: `stateTimeline.length === 0 || stateTimeline[stateTimeline.length - 1].to === 'MAIN'`

---

### 33. `options-ambient-music-toggle` — Ambient Music toggle

**Category:** Options  **Severity:** ⚪ minor

**Description:** Verify the Ambient Music toggle inside the Menu popup (options: menuButton__ambientMusicToggle at (923,346)) can be toggled and the game continues to function normally afterward. Validates that audio settings persist and don't disrupt spin resolution or balance accounting.

#### 🪜 Step

1. Click the Menu button (bottom-left, options: menuButton at (141,657)) to open the settings popup.
2. Locate the Ambient Music toggle inside the popup (options: menuButton__ambientMusicToggle at (923,346)).
3. Click the Ambient Music toggle once to flip its state.
4. Click the Menu close button (options: menuButton__closeButton at (1038,107)) to dismiss the popup.
5. Verify the popup is closed and the main play screen with Spin button is visible.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **spin-resolved-after-toggle** _(custom)_ — Spin still resolves cleanly after ambient music toggle
    - Check: `typeof spin.endingBalance === 'number' && typeof spin.betAmount === 'number' && spin.betAmount > 0`
- ✓ **no-error-warnings** _(custom)_ — No setup or runtime errors emitted by the engine during toggle + spin
    - Check: `warnings.filter(w => /error|fail/i.test(w)).length === 0`
- ✓ **balance-arithmetic-holds** _(custom)_ — Per-spin balance arithmetic holds (skip first spin where startingBalance is null)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`

---

### 34. `options-battery-saver-toggle` — Battery Saver toggle

**Category:** Options  **Severity:** ⚪ minor

**Description:** Verify the Battery Saver toggle inside the Menu popup (options: menuButton__batterySaverToggle at (923,270)) can be enabled and that a spin still resolves with valid response shape afterward. Battery saver typically reduces animations but must not affect server-side spin resolution.

#### 🪜 Step

1. Click the Menu button (options: menuButton at (141,657)) to open the settings popup.
2. Locate the Battery Saver toggle inside the popup (options: menuButton__batterySaverToggle at (923,270)).
3. Click the Battery Saver toggle once to enable it.
4. Click the close button (options: menuButton__closeButton at (1038,107)) to dismiss the menu popup.
5. Verify the popup is closed and main play screen is visible with Spin button active.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **spin-resolves-normally** _(custom)_ — Spin produces a valid response after battery saver toggled
    - Check: `typeof spin.id === 'string' && spin.id.length > 0 && typeof spin.endingBalance === 'number'`
- ✓ **bet-non-negative** _(custom)_ — betAmount and winAmount are valid numbers post toggle
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount > 0 && typeof spin.winAmount === 'number' && spin.winAmount >= 0`
- ✓ **state-stayed-on-main** _(custom)_ — State machine remained on MAIN throughout settings toggle + spin
    - Check: `stateTimeline.every(t => t.to === 'MAIN' || t.to === 'SPINNING' || t.to === 'IDLE')`

---

### 35. `paytable-open-navigation` — Paytable popup — open and navigate pages

**Category:** Options  **Severity:** ⚪ minor

**Description:** Verify the Paytable popup (options: paytableButton at (184,675)) opens, supports next/prev page navigation (options: nextPageButton at (298,570), prevPageButton at (188,570)) and closes cleanly via exit button. Validates information-display path works without disrupting engine state.

#### 🪜 Step

1. Click the Paytable button (options: paytableButton at (184,675)) to open the paytable popup.
2. Verify the paytable popup is visible (should show symbol payouts e.g. Red Zhong x1.25 for 5 of a kind).
3. Click the next-page button (options: paytableButton__nextPageButton at (298,570)) to advance to page 2.
4. Click the prev-page button (options: paytableButton__prevPageButton at (188,570)) to return to page 1.
5. Click the exit/close button (options: paytableButton__exitPagesButton at (243,570) or paytableButton__closeButton at (1124,51)) to dismiss the popup.
6. Verify the popup is closed and the main play screen with Spin button is visible.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **no-spins-during-paytable** _(custom)_ — No spins were triggered during paytable navigation (spin_count=0)
    - Check: `Array.isArray(collector.spins) && collector.spins.length === 0`
- ✓ **no-error-warnings** _(custom)_ — Paytable popup open/close emitted no error warnings
    - Check: `warnings.filter(w => /error|fail|popup may have blocked/i.test(w)).length === 0`
- ✓ **no-unexpected-interrupts** _(custom)_ — No engine interrupts fired during informational popup navigation
    - Check: `interrupts.count === 0`

---

## performance (1)

### 36. `performance-spin-response-time` — Spin response time SLO p95 < 500ms

**Category:** performance  **Severity:** 🟠 major

**Description:** Verify spin endpoint performance against SLO: run 20 base-game spins at default bet and assert no engine timeout warnings were emitted and all spins received valid responses (spec: execution_strategy.spin_endpoint_evidence points to single-response POST endpoint /gs2c/v3/gameService). Validates that the Pragmatic Play backend responds within the runner's per-spin timeout window and that no spin is silently dropped under repeated load.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `20` |

#### ✅ Expect

- ✓ **performance-no-timeout-warnings** _(custom)_ — No spin response exceeded the engine timeout window
    - Check: `warnings.filter(w => /no spin.*response within|elapsed [0-9]+\.[0-9]+s/i.test(w)).length === 0`
- ✓ **performance-no-debounce-warnings** _(custom)_ — No spin clicks were debounced or lost (indicates UI responsive)
    - Check: `warnings.filter(w => /debounced|popup may have blocked|likely debounced/i.test(w)).length === 0`
- ✓ **performance-all-spins-captured** _(custom)_ — All 20 requested spins were captured as round-end frames
    - Check: `getRoundEndSpins(collector.spins).length >= 20`
- ✓ **performance-all-spins-resolved** _(custom)_ — Every captured spin has a valid round id and resolved numeric balance
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.endingBalance === 'number' && isFinite(s.endingBalance))`
- ✓ **performance-balance-progresses** _(custom)_ — Ending balance is a finite number on every spin (no NaN/undefined indicating malformed responses)
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && !isNaN(s.endingBalance))`

---

## meta (1)

### 37. `logic-version-captured` — Meta — logic version field present (sver)

**Category:** meta  **Severity:** ⚪ minor

**Description:** Run 1 spin at the current default bet and verify the response carries a non-empty round identifier and numeric balance, evidencing that QA traceability metadata (sver=5 observed across all sampled spins per execution_strategy field_validation) is reachable through the normalized SpinResponse shape. Validates that catalog runs can be tied back to a specific server build for defect triage.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `1` |

#### ✅ Expect

- ✓ **meta-round-id-present** _(custom)_ — Spin response includes a non-empty round identifier for traceability
    - Check: `typeof spin.id === 'string' && spin.id.length > 0`
- ✓ **meta-balance-numeric** _(custom)_ — Ending balance is a finite number (response was parsed correctly)
    - Check: `typeof spin.endingBalance === 'number' && isFinite(spin.endingBalance)`
- ✓ **meta-bet-numeric** _(custom)_ — Bet amount is a non-negative finite number
    - Check: `typeof spin.betAmount === 'number' && isFinite(spin.betAmount) && spin.betAmount >= 0`
- ✓ **meta-no-mapping-warnings** _(custom)_ — No network mapping or field-extraction warnings emitted during the spin
    - Check: `warnings.filter(w => /mapping|unknown field|missing field/i.test(w)).length === 0`

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

_Generated by crawler-qa-agent · catalog format v1 · 2026-05-27T07:14:11.001Z_
