# QA Diff Review Checklist

Generated at: 2026-05-19T19:54:36.040Z
Changed files: 90

## File Delta

| File | Status | Hunk Starts | Zone |
|---|---|---|---|
| docker-compose.yml | untracked | - | Other |
| docs/ai_powered_slot_game_testing.md | untracked | - | Docs And Checklist |
| docs/architecture.md | untracked | - | Docs And Checklist |
| docs/automation-85-90-checklist.md | untracked | - | Docs And Checklist |
| docs/dashboard-guide.md | untracked | - | Docs And Checklist |
| docs/improvement-report.md | untracked | - | Docs And Checklist |
| docs/system-overview.md | untracked | - | Docs And Checklist |
| docs/test-game-workflow.md | untracked | - | Docs And Checklist |
| package.json | modified | 11, 20, 45, 52, 58, 60, 63, 65 | Lanes And Automation |
| playwright.config.ts | modified | 14 | Other |
| prisma/migrations/20260516005906_init/migration.sql | untracked | - | Other |
| prisma/migrations/migration_lock.toml | untracked | - | Other |
| prisma/schema.prisma | untracked | - | Other |
| src/adapters/compose.ts | untracked | - | Other |
| src/adapters/games/README.md | untracked | - | Docs And Checklist |
| src/adapters/index.ts | untracked | - | Other |
| src/adapters/mechanics/cluster.ts | untracked | - | Other |
| src/adapters/mechanics/paylines.ts | untracked | - | Other |
| src/adapters/mechanics/ways.ts | untracked | - | Other |
| src/adapters/providers/generic.ts | untracked | - | Other |
| src/adapters/providers/pragmatic.ts | untracked | - | Other |
| src/adapters/registry.ts | untracked | - | Other |
| src/adapters/types.ts | untracked | - | Other |
| src/ai/action-library.ts | untracked | - | AI Catalog And Mapping |
| src/ai/authoring.ts | modified | 2, 176, 262, 313, 338, 563 | AI Catalog And Mapping |
| src/ai/bug-summarizer-cli.ts | untracked | - | AI Catalog And Mapping |
| src/ai/bug-summarizer.ts | untracked | - | AI Catalog And Mapping |
| src/ai/catalog-validator.ts | modified | 358 | AI Catalog And Mapping |
| src/ai/claude.ts | modified | 4, 72, 92, 110, 114, 124, 143 | AI Catalog And Mapping |
| src/ai/game-analyzer-cli.ts | untracked | - | AI Catalog And Mapping |
| src/ai/game-analyzer.ts | untracked | - | AI Catalog And Mapping |
| src/ai/hybrid-case-mapper.ts | untracked | - | AI Catalog And Mapping |
| src/ai/test-catalog.ts | modified | 50, 121, 401, 427, 503, 512, 562, 589 | AI Catalog And Mapping |
| src/ai/vision.ts | modified | 170, 203, 241, 267, 359, 374, 381 | AI Catalog And Mapping |
| src/auto-play.ts | modified | 22, 48, 129, 133, 167, 190, 267, 278, 346, 352 | Runtime And Spin Flow |
| src/db/client.ts | untracked | - | Other |
| src/db/index.ts | untracked | - | Other |
| src/db/repositories/spin-result.ts | untracked | - | Other |
| src/db/repositories/stat-report.ts | untracked | - | Other |
| src/db/repositories/test-run.ts | untracked | - | Other |
| src/db/repositories/validation-error.ts | untracked | - | Other |
| src/generate-and-run.ts | modified | 8, 396, 1028, 1053, 1116, 1169, 1174, 1188 | AI Catalog And Mapping |
| src/lanes/run-lane.ts | untracked | - | Lanes And Automation |
| src/measure-automation.ts | untracked | - | Other |
| src/measure-scenario-min.ts | untracked | - | Other |
| src/measure-skip-projection.ts | untracked | - | Other |
| src/queue/redis.ts | untracked | - | Other |
| src/queue/stats-queue.ts | untracked | - | Other |
| src/queue/stats-worker.ts | untracked | - | Other |
| src/review/generate-diff-checklist.ts | untracked | - | Other |
| src/runner/balance-reconciler.ts | untracked | - | Runtime And Spin Flow |
| src/runner/balance-trace-cli.ts | untracked | - | Runtime And Spin Flow |
| src/runner/balance-trace-export.ts | untracked | - | Runtime And Spin Flow |
| src/runner/capture-fs-via-buy.ts | untracked | - | Runtime And Spin Flow |
| src/runner/case-action.ts | untracked | - | Runtime And Spin Flow |
| src/runner/deterministic-spin.ts | untracked | - | Runtime And Spin Flow |
| src/runner/deterministic.ts | untracked | - | Runtime And Spin Flow |
| src/runner/json-snapshot.ts | untracked | - | Runtime And Spin Flow |
| src/runner/pre-game-recording.ts | untracked | - | Runtime And Spin Flow |
| src/runner/pre-game-replay.ts | untracked | - | Runtime And Spin Flow |
| src/runner/pre-game-stats-cli.ts | untracked | - | Runtime And Spin Flow |
| src/runner/pre-game-stats.ts | untracked | - | Runtime And Spin Flow |
| src/runner/pre-game.ts | modified | 2, 4, 19, 50, 64, 97, 125, 127, 167, 184, 198, 222, 241, 256 | Runtime And Spin Flow |
| src/runner/README.md | untracked | - | Runtime And Spin Flow |
| src/runner/record-ui-flows.ts | untracked | - | Runtime And Spin Flow |
| src/runner/region-snapshot.ts | untracked | - | Runtime And Spin Flow |
| src/runner/response-synthesizer.ts | untracked | - | Runtime And Spin Flow |
| src/runner/rule-engine.ts | untracked | - | Runtime And Spin Flow |
| src/runner/scenario-extractor.ts | untracked | - | Runtime And Spin Flow |
| src/runner/scenario.ts | untracked | - | Runtime And Spin Flow |
| src/runner/spin-button-resolve.ts | untracked | - | Runtime And Spin Flow |
| src/runner/spin-verify.ts | untracked | - | Runtime And Spin Flow |
| src/runner/test-harness.ts | modified | 11, 19, 24, 34, 366, 441, 550, 552, 564, 568, 572, 582, 584, 608, 625, 653, 669, 674 | Runtime And Spin Flow |
| src/runner/ui-verifier.ts | untracked | - | Runtime And Spin Flow |
| src/runner/wait-ready.ts | untracked | - | Runtime And Spin Flow |
| src/server/db-writethrough.ts | untracked | - | Other |
| src/server/index.ts | modified | 99, 296, 362, 393, 410, 817 | Other |
| src/server/queue.ts | modified | 238 | Other |
| src/server/runner.ts | modified | 8, 140, 165, 178, 236, 259, 344, 868, 884, 901, 947, 957, 1029, 1060, 1073, 1086 | Other |
| src/statistical/cli.ts | untracked | - | Other |
| src/statistical/currency-batch-cli.ts | untracked | - | Other |
| src/statistical/simulate.ts | untracked | - | Other |
| tests/adapter-resolve.spec.ts | untracked | - | Other |
| tests/deterministic-example.spec.ts | untracked | - | Other |
| tests/deterministic-hybrid.spec.ts | untracked | - | Other |
| tests/deterministic-integration.spec.ts | untracked | - | Other |
| tests/mechanics.spec.ts | untracked | - | Other |
| tests/pre-game-replay.spec.ts | untracked | - | Other |
| tests/visual-regression.spec.ts | untracked | - | Visual Regression |
| tsconfig.json | modified | 17 | Other |

