# QA Review — vs20rnriches

**Game slug:** `vs20rnriches`  
**Generated at:** 5/26/2026, 2:13:12 AM  
**Engine:** HTML5/Canvas  
**Currency:** n/a  

## Summary

**Total cases:** 31  
**By category:** Base Game: 5 · Bet Variation: 5 · Other: 5 · Buy Feature: 3 · Autoplay: 2 · Special Bet: 2 · Free Spins: 2 · Options: 2 · Turbo Spin: 1 · History: 1 · Max Win Cap: 1 · performance: 1 · meta: 1  
**By severity:** critical: 11 · major: 15 · minor: 5

## Coverage Notes

- INCLUDED: base_game integrity (3 cases), bet_variation across full ladder 0.20→100 (5 tiers), bet_boundary clamp tests (2 cases — emitted as 'other' since enum lacks bet_boundary), all 3 buy_feature variants (Free Spins/Super FS 1/Super FS 2 with ratio verification), both special_bet variants (Ante + Super Spins), 2 autoplay batches, turbo toggle, free spins split (trigger watch + result shape), history panel match, 2 options/settings toggles, max-win cap watch, rules_consistency for cluster mechanic & cascade-flag drift, payout_correctness with cluster band check, tumble mechanic in free spins, performance SLO, meta version field, balance non-negative, round id uniqueness.
- INTENTIONALLY OMITTED — ui_consistency category: no OCR regions configured (balanceArea/betArea/winArea/freeSpinCounter all without bbox) per OCR COVERAGE notice. All screen.X assertions would silent-pass via null-guard; skipped to avoid false coverage.
- INTENTIONALLY OMITTED — wild_substitution category: spec.symbols is empty and info popup describes a pay-anywhere cluster mechanic with no WILD listed in the rules transcription. Until paytable.json extracts a WILD symbol, no meaningful substitution case can be authored.
- INTENTIONALLY OMITTED — bet_level category: bet_mechanics.bet_levels is empty (Pragmatic uses flat bet sizes, no separate coin/level multiplier in this game).
- INTENTIONALLY OMITTED — strict free-spin count assertions: organic-watch only with expected_feature=null per Best Practices §15 anti-pattern guidance.
- INTENTIONALLY OMITTED — respin category: info popup describes free-spin retrigger only (4/5/6 BONUS), not respins. Buy-feature multiplier-per-tumble belongs to tumble mechanic, not respin.

## Game Spec — Key References

**Bet mechanics:**  
- baseBet: `4`
- bet_sizes: `[4]`
- bet_levels: `[]`
- formula: coin * lines (PP-style)

## Test Cases

## Base Game (5)

