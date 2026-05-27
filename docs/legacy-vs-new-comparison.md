# Legacy 3-Phase vs New 11-Step Pipeline — Step-by-Step Comparison

Purpose: identify which engines/capabilities in legacy worth porting into new pipeline, preserving what new has done better.

---

## High-level structural diff

| | Legacy | New |
|---|---|---|
| **Phases** | 3 (Collect → Generate → Run) — manual orchestration | 11 (auto-orchestrated via cold-start / warm-start) |
| **Reuse model** | One-shot per task; recordings cached but spec regenerated | Cold start (full discover) ↔ Warm start (reuse registry) |
| **AI policy** | Implicit; AI called wherever needed | Explicit allow-list, audit CLI enforces |
| **Output format** | `fixtures/specs/<slug>/` + `tests/generated/<slug>.spec.ts` | `fixtures/registry/<slug>/` (cache-friendly) + `fixtures/test-runs/<ts>/report.{json,html,pdf}` |
| **Driver runtime** | Spawns `playwright test` subprocess | Direct Playwright via orchestrator |
| **Per-spin AI** | Yes (vision OCR for canvas games) | NO (per policy) — uses cached coords + network |
| **Code lines** | ~5000 lines (excl. existing fixtures) | ~140 files in `src/pipeline/` |

---

# PHASE 1 — COLLECT (legacy) ↔ Steps 1–6 (new)

## What legacy COLLECT does that new doesn't

### 1.1 Multi-stage rule extraction
**Legacy:**
- `extractPlayScreenSnapshot()` — vision OCR play screen → bet ranges, buy feature options, special bets
- `decideRulesFlow()` — LLM steps through paytable popup (next/prev) multi-page
- `transcribeRulesPage()` — OCR each rule page
- `synthRulesFromSnapshot()` — synthesize markdown from snapshot
- Output: full `rules.md` (5000+ chars) with paytable, symbols, features

**New:**
- step4 feature-discovery uses 4 sources (UI/network/paytable/gameplay/AI) but NO multi-page rules nav
- `step4/paytable-detector.ts` is a STUB (no rules text)
- No transcribed paytable

**Port priority: HIGH** — Without rules markdown, AI catalog has thin context → 25 cases instead of 33+.

### 1.2 Dual-mode network spin detection
**Legacy:**
- `spin-detect.ts:scoreSpinUrl()` + `scoreSpinShape()` — heuristic, dual threshold (≥7 overall, ≥5 body shape)
- `network-detect.ts:detectSpinEndpointWithAI()` — AI fallback when heuristic < 0.3 confidence
- Includes field mapping normalization (tw→winAmount, c→betAmount, sa→matrix)

**New:**
- `step5/score.ts` has scoring but no AI fallback
- `step5/ai-rank.ts` is STUB (returns null)
- Field mapping is per-provider in `pragmatic-parser.ts` — only Pragmatic supported

**Port priority: MEDIUM** — Heuristic works for Pragmatic. AI fallback needed for new providers without explicit adapter.

### 1.3 Execution strategy detection
**Legacy `GameSpec.execution_strategy`** auto-detected per game:
- `completion_signal.method`: `single_response` | `isEndRound_true` | `tumble_chain_end` | `ws_message_kind` | `balance_settled`
- `field_validation[]` with required/type/min/max per field
- `preflight_checks[]` with rules: `all_samples_field_nonzero`, `samples_field_varies`, `field_in`, etc.

**New:**
- Cascade detected (boolean) but no `completion_signal` strategy
- No field_validation schema  
- No preflight rules

**Port priority: HIGH** — Without this, cascade games (PP) and stream-based providers misbehave.

### 1.4 Preflight execution validator
**Legacy** `execution-preflight.ts:runExecutionPreflight()`:
- Runs all field_validation rules against sample spins
- Runs all preflight_checks (rejects wallet snapshots, stale data, etc.)
- Emits structured PreflightResult with ok/errors[]/warnings[]
- Saves to `fixtures/specs/<slug>/<slug>.preflight.json`

**New:** None.

**Port priority: HIGH** — Catches "bet=0 across all samples → wallet response, not spin" bug early.

### 1.5 Scenario extraction
**Legacy** `runner/scenario-extractor.ts`:
- Classifies captured responses into labels: `no_win`, `bonus_trigger`, `free_spin`, `big_win`, `max_win`, ...
- Heuristics: matrix diversity, payout threshold, status field, isFreeSpin flag
- Saves labeled fixtures to `fixtures/scenarios/<slug>/<label>.json`
- Powers deterministic hybrid mode (mock specific scenarios)