## Reviewer Checklist By Zone

### AI Catalog And Mapping

Changed files:
- [ ] src/ai/action-library.ts
- [ ] src/ai/authoring.ts
- [ ] src/ai/bug-summarizer-cli.ts
- [ ] src/ai/bug-summarizer.ts
- [ ] src/ai/catalog-validator.ts
- [ ] src/ai/claude.ts
- [ ] src/ai/game-analyzer-cli.ts
- [ ] src/ai/game-analyzer.ts
- [ ] src/ai/hybrid-case-mapper.ts
- [ ] src/ai/test-catalog.ts
- [ ] src/ai/vision.ts
- [ ] src/generate-and-run.ts

Checks:
- [ ] Generated assertions remain deterministic and not RNG-event dependent
- [ ] Case strategy mapping matches intended category behavior per slug
- [ ] Catalog validation errors are actionable and do not block valid catalogs

### Docs And Checklist

Changed files:
- [ ] docs/ai_powered_slot_game_testing.md
- [ ] docs/architecture.md
- [ ] docs/automation-85-90-checklist.md
- [ ] docs/dashboard-guide.md
- [ ] docs/improvement-report.md
- [ ] docs/system-overview.md
- [ ] docs/test-game-workflow.md
- [ ] src/adapters/games/README.md