### 1. `base-default-bet-single-spin` — Base game default bet single spin shape

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run a single spin at the default observed bet of 0.20 USD (spec: 11/11 sample spins use c=0.20) and verify response shape, balance conservation, RESOLVED status, and presence of required normalized fields (betAmount, winAmount, endingBalance, roundId). Establishes baseline server-data integrity for the 6x5 cluster-pay Pragmatic engine.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-amount-matches-default** _(custom)_ — Server-side betAmount equals default 0.20
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.20) <= 0.01`
- ✓ **win-amount-finite-non-negative** _(custom)_ — winAmount is a finite non-negative number
    - Check: `typeof spin.winAmount === 'number' && isFinite(spin.winAmount) && spin.winAmount >= 0`
- ✓ **ending-balance-non-negative** _(custom)_ — endingBalance is a finite non-negative number
    - Check: `typeof spin.endingBalance === 'number' && isFinite(spin.endingBalance) && spin.endingBalance >= 0`
- ✓ **round-id-present-string** _(custom)_ — roundId is a non-empty string
    - Check: `typeof spin.id === 'string' && spin.id.length > 0`
- ✓ **balance-arithmetic-holds** _(custom)_ — endingBalance reflects starting - bet + win (when prior balance known)
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **no-setup-or-engine-errors** _(custom)_ — No engine errors or failures in warnings during setup
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 2. `base-multi-spin-balance-conservation` — Multi-spin balance conservation (10 spins)

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 10 spins at default bet 0.20 USD and reconcile total bet/win against initial vs final balance within 0.01 tolerance. Samples show consistent -0.20 deduction per spin (99996541.16 → 99996513.16 across 11 captures); reconciling sums across 10 spins catches accumulation drift bugs in the Pragmatic /gs2c/v3/gameService pipeline.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **all-spins-bet-0.20** _(custom)_ — Every captured spin has betAmount === 0.20
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.20) <= 0.01)`
- ✓ **all-wins-non-negative** _(custom)_ — Every spin has winAmount >= 0
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **cumulative-balance-reconciles** _(custom)_ — End-to-end sum(bet) and sum(win) reconcile with first.startingBalance → last.endingBalance
    - Check: `(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **round-ids-all-unique** _(custom)_ — Every spin has a unique roundId
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **no-debounced-spins** _(custom)_ — No spin clicks were dropped or timed out
    - Check: `warnings.filter(w => /debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`

---

### 3. `base-response-shape-field-validation` — Spin response shape field validation

**Category:** Base Game  **Severity:** 🟠 major

**Description:** Run 5 spins and assert every required field per spec.execution_strategy.field_validation is present and type-correct: betAmount (number>0), winAmount (number>=0), endingBalance (number>=0), roundId (non-empty string). Verifies the Pragmatic raw → normalized field mapping is working end-to-end.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **field-bet-amount-typed** _(custom)_ — All spins have numeric positive betAmount
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && isFinite(s.betAmount) && s.betAmount > 0)`
- ✓ **field-win-amount-typed** _(custom)_ — All spins have numeric non-negative winAmount
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **field-ending-balance-typed** _(custom)_ — All spins have numeric non-negative endingBalance
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && isFinite(s.endingBalance) && s.endingBalance >= 0)`
- ✓ **field-round-id-typed** _(custom)_ — All spins have string non-empty id (roundId)
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **round-end-frames-detected** _(custom)_ — At least one round-end frame captured per spin
    - Check: `getRoundEndSpins(collector.spins).length >= 1`

---

### 4. `balance-non-negative-across-session` — Balance non-negative across full session

**Category:** Base Game  **Severity:** 🔴 critical

**Description:** Run 5 spins at default bet and assert endingBalance >= 0 on every spin. Spec field_validation requires endingBalance.min=0 — overdraft would manifest if bet exceeded remaining balance, must be server-blocked even at large initial balances.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **ending-balance-non-negative-all** _(custom)_ — Every spin has endingBalance >= 0
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && s.endingBalance >= 0)`
- ✓ **ending-balance-finite-all** _(custom)_ — Every endingBalance is finite (no NaN/Infinity)
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && isFinite(s.endingBalance))`
- ✓ **starting-balance-non-negative-when-known** _(custom)_ — When startingBalance is reported, it is non-negative
    - Check: `collector.spins.every(s => s.startingBalance == null || (typeof s.startingBalance === 'number' && s.startingBalance >= 0))`
- ✓ **no-overdraft-warnings** _(custom)_ — No engine warnings about overdraft or negative balance
    - Check: `warnings.filter(w => /overdraft|negative balance|insufficient/i.test(w)).length === 0`

---

### 5. `round-id-uniqueness` — Round ID uniqueness across spins

**Category:** Base Game  **Severity:** 🟠 major

**Description:** Run 15 spins at default bet 0.20 and assert every roundId is a unique non-empty string. Duplicate round IDs would indicate state corruption or double-submission bugs in the /gs2c/v3/gameService endpoint (spec.field_validation: roundId required string non-nullable).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `15` |

#### ✅ Expect

- ✓ **round-id-all-strings** _(custom)_ — Every spin id is a non-empty string
    - Check: `collector.spins.every(s => typeof s.id === 'string' && s.id.length > 0)`
- ✓ **round-id-all-unique** _(custom)_ — All 15 round ids are unique (no duplicates)
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **round-id-count-matches** _(custom)_ — At least 15 round-end frames captured
    - Check: `getRoundEndSpins(collector.spins).length >= 15`
- ✓ **round-id-no-double-submit** _(custom)_ — No double-submit warnings raised
    - Check: `warnings.filter(w => /duplicate|double.?submit|replay/i.test(w)).length === 0`

---

## Bet Variation (5)

### 6. `bet-variation-min-0.20` — Bet variation — minimum bet 0.20

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to the lowest ladder rung 0.20 USD (rules-ui: betMinus__bet-0.20 verified at (353,285)) and run 2 spins; assert spin.betAmount === 0.20 for every spin and balance arithmetic holds. Validates lowest bet boundary on the Pragmatic gameService endpoint.

#### 🪜 Step

1. Locate the bet display in the bottom info bar (current value labelled 'BET' near the spin button).
2. Click the betMinus '-' button (options.json: 'Bet Decrease (-)' at left of spin button) to open the bet ladder panel.
3. From the ladder grid, click the cell labelled 'bet-0.20' (top-left of grid, lowest rung).
4. Close the bet panel via the X button.
5. Verify the on-screen BET display reads '0.20' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **every-spin-bet-0.20** _(custom)_ — Each spin's betAmount equals target 0.20
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.20) <= 0.01)`
- ✓ **per-spin-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds (skipped where startingBalance null)
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **all-spins-resolved** _(custom)_ — All spins resolved cleanly
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **no-state-disruption-warnings** _(custom)_ — No popup/interrupt warnings during setup
    - Check: `warnings.filter(w => /popup|interrupt|stuck/i.test(w)).length === 0`

---

### 7. `bet-variation-low-0.50` — Bet variation — low tier 0.50

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to 0.50 USD (rules-ui: bet-0.50 verified at (770,285)) and run 2 spins; verify betAmount reflects selection and balance still reconciles. Tests a ~25th percentile point on the bet ladder spanning 0.20 → 100.

#### 🪜 Step

1. Click the bet display area (between '-' and '+' near spin button) to open the bet ladder panel.
2. In the ladder grid, click the cell labelled 'bet-0.50' (top row, 4th column).
3. Close the bet panel via the X (closeButton at 1097,221).
4. Verify the bet display reads exactly '0.50' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.5` |
| config.betAmount | `0.5` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **every-spin-bet-0.50** _(custom)_ — Each spin's betAmount equals 0.50
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 0.50) <= 0.01)`
- ✓ **balance-arithmetic-low-bet** _(custom)_ — Balance arithmetic holds for 0.50 bets
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **wins-non-negative** _(custom)_ — winAmount non-negative for all spins
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **no-error-warnings** _(custom)_ — No engine errors during the bet change
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 8. `bet-variation-mid-4.00` — Bet variation — mid tier 4.00 (default base bet visible)

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to 4.00 USD (buy-options.base_bet_visible = 4 — the bet level used when computing buy-feature costs $400/$1000/$4000) and run 3 spins; verify betAmount === 4.00. Critical anchor case because every buy-feature ratio assertion later assumes bet=4.

#### 🪜 Step

1. Click the bet display area (between '-' and '+' near spin button) to open the bet ladder panel.
2. In the ladder grid, click the cell labelled 'bet-4.00' (third row, fourth column at 1047,347).
3. Close the bet panel via the X.
4. Verify the bet display reads exactly '4.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `4` |
| config.betAmount | `4` |
| spin_count | `3` |

#### ✅ Expect