**New:**
- `step6-build-model/state-machine.ts` has state enum but no scenario labeling
- No `fixtures/scenarios/` writes

**Port priority: MEDIUM-HIGH** — Enables deterministic test path (no AI per spin).

### 1.6 Pre-game recording + replay
**Legacy** `pre-game-recording.ts` + `pre-game-replay.ts`:
- Record clicks + screenshots during first pre-game flow
- Save to `fixtures/pre-game/<slug>_<hash>/recording.json` + `baseline.png`
- On re-run: replay clicks, pixel-diff baseline → fast path (5s vs 30s vision)

**New:**
- `step3-smoke/dismiss-overlays.ts` does blind safe-area clicks (no recording)
- No replay path

**Port priority: MEDIUM** — Speed boost on warm-start. Not blocking.

## What NEW pipeline already does for collect

| Capability | Legacy | New | Verdict |
|---|---|---|---|
| Open game URL | ✓ | step1 crawl | parity |
| Provider detection | URL regex | step1 provider-detector | parity (new explicit module) |
| iframe/canvas detection | inline | step1 explicit | parity |
| UI element detection (DOM + vision) | inline + cached | step2 4-strategy chain + Registry | **new better** (cache-first, replay-friendly) |
| Network capture | recording subprocess | step3-capture inline | parity |
| Spin endpoint detection | heuristic + AI fallback | heuristic only | **legacy better** |
| Field mapping normalization | provider adapter | step6 BaseParser + per-provider | parity |
| Feature detection | rules-driven | step4 5-source aggregator | **new better** (more signals) |
| Registry caching | per-artifact files | unified `fixtures/registry/<slug>/` | **new better** |
| Cold/warm differentiation | env var QA_CLEAN_BEFORE_RUN | explicit orchestrator | **new better** |
| AI scope policy | none | enforced via audit:ai-scope | **new better** |

---

# PHASE 2 — GENERATE (legacy) ↔ Step 7 (new)

## What legacy GENERATE does that new doesn't

### 2.1 Best practices doc grounding
**Legacy** test-catalog.ts PLAN prompt injects `docs/test-case-best-practices.md` (full doc) as authoritative grounding for every catalog generation. Ensures consistent categories across games.

**New:** Doesn't inject best-practices doc.

**Port priority: LOW-MEDIUM** — Output quality improvement.

### 2.2 Two-pass PLAN→EXPAND
**Legacy:**
- **PLAN pass:** AI generates 40-60 case stubs (id, name, category, rationale)
- **EXPAND pass:** AI fills in `setup_instructions`, `expected_bet`, `custom_assertions` per stub
- Quality > single-pass

**New:** Already uses this via `generateTestCaseCatalog()` (ported in v4). ✓

### 2.3 Catalog validator + coverage rules
**Legacy:**
- `catalog-validator.ts` — 40+ rules on check_code (forbidden raw fields, RNG-independent, etc.)
- `catalog-coverage-rules.ts` — coverage enforcement (category balance, severity distribution)
- Validation report saved to `fixtures/specs/<slug>.catalog-validation-report.json`

**New:** Validators run inside `generateTestCaseCatalog()` (inherited from legacy via reuse). Coverage rules also inherited. ✓

### 2.4 Catalog-driven Playwright spec generation
**Legacy** `generatePlaywrightTest()` / `generateParameterizedTestCode()`:
- Generates `tests/generated/<slug>.spec.ts` (1500-3000 LOC)
- Each test case → `test()` block with imports, setup, spin loop, assertions
- AI writes TypeScript that calls harness API (`openGame`, `doAutoSpin`, etc.)
- Output: ready-to-execute Playwright spec

**New:**
- step7 outputs `testcases.yaml` (declarative) — read by scenario-runner
- No Playwright `.spec.ts` generation
- No code-gen at all

**Port priority: LOW** — New pipeline drives directly via orchestrator. Generated .spec.ts is a side artifact only useful if user wants to inspect/modify tests manually.

### 2.5 Catalog markdown export (QA review)
**Legacy** `catalog-markdown.ts:catalogToMarkdown()`:
- Each case → markdown bullets: Step / Input / Expected
- Human-readable export for QA validation before run
- Endpoint `/test-cases.md` + `/test-cases.csv`

