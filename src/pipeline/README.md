# `src/pipeline/` — Slot-Game QA 11-Step Pipeline

Tổ chức theo [docs/architecture.md](../../docs/architecture.md) + [docs/steps.md](../../docs/steps.md), với **Cold/Warm-Start Architecture** và **Feature Discovery + Template-driven Testcase Generation**.

## Nguyên tắc cốt lõi

1. **Deterministic rule engine là core.** AI **không** quyết định PASS/FAIL tài chính/RTP.
2. **AI scope = discovery + recovery + (opt-in) failure-explanation.** Không bao giờ per-spin.
3. **Registry layer** persist mọi discovery output (UI coords, features, API mapping, parser, OCR regions, ...). Subsequent runs load registry và skip AI.
4. **Cold start (first run) ≠ Warm start (subsequent run).** Recovery path khi cache invalid.
5. **Feature Discovery → Template Engine.** AI không sinh testcase từ đầu; nó chỉ điền tham số vào template được chọn theo feature đã detect.

## 11-step flow

```
1.  Crawl Game             → step1-crawl/
2.  Detect UI Elements     → step2-detect-ui/ + step2-5-validate-registry/
3.  Capture Network        → step3-capture-network/ + step3-smoke/ (driver)
4.  Feature Discovery      → step4-feature-discovery/   (NEW)
5.  API Detection          → step5-spin-api-detect/
6.  Build Game Model       → step6-build-model/         (parser + state machine + provider)
7.  Generate Testcases     → step7-testcase-gen/        (templates + AI param-fill)
8.  Run Scenarios          → step8-run-scenarios/       (UI mode ≤200 / API mode >200)
9.  Verify UI/API/Logic    → step9-verify/              (rule engine)
10. RTP / Statistical      → step10-statistical/
11. Report                 → step11-report/             (JSON + HTML + PDF)
```

## Layout

```
pipeline/
├── registry/                       # Persistent cache: ui, features, API, parser, OCR, paytable, ...
├── step1-crawl/                    # Open URL, iframe/canvas/provider detect
├── step2-detect-ui/                # DOM → OCR → template → AI vision chain
├── step2-5-validate-registry/      # Warm-start sanity check vs live state
├── step3-capture-network/          # XHR/WS recorder + storage
├── step3-smoke/                    # Smoke spin driver (used by step3 capture)
├── step4-feature-discovery/        # Hybrid: UI + network + paytable + gameplay + AI
├── step5-spin-api-detect/          # Heuristic score + AI rank + confirm
├── step6-build-model/              # BaseParser → Pragmatic/Generic + state machine
├── step7-testcase-gen/             # Templates per-feature + AI param fill
├── step8-run-scenarios/            # UI mode + API mode
├── step9-verify/                   # Financial / free-spin / jackpot / state / paytable / payline / history rules
├── step10-statistical/             # RTP / hit-rate / volatility / feature-frequency
├── step11-report/                  # JSON / HTML / PDF
├── orchestrator/                   # cold-start | warm-start | recovery | mode-detector
└── cli/                            # ~18 npm-runnable scripts
```

## Cold Start vs Warm Start

```
Cold (no registry):                          Warm (registry exists):
  open-game                                    open-game
  → discover-ui                                → load-ui-registry
  → capture-network 10 spins                   → load-provider-cache
  → discover-features ← NEW                    → validate-ui-registry
  → detect-apis                                → [VALID] skip AI/discovery
  → build-game-model                           → run-scenario
  → generate-testcases (template-driven)       → verify-* (rule engine)
  → run-scenarios                              → run-spins 10k (API mode)
  → verify-* (rule engine)                     → calculate-rtp
  → run-spins 10k                              → generate-report
  → calculate-rtp
  → generate-report
                                             Recovery (registry invalid):
                                               validate FAIL
                                                 → ai-recover-locator <element>
                                                 → update-ui-registry
                                                 → retry warm-start (max 1)
```

## Step 4 — Feature Discovery (hybrid)

5 detector sources, mỗi cái sinh `FeatureSignal[]`, aggregator merge thành `FeatureRegistry`:

| Source | Detector | Confidence floor |
|---|---|---|
| `ui` | `ui-detector.ts` — UI registry buttons present (`buyBonusButton` → `buyBonus`) | 0.9 |
| `network` | `network-detector.ts` — regex over captured req/res bodies (`FREE_SPIN`, `multiplier`, ...) | 0.85 |
| `paytable` | `paytable-detector.ts` — text patterns in `paytable.json` features/symbols | 0.9 |
| `gameplay` | `gameplay-detector.ts` — observed `isFreeSpin`, `hasBonus`, `state === RETRIGGER`, `cascadeFrames.length>0` | 0.95+ |
| `ai` | `ai-detector.ts` — one-shot cross-check (stub now, wire `@anthropic-ai/sdk` later) | varies |

Output: `{ features: { buyBonus: {present, confidence, sources}, freeSpin: {...}, ... }, signals: [...] }` saved to `feature-registry.json`.

## Step 7 — Testcase Generation (templates + AI fill)

`templates.ts` chứa các template per-feature. Engine logic:

1. Loop qua `TEMPLATES` (14+ templates phủ core + 13 features)
2. Skip template nếu feature không present trong `FeatureRegistry`
3. Skip template nếu thiếu params bắt buộc (e.g. `spinApi` chưa detect)
4. Interp `${spinButton}`, `${buyBonusApi}`, `${freeSpinCounter}` từ uiMap / api / ocrRegions / popupRegions
5. Optional: AI augment (off by default)

Feature → template mapping (excerpt):

| Feature | Templates |
|---|---|
| `core` | smoke-load, balance-deduct, rtp-range |
| `buyBonus` | buyBonus.exact-cost |
| `freeSpin` | freeSpin.no-deduct, freeSpin.counter-decreases |
| `respin` | respin.retrigger |
| `multiplier` | multiplier.applied |
| `gamble` | gamble.win-lose |
| `jackpot` | jackpot.added-once |
| `history` | history.persistence |
| `paytable` | paytable.content |
| `turbo` | turbo.faster |
| `autoSpin` | autoSpin.stop |

## CLI commands

Mode auto-detect: `npm run qa -- --url <url>` or `--game <slug>`.

| Command | Step | Purpose |
|---|---|---|
| `qa` | all | Auto cold/warm, full pipeline |
| `qa:cold` | all | Force cold start |
| `qa:warm` | all | Force warm start |
| `open-game` | 1 | Open URL + init registry meta |
| `discover-ui` | 2 | DOM→OCR→template→AI chain, save ui-registry.json |
| `validate-ui-registry` | 2.5 | Pixel-diff sanity check cached coords |
| `capture-network` | 3 | Smoke 10 spins, save network.jsonl |
| `discover-features` | 4 | UI+network+paytable+gameplay+AI feature detection |
| `detect-provider` | 1+5 | URL/iframe → provider |
| `detect-apis` | 5 | Score candidates, save api-mapping.json |
| `generate-testcases` | 7 | Template engine → testcases.yaml |
| `run-scenario` | 8 | Execute testcases via warm-start |
| `verify-ui` / `verify-api` / `verify-balance` | 9 | Rule-engine subsets |
| `run-spins` | 8 | Massive spin batch |
| `calculate-rtp` | 10 | RTP/hit-rate/volatility |
| `generate-report` | 11 | Build JSON + HTML + PDF |
| `ai-recover-locator` | recovery | One-shot AI recover broken element |
| `load-ui-registry`, `load-provider-cache`, `save-ui-registry`, `save-provider-cache` | aux | Print/check persisted state |

## Registry files (`fixtures/registry/<gameSlug>/`)