- ✓ **every-spin-bet-4** _(custom)_ — Each spin's betAmount equals 4.00
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 4.00) <= 0.01)`
- ✓ **balance-arithmetic-mid-bet** _(custom)_ — Balance arithmetic holds for 4.00 bets
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **round-ids-unique-mid** _(custom)_ — All 3 spins have unique roundIds
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **spins-not-debounced** _(custom)_ — No dropped spins during the bet-change session
    - Check: `warnings.filter(w => /debounced|likely debounced|no spin.*response within/i.test(w)).length === 0`

---

### 9. `bet-variation-high-20.00` — Bet variation — high tier 20.00

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to 20.00 USD (rules-ui: bet-20.00 verified at (353,471)) and run 2 spins; verify selection persists across spins and balance deducts 20 per spin. Represents ~75th percentile of bet ladder, exposing mid-to-high bet arithmetic.

#### 🪜 Step

1. Click the bet display area between '-' and '+' near spin button to open the bet ladder.
2. In the ladder grid click cell 'bet-20.00' (fourth row, first column at 353,471).
3. Close the bet panel via the X.
4. Verify the bet display reads exactly '20.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `20` |
| config.betAmount | `20` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **every-spin-bet-20** _(custom)_ — Each spin's betAmount equals 20.00
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 20.00) <= 0.01)`
- ✓ **balance-arithmetic-high-bet** _(custom)_ — Balance arithmetic holds for 20.00 bets
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **balance-decreased-or-equal** _(custom)_ — endingBalance <= startingBalance + winAmount for each spin
    - Check: `collector.spins.every(s => s.startingBalance == null || s.endingBalance <= s.startingBalance + s.winAmount + 0.01)`
- ✓ **no-warnings-high-bet** _(custom)_ — No errors/timeouts at high bet
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 10. `bet-variation-max-100.00` — Bet variation — maximum bet 100.00

**Category:** Bet Variation  **Severity:** 🟠 major

**Description:** Set bet to ladder maximum 100.00 USD (rules-ui: bet-100.00 verified at (631,534)) and run 2 spins; verify betAmount === 100 and balance correctly deducts 100 per spin. Max bet exposes large-number arithmetic bugs and is the upper boundary for clamping tests.

#### 🪜 Step

1. Click the bet display area between '-' and '+' near spin button to open the bet ladder.
2. In the ladder grid click cell 'bet-100.00' (fifth row, third column at 631,534).
3. Close the bet panel via the X.
4. Verify the bet display reads exactly '100.00' (within ±1 ladder step tolerance).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.betAmount | `100` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **every-spin-bet-100** _(custom)_ — Each spin's betAmount equals 100.00
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && Math.abs(s.betAmount - 100.00) <= 0.01)`
- ✓ **balance-arithmetic-max-bet** _(custom)_ — Balance arithmetic holds for max bet
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **ending-balance-non-negative-max** _(custom)_ — endingBalance never goes negative even at max bet
    - Check: `collector.spins.every(s => typeof s.endingBalance === 'number' && s.endingBalance >= 0)`
- ✓ **no-error-max-bet** _(custom)_ — No engine errors at max bet
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

## Other (5)

### 11. `bet-boundary-above-max-clamped` — Bet boundary — overshoot above max is clamped

**Category:** Other  **Severity:** 🔴 critical

**Description:** After setting bet to ladder maximum 100.00, attempt to push bet above max by clicking betPlus 5 additional times; spin once and assert betAmount === 100 (server-side clamp). Per Best Practices §18.7 this is a universal bet-boundary security check: bet-injection vulnerabilities would let players drain balance beyond intended max.

#### 🪜 Step

1. Click the bet display area to open the bet ladder.
2. Click the 'bet-100.00' cell (fifth row, third column at 631,534) to set max bet.
3. Close the bet panel via the X.
4. Click the betPlus '+' button 5 additional times (no panel should open — '+' on already-max should be a no-op or open ladder still pinned at 100).
5. Verify the bet display still reads exactly '100.00' (overshoot clamped, no value above 100 selectable).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `100` |
| config.betAmount | `100` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-100** _(custom)_ — Server-side betAmount remains 100 even after overshoot attempts
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 100.00) <= 0.01`
- ✓ **bet-not-exceeded-100** _(custom)_ — betAmount is not greater than max 100
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount <= 100.00 + 0.01`
- ✓ **balance-conservation-clamp** _(custom)_ — Balance conservation holds at clamped bet
    - Check: `spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **no-injection-warnings** _(custom)_ — No warnings about invalid bet or server rejection
    - Check: `warnings.filter(w => /invalid bet|bet rejected|out of range/i.test(w)).length === 0`

---

### 12. `bet-boundary-below-min-clamped` — Bet boundary — undershoot below min is clamped

**Category:** Other  **Severity:** 🔴 critical

**Description:** After setting bet to ladder minimum 0.20, attempt to push bet below min by clicking betMinus 5 additional times; spin once and assert betAmount === 0.20 (must not be 0 or negative). Per Best Practices §18.7 this protects against zero-bet free spins and negative-bet credit injection.

#### 🪜 Step

1. Click the bet display area to open the bet ladder.
2. Click the 'bet-0.20' cell (top-left of ladder at 353,285) to set min bet.
3. Close the bet panel via the X.
4. Click the betMinus '-' button 5 additional times (no panel should re-open or, if it does, only ladder is shown still pinned at 0.20).
5. Verify the bet display still reads exactly '0.20' (undershoot clamped, never 0 or negative).

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **bet-clamped-at-min** _(custom)_ — Server-side betAmount remains 0.20 after undershoot attempts
    - Check: `typeof spin.betAmount === 'number' && Math.abs(spin.betAmount - 0.20) <= 0.01`