Checks:
- [ ] Checklist status matches actual verified command results
- [ ] Progress log includes exact metrics and scope disclaimers
- [ ] User-facing instructions remain consistent with current scripts

### Lanes And Automation

Changed files:
- [ ] package.json
- [ ] src/lanes/run-lane.ts

Checks:
- [ ] PR lane remains fast and deterministic
- [ ] Nightly lane includes real-network plus stats steps
- [ ] Dry-run output reflects expected execution order

### Other

Changed files:
- [ ] docker-compose.yml
- [ ] playwright.config.ts
- [ ] prisma/migrations/20260516005906_init/migration.sql
- [ ] prisma/migrations/migration_lock.toml
- [ ] prisma/schema.prisma
- [ ] src/adapters/compose.ts
- [ ] src/adapters/index.ts
- [ ] src/adapters/mechanics/cluster.ts
- [ ] src/adapters/mechanics/paylines.ts
- [ ] src/adapters/mechanics/ways.ts
- [ ] src/adapters/providers/generic.ts
- [ ] src/adapters/providers/pragmatic.ts
- [ ] src/adapters/registry.ts
- [ ] src/adapters/types.ts
- [ ] src/db/client.ts
- [ ] src/db/index.ts
- [ ] src/db/repositories/spin-result.ts
- [ ] src/db/repositories/stat-report.ts
- [ ] src/db/repositories/test-run.ts
- [ ] src/db/repositories/validation-error.ts
- [ ] src/measure-automation.ts
- [ ] src/measure-scenario-min.ts
- [ ] src/measure-skip-projection.ts
- [ ] src/queue/redis.ts
- [ ] src/queue/stats-queue.ts
- [ ] src/queue/stats-worker.ts
- [ ] src/review/generate-diff-checklist.ts
- [ ] src/server/db-writethrough.ts
- [ ] src/server/index.ts
- [ ] src/server/queue.ts
- [ ] src/server/runner.ts
- [ ] src/statistical/cli.ts
- [ ] src/statistical/currency-batch-cli.ts
- [ ] src/statistical/simulate.ts
- [ ] tests/adapter-resolve.spec.ts
- [ ] tests/deterministic-example.spec.ts
- [ ] tests/deterministic-hybrid.spec.ts
- [ ] tests/deterministic-integration.spec.ts
- [ ] tests/mechanics.spec.ts
- [ ] tests/pre-game-replay.spec.ts
- [ ] tsconfig.json

Checks:
- [ ] Review behavior and risks for this area manually

### Runtime And Spin Flow

Changed files:
- [ ] src/auto-play.ts
- [ ] src/runner/balance-reconciler.ts
- [ ] src/runner/balance-trace-cli.ts
- [ ] src/runner/balance-trace-export.ts
- [ ] src/runner/capture-fs-via-buy.ts
- [ ] src/runner/case-action.ts
- [ ] src/runner/deterministic-spin.ts
- [ ] src/runner/deterministic.ts
- [ ] src/runner/json-snapshot.ts
- [ ] src/runner/pre-game-recording.ts
- [ ] src/runner/pre-game-replay.ts
- [ ] src/runner/pre-game-stats-cli.ts
- [ ] src/runner/pre-game-stats.ts
- [ ] src/runner/pre-game.ts
- [ ] src/runner/README.md
- [ ] src/runner/record-ui-flows.ts
- [ ] src/runner/region-snapshot.ts
- [ ] src/runner/response-synthesizer.ts
- [ ] src/runner/rule-engine.ts
- [ ] src/runner/scenario-extractor.ts
- [ ] src/runner/scenario.ts
- [ ] src/runner/spin-button-resolve.ts
- [ ] src/runner/spin-verify.ts
- [ ] src/runner/test-harness.ts
- [ ] src/runner/ui-verifier.ts
- [ ] src/runner/wait-ready.ts

Checks:
- [ ] Pre-game reaches ready state consistently (no false mask failure loops)
- [ ] Spin request is fired and parsed at least once per relevant test case
- [ ] No page/context closed errors during retry/probe paths

### Visual Regression

Changed files:
- [ ] tests/visual-regression.spec.ts

Checks:
- [ ] Snapshot regions stay within viewport and avoid volatile animated zones
- [ ] Baseline naming/versioning avoids stale baseline collisions
- [ ] Visual suite runs in PR lane without unexpected flakes

## Sign-off

- [ ] QA reviewed all changed zones
- [ ] Blocking issues documented with file references
- [ ] Ready for merge / run