| File | Owner | Schema |
|---|---|---|
| `_meta.json` | meta | schemaVersion, createdAt, gameUrl, lastValidatedAt |
| `ui-registry.json` | step2 | spinButton/autoButton/buyBonusButton/... with x/y/strategy/confidence |
| `provider-cache.json` | step1 | provider, gameName, platform, iframe/canvas count |
| `feature-registry.json` | step4 | signals[] + features map (present + confidence + sources) |
| `api-mapping.json` | step5 | spinApi/historyApi/buyBonusApi URLs + methods |
| `field-mapping.json` | step5 | bet/win/balance/roundId/reels keys |
| `parser.json` | step6 | parser kind + version |
| `ocr-regions.json` | step2+ | bbox of balance/win/freeSpinCounter |
| `state-signatures.json` | step6 | how to detect FREE_SPIN/BONUS by OCR/template |
| `paytable.json` | step7 | expected paytable (cached from cold) |
| `popup-regions.json` | step7 | bbox of paytable/history/buy-bonus popups |
| `testcases.yaml` | step7 | generated test scenarios |

## AI scope policy (enforced)

Philosophy: **AI = bootstrap tool, NOT realtime driver.** With 10,000 spins, total AI calls should be 1–10 (during cold-start discovery), not 20,000.

### Allowed AI files

Each must include header `// AI: called only during cold-start | recovery | post-FAIL`:
- `step2-detect-ui/ai-vision-strategy.ts` (discovery)
- `step2-detect-ui/ai-recover-locator.ts` (recovery)
- `step4-feature-discovery/ai-detector.ts` + `paytable-detector.ts` (discovery)
- `step5-spin-api-detect/ai-rank.ts` (discovery)
- `step7-testcase-gen/ai-augment.ts` (cold-start only)
- `step11-report/ai-explainer.ts` (opt-in post-FAIL)

### Banned

AI is BANNED in these runtime dirs:
- `step8-run-scenarios/*`
- `step9-verify/*`
- `step10-statistical/*`
- `utils/pixel-diff/*`

### Runtime substitutes for AI

How to verify state WITHOUT calling AI:
- **Network-driven**: parser → `NormalizedSpinResult.state` (most reliable)
- **Pixel-diff**: `diffAroundAction`, `waitUntilStable`, `detectFreeze`, `detectBlackScreen`, `diffVsBaseline`
- **OCR (deterministic)**: tesseract.js on a known region from `ocr-regions.json` / `state-signatures.json`
- **State signatures**: cached template PNG at known region → `diffVsBaseline`
- **Scenario runner**: `step8-run-scenarios/scenario-runner.ts` executes testcases.yaml using `waitForState()`

### Automated audit

```bash
npm run audit:ai-scope
# [ok] AI scope policy clean — exit 0
# [fail] ... — exit 1 (CI-failable)
```

The audit verifies:
1. Runtime dirs contain ZERO AI references.
2. AI references in `src/pipeline/**` appear ONLY in the allow-list above.
3. Every allowed AI file has the policy header.

## Status

- ✅ Phase 1: Foundation + registry layer + step1..11 + orchestrator skeletons (compile)
- ✅ Phase 2: Pragmatic + Generic parsers wired, simulate.ts wrapped as step8 api-mode
- ✅ Phase 3 (partial): rule types + statistical aggregator + step10/step11 working; OCR/template/AI strategies STUB
- ✅ Phase 4: cold/warm/recovery orchestrators + 18 CLI commands + package.json scripts
- ✅ Phase 5: step4 Feature Discovery + step7 Template Engine wired into cold-start

Remaining stubs to wire:
- `tesseract.js` in `step2-detect-ui/ocr-strategy.ts` + `step9-verify/ui-rule.ts`
- `@anthropic-ai/sdk` in `step2-detect-ui/ai-vision-strategy.ts`, `step4-feature-discovery/ai-detector.ts`, `step5-spin-api-detect/ai-rank.ts`, `step7-testcase-gen/ai-augment.ts`
- pixel-diff validation in `step2-5-validate-registry/validator.ts`
- API-mode result spins decoding in `step8-run-scenarios/api-mode.ts`
- Real game-logic in `step9-verify/payline-{math,visual}-rule.ts`, `paytable-rule.ts`, `history-rule.ts`

## Out of scope (deferred)

- Test matrix (currency / bet / language / env)
- Admin/ops testing (account active, game inactive)
- Multi-env (production smoke)
- JILI/PGSoft/Evolution providers
- Embedded screenshots/logs in PDF, AI root-cause summary