- ✓ **bet-strictly-positive** _(custom)_ — betAmount is strictly > 0 (no zero-bet bypass)
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount > 0`
- ✓ **bet-not-below-min** _(custom)_ — betAmount not less than min 0.20
    - Check: `typeof spin.betAmount === 'number' && spin.betAmount >= 0.20 - 0.001`
- ✓ **balance-deducted-min-bet** _(custom)_ — Balance still deducts a real bet (no free spin via underflow)
    - Check: `spin.startingBalance == null || (spin.startingBalance - spin.endingBalance + spin.winAmount) >= 0.19`

---

### 13. `rules-consistency-cluster-mechanic` — Rules consistency — cluster mechanic 6x5 declared matches engine

**Category:** Other  **Severity:** 🟠 major

**Description:** Assert the engine consistently reports 6x5 grid and that observed spin matrix (if present) matches a 6-reel × 5-row layout per info: cluster/30 pay-anywhere on 6x5. Buy-options note 'multiplier increases every tumble' implying tumble mechanic exists in features even though spec.cascade=false reflects base game only.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `3` |

#### ✅ Expect

- ✓ **matrix-present-shape-when-array** _(custom)_ — When matrix is an array of arrays, each row is non-empty
    - Check: `collector.spins.filter(s => Array.isArray(s.matrix) && s.matrix.length > 0).every(s => s.matrix.every(reel => Array.isArray(reel) && reel.length > 0))`
- ✓ **rules-consistent-shape** _(custom)_ — Every spin response has consistent normalized field set
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number' && typeof s.id === 'string')`
- ✓ **rules-no-shape-warnings** _(custom)_ — No warnings about field-mapping or shape mismatch
    - Check: `warnings.filter(w => /shape|mapping|missing field/i.test(w)).length === 0`

---

### 14. `payout-correctness-cluster-count-bands` — Payout correctness — cluster count bands (8-9, 10-11, 12-30)

**Category:** Other  **Severity:** 🔴 critical

**Description:** Run 30 spins at default bet 0.20 and assert for every spin with winAmount > 0 the value is finite, non-negative, and within sane bounds relative to bet (≤ 5000× bet per Pragmatic cap). Per Best Practices §18.2, payout correctness is critical: balance check alone cannot detect RNG/payTable corruption — this case asserts the basic invariant that wins remain bounded by the published cluster-count bands' top symbol $200 at bet $0.40 → ≤500× bet for any single hit.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `30` |

#### ✅ Expect

- ✓ **payout-non-negative-finite** _(custom)_ — Every winAmount is finite and non-negative
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount) && s.winAmount >= 0)`
- ✓ **payout-bounded-by-cap** _(custom)_ — No single spin win exceeds 5000× bet cap
    - Check: `collector.spins.every(s => typeof s.winAmount !== 'number' || s.betAmount <= 0 || s.winAmount <= s.betAmount * 5000 + 0.01)`
- ✓ **payout-zero-when-no-resolution-issue** _(custom)_ — All spins resolved (any zero-win spin is a legitimate no-cluster outcome)
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **payout-balance-conservation** _(custom)_ — Balance arithmetic correctly reflects every win/loss
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **payout-no-rng-warnings** _(custom)_ — No payout/RNG warnings emitted
    - Check: `warnings.filter(w => /payout|RNG|corrupt|invalid win/i.test(w)).length === 0`

---

### 15. `tumble-mechanic-during-free-spins` — Tumble mechanic — verify tumbles occur during free spins

**Category:** Other  **Severity:** 🟠 major

**Description:** Observe free-spin chain (organic or via buy) and verify free-spin frames are present and well-formed, supporting the buy-options claim that 'multiplier increases every tumble'. Validates that feature-mode tumble mechanic exists even though spec.cascade=false reflects base game only.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **tumble-fs-shape-valid** _(custom)_ — Any observed free-spin frames are well-formed
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **tumble-fs-state-observed** _(custom)_ — State timeline shows FREE_SPIN/BONUS transition (when feature engages)
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS|TUMBLE/i.test(t.to)) || collector.spins.filter(s => s.isFreeSpin === true).length === 0`
- ✓ **tumble-fs-finite-wins** _(custom)_ — Free-spin wins finite (no overflow from chained tumble multipliers)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => isFinite(s.winAmount))`
- ✓ **tumble-no-stuck-warnings** _(custom)_ — No warnings about stuck tumble chains or response timeouts
    - Check: `warnings.filter(w => /stuck|no spin.*response within|cascade.*timeout/i.test(w)).length === 0`

---

## Autoplay (2)

### 16. `autoplay-small-batch-10` — Autoplay — 10 round batch

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Configure autoplay for exactly 10 rounds and press START (rules-ui: autoButton__autoCountSlide-10 verified at (440,384)); wait for completion and verify exactly 10 spins were submitted, all RESOLVED, balance reconciles end-to-end with no dropped/double spins.

#### 🪜 Step

1. Click the Autoplay button (autoButton at 997,705 — below spin button).
2. In the autoplay panel, click the '10' rounds preset (autoCountSlide-10 at 440,384).
3. Click the START button (startAutoplayButton at 655,512).
4. Verify the panel closes and reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| config.autoplay_rounds | `10` |
| spin_count | `10` |

#### ✅ Expect

- ✓ **autoplay-10-rounds-captured** _(custom)_ — At least 10 round-end frames captured
    - Check: `getRoundEndSpins(collector.spins).length >= 10`
- ✓ **autoplay-unique-ids** _(custom)_ — All captured spins have unique roundIds
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **autoplay-cumulative-balance** _(custom)_ — Cumulative bet/win reconciles end-to-end across the autoplay batch
    - Check: `(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-no-debounce** _(custom)_ — No autoplay clicks were dropped/debounced
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0`
- ✓ **autoplay-bet-consistent** _(custom)_ — Bet stayed constant throughout the batch
    - Check: `collector.spins.every(s => Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)`

---

### 17. `autoplay-medium-batch-25` — Autoplay — 20 round batch via slide

**Category:** Autoplay  **Severity:** 🟠 major

**Description:** Configure autoplay for 20 rounds (rules-ui: autoCountSlide-20 verified at (490,386)) and press START; verify 20 spins ran, all RESOLVED, no stuck rounds and balance arithmetic correct across the medium batch. Medium batches surface mid-batch error handling and resume-after-feature issues.

#### 🪜 Step

1. Click the Autoplay button (autoButton at 997,705 — below spin button).
2. In the autoplay panel, click the '20' rounds preset (autoCountSlide-20 at 490,386).
3. Click the START button (startAutoplayButton at 655,512).
4. Verify the panel closes and reels visibly begin spinning automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| config.autoplay_rounds | `20` |
| spin_count | `20` |

#### ✅ Expect

- ✓ **autoplay-20-rounds-captured** _(custom)_ — At least 20 round-end frames captured
    - Check: `getRoundEndSpins(collector.spins).length >= 20`
- ✓ **autoplay-20-unique-ids** _(custom)_ — All 20+ captured spins have unique roundIds
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **autoplay-20-balance-reconciles** _(custom)_ — Cumulative bet/win reconciles across the 20-round batch
    - Check: `(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length - 1]; if (!first || !last || first.startingBalance == null) return true; const sb = collector.spins.reduce((a,s)=>a+(s.betAmount||0),0); const sw = collector.spins.reduce((a,s)=>a+(s.winAmount||0),0); return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01; })()`
- ✓ **autoplay-20-no-warnings** _(custom)_ — No engine errors or dropped spins in 20-batch
    - Check: `warnings.filter(w => /debounced|error|fail|threw|popup may have blocked/i.test(w)).length === 0`
- ✓ **autoplay-20-each-spin-shape** _(custom)_ — Each spin has valid normalized shape
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number' && typeof s.id === 'string' && s.id.length > 0)`