**New:**
- `step7/yaml-writer.ts` outputs YAML only
- No markdown export
- No CSV

**Port priority: MEDIUM** — QA reviewers want this format.

### 2.6 Scenario-only hybrid spec
**Legacy** `generateHybridTestCode()`:
- Uses captured scenarios (no_win, bonus_trigger, etc.) → mocked Playwright tests
- $0 AI cost at runtime (deterministic)
- Hybrid mode: catalog cases that match scenarios → mock; others → live execution

**New:**
- step8-run-scenarios/ui-mode.ts runs live (no mocked scenarios)
- No deterministic scenario replay

**Port priority: MEDIUM-HIGH** — Critical for CI lanes (lane:pr, lane:nightly) where live spins are too slow/expensive.

## What NEW pipeline already does for generate

| Capability | Legacy | New | Verdict |
|---|---|---|---|
| AI catalog (2-pass PLAN→EXPAND) | ✓ | ✓ (ported v4) | parity |
| Catalog validator (40+ rules) | ✓ | ✓ (reused via call) | parity |
| Coverage enforcement | ✓ | ✓ (reused) | parity |
| `custom_assertions` executable | ✓ | ✓ (step9 CustomAssertionRule) | parity |
| GameSpec input | required | built from registry | parity |
| Best practices doc grounding | ✓ | partial (defaults) | legacy slightly better |
| Save to JSON | `<slug>.test-cases.json` | `registry/<slug>/test-cases.json` | parity (different path) |
| Playwright spec gen | ✓ | ❌ | legacy only (new doesn't need it) |
| Markdown export | ✓ | ❌ | legacy better for QA review |
| CSV export | ✓ | ❌ | legacy better |
| Hybrid scenario mock | ✓ | ❌ | **legacy better** for CI |
| Best Practices §18 advanced cats | ✓ (rules_consistency, payout_correctness, wild_substitution) | partial | legacy better |
| Registry caching of catalog | regenerate each call | cached in `<slug>/test-cases.json` | **new better** |

---

# PHASE 3 — RUN TESTS (legacy) ↔ Steps 8–11 (new)

## What legacy RUN does that new doesn't

### 3.1 Vision-driven runtime fallback
**Legacy** `test-harness.ts`:
- `doAutoSpin()` clicks spin → uses vision to detect "done spinning" if no DOM signal
- `decideNextAction()` per click decision
- `readScreenValues()` OCR balance/bet/win every spin if QA_SKIP_UI_VERIFY≠1
- Per-spin cost: $0.10-0.20

**New:**
- Per-spin AI = BANNED (policy)
- Pixel diff + network capture only

**Port priority: NONE** — Different design philosophy. New stays pure deterministic.

### 3.2 UI verification (vision vs API)
**Legacy** `ui-verifier.ts:assertScreenMatchesAPI()`:
- After spin: OCR balance/bet/win from canvas
- Compare to API response with 0.01 tolerance
- Catches UI/API mismatch bugs

**New:**
- `step9-verify/ui-rule.ts` is STUB
- No OCR at runtime

**Port priority: MEDIUM** — Important for catching display bugs, but expensive ($/spin). Could be opt-in.

### 3.3 History panel cross-check
**Legacy** `assertHistoryMatches()`:
- Open history → OCR rows → match to captured spins (round_id, bet, win, balance)
- Detects: missing rows, wrong values, server-side history bugs

**New:**
- `step9-verify/history-rule.ts` is STUB

**Port priority: MEDIUM-HIGH** — Real-world bug catcher.

### 3.4 Buy feature deduction verification
**Legacy** `detectBuyFeatureDeduction()`:
- Clicks Buy Feature → checks balance decreased by exact cost
- Verifies state transitions to BONUS
- Tracks free spin chain progression

**New:**
- `step9-verify/buy-bonus-rule.ts` does balance check
- No buy click automation
- No state machine assertion across chain

**Port priority: MEDIUM** — Buy feature is most error-prone area in slot games.

### 3.5 Cascade-aware balance chain
**Legacy** `balanceChainsFromPreviousRound()`:
- Group responses by round id or isEndRound flag
- Compare current group's startingBalance to previous group's endingBalance
- Handles 3-5 frames per UI spin correctly

**New:**
- `step10-statistical/dedup.ts` groups frames by roundId (v4 fix)
- `step9-verify/financial-rule.ts` checks balance EACH spin (incorrectly for cascade — fails on intermediate frames)

**Port priority: HIGH** — current `financial-rule` flags false positives on cascade games. Need cascade-aware chain.

### 3.6 Payout-correctness rule
**Legacy** `rule-engine.ts:assertPayoutMatchesPaytable()`:
- Decode reels from matrix
- Apply mechanic (ways/paylines/cluster) + paytable
- Calculate expected win
- Compare to server win
- Catches server payout bugs

**New:**
- `step9-verify/payline-math-rule.ts` is STUB

**Port priority: MEDIUM** — Most QA tools don't have this; differentiator if working.

### 3.7 Pre-game recording + replay (also Phase 1)
See 1.6. Used at runtime to skip pre-game vision iterations.

### 3.8 Case action recording + replay
**Legacy** `case-action.ts`:
- Record per-case UI flow (bet setup, buy click, special bet enable)
- `fixtures/case-actions/<slug>/<caseId>/recording.json` + `baseline.png`
- Replay on subsequent runs, fallback to LLM if baseline diff > threshold

**New:**
- `step8-run-scenarios/scenario-runner.ts` has scenario step kinds but no recording

**Port priority: MEDIUM** — Big speedup, especially for buy_feature / special_bet cases.

### 3.9 Per-case Playwright reporter
**Legacy** `case-reporter.ts`:
- Emits `EVENT:case_end` per Playwright test
- Streamed to dashboard via SSE
- Per-case duration + status + error categorization

**New:**
- `step11-report` writes final JSON only
- No mid-run case events
- No error categorization

**Port priority: LOW-MEDIUM** — UX in dashboard.

### 3.10 Statistical simulation (API mode)
**Legacy** `statistical/simulate.ts`:
- Fire spin endpoint directly (no UI) — 10k+ spins
- Aggregate RTP, hit rate, volatility, feature freq
- Output rich SimulateResult with mismatch examples

**New:**
- `step8-run-scenarios/api-mode.ts` wraps simulate.ts ✓
- `step10-statistical/aggregator.ts` adds dedup + raw stats

**Port priority: DONE** ✓

## What NEW pipeline already does for run

| Capability | Legacy | New | Verdict |
|---|---|---|---|
| Smoke spin | inline | step3-smoke | parity |
| Pixel-diff stability detection | none (vision-only) | step8 ui-mode + dismiss-overlays | **new better** |
| Network-confirmed spin (no AI) | ❌ | step8 waitForSpinResponse | **new better** |
| Cascade dedup | partial | step10/dedup.ts | **new better** |
| Rule engine | invariants + custom_assertions | 11 rules + CustomAssertionRule | parity-ish |
| Statistical aggregation | RTP/hit/volatility | + features/winDistribution/raw | **new better** |
| PDF report | Playwright HTML only | + custom PDF | **new better** |
| Per-spin AI | yes (banned in new) | ❌ banned | **new better** (policy) |
| Cold→Warm reuse | partial | full Registry-based | **new better** |
| Dashboard integration | legacy /dashboard | new /qa.html + API | **new better** |

---

# PORTING PROPOSAL (priority order)

## Tier 1: HIGH priority (significantly improves catalog quality + correctness)

1. **Rules markdown extractor** → `step7-testcase-gen/extract-rules.ts` or `step4-feature-discovery/rules-page-detector.ts`
   - Port `extractPlayScreenSnapshot` + `transcribeRulesPage` (or simpler: just OCR paytable popup once)
   - Output: `registry/<slug>/rules.md` → feeds AI catalog gen
   - Effort: 2 days

2. **Execution strategy detection** → `step6-build-model/execution-strategy.ts`
   - Port logic detecting completion_signal method per game (cascade/single/ws)
   - Add to GameSpec built by build-game-spec.ts
   - Effort: 1 day

3. **Preflight validator** → `step6-build-model/preflight.ts` or `step9-verify/preflight-rule.ts`
   - Port `runExecutionPreflight` — schema + sample checks
   - Block test run if preflight fails (wallet snapshot, bet=0, etc.)
   - Save to `registry/<slug>/preflight.json`
   - Effort: 1 day

4. **Cascade-aware balance chain rule** → fix `step9-verify/financial-rule.ts`
   - Use roundId grouping like dedup.ts
   - `balanceChainsFromPreviousRound()` equivalent
   - Effort: 0.5 day

## Tier 2: MEDIUM-HIGH priority (porting capability)

5. **Scenario extraction** → `step10-statistical/extract-scenarios.ts` (NEW step or extension)
   - Classify response labels (no_win, bonus_trigger, free_spin, big_win, max_win)
   - Save to `registry/<slug>/scenarios/<label>.json`
   - Effort: 1 day

6. **Hybrid scenario mock mode** → `step8-run-scenarios/scenario-mock.ts`
   - Deterministic spin via injected scenario response (no real API call)
   - Use for lane:pr / fast-CI
   - Effort: 1 day

7. **History reconciliation rule** → `step9-verify/history-rule.ts` (currently stub)
   - Open history popup → OCR rows → match captured spins
   - Effort: 1.5 days

8. **Case action recording + replay** → extend `step8-run-scenarios/scenario-runner.ts`
   - Record buy/special_bet/bet-setup clicks on first run
   - Replay on subsequent runs, fallback to LLM if baseline diff
   - Effort: 1.5 days

9. **AI fallback for spin endpoint detection** → wire `step5-spin-api-detect/ai-rank.ts`
   - Currently a stub returning null
   - Use when heuristic score < threshold
   - Effort: 0.5 day

## Tier 3: MEDIUM priority (output polish + QA UX)

10. **Catalog markdown + CSV export** → `step7/md-writer.ts` + `csv-writer.ts`
    - Reuse `catalogToMarkdown` + `catalogToCsv` from legacy
    - Endpoints `/api/qa/games/:slug/test-cases.{md,csv}`
    - Effort: 0.5 day

11. **Payout-correctness rule** → wire `step9-verify/payline-math-rule.ts`
    - Decode reels → apply mechanic + paytable → compare server win
    - Reuse `src/adapters/mechanics/*` and `assertPayoutMatchesPaytable`
    - Effort: 1.5 days

12. **UI verifier (OCR balance vs API)** → wire `step9-verify/ui-rule.ts`
    - Opt-in only (cost-aware)
    - Reuse `readScreenValues` / `transcribePlayScreenValues`
    - Effort: 1 day

13. **Per-case event streaming** → `step8-run-scenarios/event-emitter.ts`
    - Emit `case_start` / `case_end` events during run
    - Surface in dashboard via SSE
    - Effort: 0.5 day

## Tier 4: LOW priority (UX nice-to-have)

14. **Pre-game recording + replay** → `step3-smoke/pregame-record.ts` / `pregame-replay.ts`
    - Speed up warm-start by 20-30s
    - Effort: 1 day

15. **Bug summarizer** (already noted) → wire `step11-report/ai-explainer.ts`
    - Post-FAIL: AI explains root cause from rule failures
    - Effort: 0.5 day

## What we SHOULD NOT port (preserve new pipeline advantages)

| Legacy capability | Why skip |
|---|---|
| Per-spin AI calls (decideNextAction, readScreenValues every spin) | Violates new pipeline AI policy. Use pixel-diff + network-confirmed spin instead |
| Playwright .spec.ts code generation | Orchestrator drives directly; .spec.ts is dead artifact |
| Generated test code via AI | Replaced by templates + custom_assertions (declarative) |
| 3-phase manual orchestration | Cold/warm auto-orchestration is cleaner |
| `fixtures/specs/` + `tests/generated/` split | Unified `fixtures/registry/` is cleaner |
| QA_PHASE env var conditional execution | Single cold-start CLI |

---

## Estimated total effort

| Tier | Effort | Cumulative |
|---|---|---|
| Tier 1 (4 items) | 4.5 days | 4.5 days |
| Tier 2 (5 items) | 6.5 days | 11 days |
| Tier 3 (4 items) | 3.5 days | 14.5 days |
| Tier 4 (2 items) | 1.5 days | 16 days |

---

## Recommendation

**Start with Tier 1 only (4.5 days)** — biggest correctness wins:
1. Rules markdown extractor (catalog quality)
2. Execution strategy detection (provider-correctness)
3. Preflight validator (early failure detection)
4. Cascade-aware balance rule (eliminate false positives in current report)

After Tier 1 → re-evaluate. New pipeline at that point will have ~33+ cases per game (matching legacy density) + working preflight + correct cascade rules.

Tier 2+ depends on user priorities (CI cost, history bug catching, etc.).