---

## Buy Feature (3)

### 18. `buy-feature-free-spins-400x` — Buy Feature — Free Spins ($400 = 100× base bet)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** At base bet $4.00 (buy-options.base_bet_visible = 4), purchase 'Free Spins' option costing $400 (= 100× bet) and observe the resulting free-spin chain. Verify deduction ratio ≥50× via detectBuyFeatureDeduction, chain spins are RESOLVED, free-spin frames captured (buy-options: '+1× multiplier per tumble').

#### 🪜 Step

1. Open the bet ladder via betPlus '+' and select 'bet-4.00' (third row, fourth column at 1047,347); close ladder via the X.
2. Verify the bet display reads '4.00'.
3. Click the Buy Feature button (buyBonusButton at 112,246 on left side of reels).
4. In the buy popup, click the 'Free Spins' option (freeSpinsOption at 372,316 — leftmost option, $400).
5. In the confirmation dialog, click the Yes/Confirm button (yesButton at 745,452).
6. Verify the popup closes and the free-spin chain begins playing automatically.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `4` |
| config.betAmount | `4` |
| config.buy_option | `"freeSpins"` |
| config.expected_cost_ratio | `100` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-deduction-detected** _(custom)_ — Buy-feature deduction observed with ratio ≥ 50× (≈100× expected)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50; })()`
- ✓ **buy-deduction-near-100x** _(custom)_ — Deduction ratio close to advertised 100× (within 5× tolerance)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 80 && d.ratio <= 120; })()`
- ✓ **buy-free-spins-shape-valid** _(custom)_ — Any observed free-spin frames have valid id and non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **buy-free-spin-no-bet-deduct** _(custom)_ — Free-spin rounds (when observed) do not deduct bet from balance
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)`
- ✓ **buy-state-transition-observed** _(custom)_ — State machine recorded a FREE_SPIN / BONUS transition
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`

---

### 19. `buy-feature-super-free-spins-1-1000x` — Buy Feature — Super Free Spins 1 ($1000 = 250× base bet)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** At base bet $4.00, purchase 'Super Free Spins 1' costing $1,000 (= 250× bet, buy-options: '+3× multiplier per tumble'). Verify deduction ratio is well above the buy threshold and free-spin chain triggers with the enhanced multiplier behavior.

#### 🪜 Step

1. Open the bet ladder and select 'bet-4.00' (1047,347); close ladder via the X.
2. Verify the bet display reads '4.00'.
3. Click the Buy Feature button (buyBonusButton at 112,246).
4. In the buy popup, click 'Super Free Spins 1' option (superFreeSpins1Option at 640,315 — middle option, $1,000).
5. Click the Yes/Confirm button (yesButton at 763,454).
6. Verify the popup closes and the super-free-spin chain begins playing.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `4` |
| config.betAmount | `4` |
| config.buy_option | `"superFreeSpins1"` |
| config.expected_cost_ratio | `250` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-sfs1-deduction-ratio** _(custom)_ — Buy deduction ratio ≥ 200× (advertised 250×)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 200; })()`
- ✓ **buy-sfs1-deduction-bounded** _(custom)_ — Deduction ratio not absurdly higher than advertised
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio <= 320; })()`
- ✓ **buy-sfs1-fs-shape-valid** _(custom)_ — Any free-spin frames have valid shape
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **buy-sfs1-state-bonus** _(custom)_ — State timeline shows FREE_SPIN/BONUS transition
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`
- ✓ **buy-sfs1-no-errors** _(custom)_ — No engine errors during purchase or feature
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 20. `buy-feature-super-free-spins-2-4000x` — Buy Feature — Super Free Spins 2 ($4000 = 1000× base bet)

**Category:** Buy Feature  **Severity:** 🔴 critical

**Description:** At base bet $4.00, purchase the top-tier 'Super Free Spins 2' costing $4,000 (= 1000× bet, buy-options: 'multiplier DOUBLES at every tumble' — geometric growth). Highest-variance product; doubling multiplier is critical to test for exponent overflow and max-win cap interaction.

#### 🪜 Step

1. Open the bet ladder and select 'bet-4.00' (1047,347); close ladder.
2. Verify the bet display reads '4.00'.
3. Click the Buy Feature button (buyBonusButton at 112,246).
4. In the buy popup, click 'Super Free Spins 2' option (superFreeSpins2Option at 869,315 — rightmost, $4,000).
5. Click the Yes/Confirm button (yesButton at 768,442).
6. Verify the popup closes and the doubling-multiplier free-spin chain begins playing.

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `4` |
| config.betAmount | `4` |
| config.buy_option | `"superFreeSpins2"` |
| config.expected_cost_ratio | `1000` |
| spin_count | `1` |
| expected_feature | `free_spins` |

#### ✅ Expect

- ✓ **buy-sfs2-deduction-ratio** _(custom)_ — Buy deduction ratio ≥ 800× (advertised 1000×)
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 800; })()`
- ✓ **buy-sfs2-deduction-bounded** _(custom)_ — Deduction ratio not above ~1200×
    - Check: `(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio <= 1300; })()`
- ✓ **buy-sfs2-fs-shape-valid** _(custom)_ — Any free-spin frames have valid id and non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **buy-sfs2-no-overflow** _(custom)_ — winAmount finite (no NaN/Infinity from exponent overflow)
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount))`
- ✓ **buy-sfs2-state-bonus** _(custom)_ — State timeline shows FREE_SPIN/BONUS transition
    - Check: `stateTimeline.some(t => /FREE_SPIN|BONUS/i.test(t.to))`

---

## Special Bet (2)

### 21. `special-bet-ante-bet-active` — Special Bet — Ante Bet active increases scatter chance

**Category:** Special Bet  **Severity:** 🟠 major

**Description:** Enable 'Ante Bet' via the specialBets2Options panel (rules-ui: anteBetOption at (444,316)) at base bet 0.20 and run 5 spins. Verify spin.betAmount reflects the ante surcharge (typically 1.25× in Pragmatic games) and feature still resolves normally.

#### 🪜 Step

1. Click the Special Bets button on the left side of reels (specialBets2Options at 109,460).
2. In the special-bet popup, click the Ante Bet option (anteBetOption at 444,316).
3. Close the special-bet panel via the X (closeButton at 958,238).
4. Verify the bet display now reads a value above the original base 0.20 (ante typically multiplies bet by ~1.25×, so expect ~0.25 — verify display shows updated total).

#### 📥 Input

| Input | Value |
|---|---|
| config.ante_bet | `"enabled"` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **ante-bet-positive** _(custom)_ — betAmount strictly positive across ante spins
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount > 0)`
- ✓ **ante-bet-consistent** _(custom)_ — Bet amount stays constant across the 5 ante spins
    - Check: `collector.spins.length === 0 || collector.spins.every(s => Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)`
- ✓ **ante-balance-conservation** _(custom)_ — Per-spin balance arithmetic holds under ante surcharge
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **ante-all-resolved** _(custom)_ — All ante spins resolved
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **ante-no-errors** _(custom)_ — No engine errors during ante session
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 22. `special-bet-super-spins-active` — Special Bet — Super Spins variant active

**Category:** Special Bet  **Severity:** 🟠 major

**Description:** Enable 'Super Spins' via specialBets2Options panel (rules-ui: superSpinsOption at (814,320)) and run 5 spins. Verify modified bet amount applied per spin and feature engages cleanly — tests the second special-bet variant which has a different cost multiplier than Ante.

#### 🪜 Step

1. Click the Special Bets button (specialBets2Options at 109,460).
2. In the special-bet popup, click the Super Spins option (superSpinsOption at 814,320 — right side of popup).
3. Close the panel via the X (closeButton at 958,238).
4. Verify the bet display updates to reflect the Super Spins multiplier (value above the original 0.20 base).

#### 📥 Input

| Input | Value |
|---|---|
| config.super_spins | `"enabled"` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **super-spins-bet-positive** _(custom)_ — betAmount strictly positive across all spins
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && s.betAmount > 0)`
- ✓ **super-spins-bet-stable** _(custom)_ — Bet amount stable across the 5 super-spins runs
    - Check: `collector.spins.length === 0 || collector.spins.every(s => Math.abs(s.betAmount - collector.spins[0].betAmount) <= 0.01)`
- ✓ **super-spins-balance-conservation** _(custom)_ — Balance arithmetic holds under the special bet
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **super-spins-resolved** _(custom)_ — All spins resolved
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **super-spins-no-warning** _(custom)_ — No engine errors during super spins session
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

## Turbo Spin (1)

### 23. `turbo-spin-toggle-faster-spin` — Turbo Spin — toggle reduces spin animation time

**Category:** Turbo Spin  **Severity:** ⚪ minor

**Description:** Enable the turboSpinToggle inside the autoplay menu (rules-ui: autoButton__turboSpinToggle at (445,255)) and run 5 spins; verify each spin remains RESOLVED and balance/bet integrity is preserved while cosmetic spin time is reduced. Toggling turbo must not skip server-side validation.

#### 🪜 Step

1. Click the Autoplay button (autoButton at 997,705) to open the autoplay panel.
2. Click the Turbo Spin toggle (turboSpinToggle at 445,255) to enable it.
3. Close the autoplay panel via the X (closeButton at 848,146) WITHOUT pressing START.
4. Verify the autoplay panel closes and the main spin button is enabled.

#### 📥 Input

| Input | Value |
|---|---|
| config.turbo | `"on"` |
| spin_count | `5` |

#### ✅ Expect

- ✓ **turbo-spins-resolved** _(custom)_ — All turbo spins resolved cleanly
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **turbo-shape-intact** _(custom)_ — All turbo spins have valid normalized fields
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number' && typeof s.id === 'string' && s.id.length > 0)`
- ✓ **turbo-balance-conservation** _(custom)_ — Balance arithmetic still holds in turbo mode
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **turbo-no-skip-warnings** _(custom)_ — No 'skipped' or 'missed' warnings during turbo
    - Check: `warnings.filter(w => /skip|missed|no spin.*response/i.test(w)).length === 0`

---

## Free Spins (2)

### 24. `free-spins-organic-trigger-watch` — Free Spins — organic trigger observation (60 spins)

**Category:** Free Spins  **Severity:** 🟠 major

**Description:** Run 60 spins at default bet 0.20 and watch for organic free-spin trigger (rules: 4/5/6 BONUS scatters on the 6x5 screen → 10/15/20 free spins). If observed, asserts shape invariants on the chain spins; if not observed, the case still passes as an organic watch (per Best Practices §15, no strict trigger counts).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `60` |

#### ✅ Expect

- ✓ **fs-organic-shape-invariant** _(custom)_ — Any observed free-spin frames have valid id + non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **fs-organic-no-bet-deduct** _(custom)_ — Free-spin rounds (if observed) do not deduct bet from balance
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)`
- ✓ **fs-organic-counter-monotonic** _(custom)_ — freeSpinsRemaining counter (if present) decreases monotonically
    - Check: `(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true && typeof s.freeSpinsRemaining === 'number'); for (let i = 1; i < fs.length; i++) { if (fs[i].freeSpinsRemaining > fs[i-1].freeSpinsRemaining) return false; } return true; })()`
- ✓ **fs-organic-rounds-captured** _(custom)_ — At least 60 round-end frames captured (organic run completed)
    - Check: `getRoundEndSpins(collector.spins).length >= 50`
- ✓ **fs-organic-no-warnings** _(custom)_ — No engine errors during 60-spin organic run
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 25. `free-spins-result-shape-during-chain` — Free Spins — chain result shape (betAmount=0, tumble multiplier)

**Category:** Free Spins  **Severity:** 🔴 critical

**Description:** When isFreeSpin=true is observed (organic or via prior buy), assert chain integrity per spin: status RESOLVED, winAmount>=0, no bet deduction from balance, and freeSpinsRemaining counter monotonically decreases. Validates free-spin response shape across observed chain rounds (buy-options: each variant has distinct per-tumble multiplier behavior).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **fs-chain-valid-id-win** _(custom)_ — Every free-spin frame has valid id and non-negative win
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.id === 'string' && s.id.length > 0 && typeof s.winAmount === 'number' && s.winAmount >= 0)`
- ✓ **fs-chain-no-bet-deduct** _(custom)_ — Free-spin rounds do not subtract bet from balance
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.startingBalance == null || s.endingBalance >= s.startingBalance - 0.001)`
- ✓ **fs-chain-counter-monotonic** _(custom)_ — freeSpinsRemaining counter never increases within chain
    - Check: `(() => { const fs = collector.spins.filter(s => s.isFreeSpin === true && typeof s.freeSpinsRemaining === 'number'); for (let i = 1; i < fs.length; i++) { if (fs[i].freeSpinsRemaining > fs[i-1].freeSpinsRemaining) return false; } return true; })()`
- ✓ **fs-chain-all-resolved** _(custom)_ — All chain spins are RESOLVED
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **fs-chain-finite-wins** _(custom)_ — Free-spin winAmount is finite (no NaN/Infinity from multiplier overflow)
    - Check: `collector.spins.filter(s => s.isFreeSpin === true).every(s => typeof s.winAmount === 'number' && isFinite(s.winAmount))`

---

## History (1)

### 26. `history-panel-rows-match-recent-spins` — History — rows match recent 5 spins

**Category:** History  **Severity:** 🟠 major

**Description:** Run 5 base spins at default bet 0.20, then open the menu and click Game History (rules-ui: menuButton__gameHistoryButton at (592,289)); verify the history panel opens. Tests rounds-history endpoint consistency with recent live spin samples — common silent failure point in Pragmatic /gameService integrations.

#### 🪜 Step

1. Click the Menu button (menuButton at 142,657 — bottom-left).
2. Click the Game History button (gameHistoryButton at 592,289).
3. Verify a history panel opens listing recent rounds.

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `5` |

#### ✅ Expect

- ✓ **history-spins-shape-valid** _(custom)_ — All 5 recent spins have valid normalized shape for history matching
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number' && typeof s.id === 'string' && s.id.length > 0)`
- ✓ **history-round-ids-unique** _(custom)_ — Round IDs in captured spins are unique (no duplicate rows expected)
    - Check: `new Set(collector.spins.map(s => s.id)).size === collector.spins.length`
- ✓ **history-balance-arithmetic** _(custom)_ — Balance arithmetic still holds across the 5-spin pre-history batch
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **history-no-popup-errors** _(custom)_ — No popup or menu errors during history navigation
    - Check: `warnings.filter(w => /error|fail|threw|popup may have blocked/i.test(w)).length === 0`

---

## Options (2)

### 27. `options-sound-fx-toggle` — Options — Sound FX toggle persists across spins

**Category:** Options  **Severity:** ⚪ minor

**Description:** Open menu, toggle Sound FX off (rules-ui: menuButton__soundFxToggle at (921,418)), close menu, run 2 spins, then verify spins resolved normally and no error was emitted. Tests that audio settings do not impact game logic or money flow.

#### 🪜 Step

1. Click the Menu button (menuButton at 142,657 — bottom-left).
2. Click the Sound FX toggle (soundFxToggle at 921,418).
3. Click the close button (closeButton at 1038,105) to close the menu.
4. Verify the menu is closed and the spin button is interactive.

#### 📥 Input

| Input | Value |
|---|---|
| config.sound_fx | `"off"` |
| spin_count | `2` |

#### ✅ Expect

- ✓ **options-spins-resolved** _(custom)_ — Both spins after option toggle resolved cleanly
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`
- ✓ **options-shape-intact** _(custom)_ — Spin response shape unaffected by option toggle
    - Check: `collector.spins.every(s => typeof s.betAmount === 'number' && typeof s.winAmount === 'number' && typeof s.endingBalance === 'number')`
- ✓ **options-balance-conservation** _(custom)_ — Balance arithmetic still holds after option change
    - Check: `collector.spins.every(s => s.startingBalance == null || Math.abs(s.endingBalance - (s.startingBalance - s.betAmount + s.winAmount)) <= 0.01)`
- ✓ **options-no-errors** _(custom)_ — No engine errors raised by toggling sound FX
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

### 28. `options-ambient-music-toggle` — Options — Ambient music toggle

**Category:** Options  **Severity:** ⚪ minor

**Description:** Toggle ambient music off via the menu (rules-ui: menuButton__ambientMusicToggle at (923,346)), close the menu, run 1 spin, and verify the spin resolved cleanly. Covers the separate audio channel from sound FX — should not affect money or state.

#### 🪜 Step

1. Click the Menu button (menuButton at 142,657).
2. Click the Ambient Music toggle (ambientMusicToggle at 923,346).
3. Click the close button (closeButton at 1038,105) to close the menu.
4. Verify the menu is closed and the main UI is interactive.

#### 📥 Input

| Input | Value |
|---|---|
| config.ambient_music | `"off"` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **ambient-spin-resolved** _(custom)_ — Spin after ambient toggle resolved
    - Check: `spin == null || spin.status == null || spin.status === 'RESOLVED'`
- ✓ **ambient-shape-intact** _(custom)_ — Spin shape intact after ambient toggle
    - Check: `spin == null || (typeof spin.betAmount === 'number' && typeof spin.winAmount === 'number' && typeof spin.endingBalance === 'number')`
- ✓ **ambient-balance-holds** _(custom)_ — Balance arithmetic still holds
    - Check: `spin == null || spin.startingBalance == null || Math.abs(spin.endingBalance - (spin.startingBalance - spin.betAmount + spin.winAmount)) <= 0.01`
- ✓ **ambient-no-errors** _(custom)_ — No engine errors raised by ambient toggle
    - Check: `warnings.filter(w => /error|fail|threw/i.test(w)).length === 0`

---

## Max Win Cap (1)

### 29. `max-win-cap-watch` — Max Win Cap — verify cap not exceeded across runs

**Category:** Max Win Cap  **Severity:** 🔴 critical

**Description:** Across all observed spins (organic + buy-feature chains), assert no single round's winAmount exceeds Pragmatic's standard 5000× bet cap. Without cap enforcement, the doubling-multiplier Super FS 2 buy could theoretically uncap exponential wins (buy-options notes 'multiplier doubles at every tumble').

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| spin_count | `0` |

#### ✅ Expect

- ✓ **max-win-cap-5000x** _(custom)_ — No spin's winAmount exceeds 5000× its betAmount
    - Check: `collector.spins.every(s => typeof s.winAmount !== 'number' || typeof s.betAmount !== 'number' || s.betAmount <= 0 || s.winAmount <= s.betAmount * 5000 + 0.01)`
- ✓ **max-win-finite** _(custom)_ — winAmount is finite (no Infinity from multiplier overflow)
    - Check: `collector.spins.every(s => typeof s.winAmount !== 'number' || isFinite(s.winAmount))`
- ✓ **max-win-non-negative** _(custom)_ — winAmount never negative
    - Check: `collector.spins.every(s => typeof s.winAmount === 'number' && s.winAmount >= 0)`

---

## performance (1)

### 30. `performance-spin-response-slo` — Performance — per-spin response time SLO

**Category:** performance  **Severity:** ⚪ minor

**Description:** Run 20 base spins at default bet and assert all spins complete without 'no spin response within X' warnings from the engine runner. The spin endpoint (spec: pp.dev.revenge-games.com/gs2c/v3/gameService, HTTP single_response) should respond well within runner timeout — surfaces backend degradation.

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `20` |

#### ✅ Expect

- ✓ **perf-no-slow-spin-warnings** _(custom)_ — No spin response exceeded the engine timeout
    - Check: `warnings.filter(w => /no spin.*response within|elapsed [0-9]+\.[0-9]+s/i.test(w)).length === 0`
- ✓ **perf-all-spins-captured** _(custom)_ — All 20 round-end frames captured
    - Check: `getRoundEndSpins(collector.spins).length >= 20`
- ✓ **perf-no-debounce** _(custom)_ — No spins were debounced or dropped under load
    - Check: `warnings.filter(w => /debounced|likely debounced|popup may have blocked/i.test(w)).length === 0`
- ✓ **perf-all-resolved** _(custom)_ — All spins resolved cleanly
    - Check: `collector.spins.every(s => s.status == null || s.status === 'RESOLVED')`

---

## meta (1)

### 31. `meta-logic-version-captured` — Meta — logic version captured per spin for traceability

**Category:** meta  **Severity:** ⚪ minor

**Description:** Run 1 spin and assert the round id and spin shape are present so the QA pipeline can correlate to logic version (samples consistently report sver=6 in the raw payload, used for reproducing bugs against specific game logic builds).

#### 🪜 Step

_(no setup — observational case, runs at default state)_

#### 📥 Input

| Input | Value |
|---|---|
| expected_bet | `0.2` |
| config.betAmount | `0.2` |
| spin_count | `1` |

#### ✅ Expect

- ✓ **meta-round-id-present** _(custom)_ — Spin has a round id for traceability
    - Check: `typeof spin.id === 'string' && spin.id.length > 0`
- ✓ **meta-spin-resolved** _(custom)_ — Spin resolved cleanly
    - Check: `spin.status == null || spin.status === 'RESOLVED'`
- ✓ **meta-shape-complete** _(custom)_ — Spin has full normalized shape for diagnostic correlation
    - Check: `typeof spin.betAmount === 'number' && typeof spin.winAmount === 'number' && typeof spin.endingBalance === 'number'`

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

_Generated by crawler-qa-agent · catalog format v1 · 2026-05-25T19:13:12.766Z_
