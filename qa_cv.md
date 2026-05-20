
# TRAN THUCC  
Hà Nội, Việt Nam  
📞 09xxxxxxxx  
📧 hocre.net@gmail.com  
💻 GitHub: github.com/yourgithub  
🔗 LinkedIn: linkedin.com/in/yourlinkedin  

---

# SENIOR QA ENGINEER (WEB / MOBILE / GAME / BLOCKCHAIN)

Senior QA Engineer with 6 years of experience in software quality assurance, including 3 years in Manual Testing and 3 years in Automation Testing. Experienced across Web, Mobile, Game, Blockchain, AI systems, and real-time platforms. Strong background in building automation frameworks, API validation systems, CI/CD pipelines, and scalable QA strategies for modern applications.

Recently shipped an AI-assisted QA automation platform for casino/slot canvas games — combining Playwright deterministic testing, statistical math validation, and Claude LLM-driven test generation.

Experienced working with international remote teams and fluent in English communication.

---

# PROFESSIONAL SUMMARY

- 6 years of QA experience:
  - 3 years Manual Testing
  - 3 years Automation Testing
- Strong experience in Web, Mobile, Game, and Blockchain QA
- Hands-on experience with Playwright, Selenium, Appium, WebdriverIO, Maestro
- Experience testing React Native applications
- Strong knowledge of CI/CD pipelines and cloud environments
- Experience testing APIs, WebSocket systems, real-time data systems
- Hands-on experience integrating LLMs (Anthropic Claude SDK) into QA workflows for test generation, bug summarization, and vision-based UI verification
- Built statistical validation systems for slot/casino math (RTP, volatility, hit frequency over 10k–100k spins)
- Familiar with Agile/Scrum development processes
- Strong analytical and debugging skills

---

# TECHNICAL SKILLS

## Automation Testing
- Playwright
- Selenium
- Appium
- Maestro
- WebdriverIO
- Jest
- Cypress

## Manual Testing
- Functional Testing
- Regression Testing
- Smoke Testing
- UAT Testing
- Cross-browser Testing
- Mobile Testing
- Exploratory Testing

## Programming
- JavaScript
- TypeScript
- Node.js
- Python
- Ruby

## CI/CD & DevOps
- GitLab CI/CD
- GitHub Actions
- Docker
- Kubernetes
- AWS
- GCP Cloud Run
- Helm
- ArgoCD

## Backend & Database
- PostgreSQL
- Prisma ORM
- Redis
- BullMQ
- REST API
- WebSocket
- GraphQL

## AI / LLM Integration
- Anthropic Claude SDK (`@anthropic-ai/sdk`, `claude-agent-sdk`)
- Vision-based UI verification (OCR + screenshot reasoning)
- AI-driven test catalog generation
- AI bug summarization & grouping
- Prompt engineering for QA automation

## Blockchain & Web3
- Wallet Testing
- Smart Contract Interaction Testing
- Transaction Validation
- Web3 Authentication
- Solana ecosystem understanding
- MetaMask integration testing

## Game QA
- RTP Validation & 95% Confidence Intervals
- Volatility, Hit Frequency, Feature Frequency analysis
- Symbol distribution & paytable verification
- Spin Simulation (deterministic mock + live endpoint)
- Game Logic Testing across Ways / Paylines / Cluster mechanics
- Provider × Mechanic adapter design (Pragmatic Play, generic)
- Balance reconciliation (free-spin aware)
- Pixel-diff region snapshots & JSON shape snapshots
- API/UI cross-validation via vision OCR
- Performance & stress testing

---

# WORK EXPERIENCE

## Senior QA Engineer / Automation Engineer  
### Freelance & Product-based Projects  
📍 Remote | 2022 – Present

### Responsibilities
- Built automation testing frameworks for web and mobile applications.
- Developed end-to-end automation testing using Playwright and Selenium.
- Created CI/CD validation pipelines integrated with GitLab CI and GitHub Actions.
- Tested React Native applications and mobile automation flows.
- Performed API testing, WebSocket validation, and backend verification.
- Worked closely with developers and product teams in Agile environments.
- Designed QA strategy and automated regression systems.

### Key Achievements
- Reduced manual regression testing time by over 70%.
- Improved deployment stability through automated validation pipelines.
- Built reusable automation architecture for multiple projects.

---

## QA Engineer (Manual Testing)  
### Software Outsourcing & Client Projects  
📍 Hà Nội | 2019 – 2022

### Responsibilities
- Performed manual testing for web and mobile applications.
- Wrote detailed test cases and bug reports.
- Conducted cross-browser and device compatibility testing.
- Collaborated with developers and PMs to ensure release quality.
- Participated in UAT and production verification.

### Key Achievements
- Successfully tested multiple large-scale client projects.
- Improved bug detection rate before production release.
- Helped standardize QA workflows across projects.

---

# PROJECT EXPERIENCE

## Blockchain Trading Platform QA
### Technologies:
Playwright, Node.js, WebSocket, Redis, PostgreSQL

### Responsibilities
- Tested wallet login flows and blockchain transaction systems.
- Validated real-time trading data and candle generation systems.
- Performed API and WebSocket testing.
- Tested authentication flows using Web3 wallets.

### Highlights
- Verified transaction consistency between frontend and backend.
- Automated validation for real-time trading features.

---

## AI-Assisted QA Automation Platform for Slot / Casino Canvas Games (`crawler-qa-agent`)
### Technologies:
TypeScript, Node.js, Playwright, Anthropic Claude SDK, PostgreSQL, Prisma, Redis, BullMQ, Docker, Pixelmatch, Vanilla JS Dashboard (SSE)

### Overview
End-to-end QA automation platform combining deterministic Playwright tests, AI-driven discovery, and statistical math validation for canvas-based slot games (Pragmatic Play and generic providers). Designed to drive cost-per-run from $5–15 (vision-only) down to $0–0.20 (deterministic replay) while expanding coverage from 13 hand-written to 33 AI-generated test cases per game.

### Responsibilities
- Designed the three-flow architecture: (A) LLM-driven discovery for new games, (B) deterministic regression replay, (C) statistical math simulation over 10k–100k spins.
- Built the **GameAdapter** abstraction — Provider × Mechanic composition supporting Ways, Paylines, and Cluster (cascade) pay mechanics.
- Implemented the **Rule Engine** for per-spin invariants: reel decoding, ways/paylines/cluster payout math, paytable assertion, balance reconciliation (free-spin aware).
- Built the **Statistical Simulator** firing concurrent spin requests directly to game endpoints — computing RTP with 95% CI, volatility (Welford variance), hit frequency, feature frequency, symbol distribution, and win-distribution buckets.
- Built **Pre-game Click Replay** with pixel-diff verification (Pixelmatch) and auto-heal fallback to Claude vision when baselines drift.
- Integrated **Anthropic Claude** for game spec extraction, test-catalog generation (33 cases per game), vision OCR (UI ↔ API balance cross-check), and AI bug summarization.
- Designed the **Hybrid Case Mapper** that codegens deterministic Playwright specs from AI-generated test catalogs.
- Built the **Dashboard** (HTTP + vanilla JS + SSE) for task orchestration, real-time logs, spin events, and DB-backed test-run history.
- Implemented **DB write-through** with PostgreSQL + Prisma (4 tables: test_runs, spin_results, validation_errors, stat_reports), env-gated for optional usage.
- Wired **Redis + BullMQ** for distributed statistical jobs with a dedicated worker process.
- Authored Playwright reporter plumbing to surface per-case results via structured `EVENT:case_end` events.

### Highlights
- Reduced typical regression cost from **$5–15 → $0–0.20** per game run by routing to deterministic mocks when scenarios exist.
- Shrank a 30–60 minute vision-per-spin run to **~5 minutes** for 33 cases via hybrid deterministic specs.
- Achieved **~88% replay success** with vision fallback on the remaining ~12% (instrumented via `_stats.jsonl` aggregator CLI).
- All 32/32 Playwright tests passing with clean TypeScript typecheck.
- Wrote living architecture documentation (`docs/system-overview.md`, `docs/architecture.md`, `docs/dashboard-guide.md`) covering data lifecycle, smart routing, API surface, and configuration.
- Designed the system so filesystem fixtures remain the source of truth and the database is an indexed view — keeping the toolchain reproducible without DB infrastructure.

---

## Mobile Application Testing (React Native)
### Technologies:
Appium, Maestro, React Native

### Responsibilities
- Tested mobile authentication and navigation flows.
- Validated API synchronization and UI behavior.
- Performed automation testing on Android/iOS platforms.

### Highlights
- Built reusable mobile automation scripts.
- Reduced manual testing workload significantly.

---

## E-commerce Automation Testing
### Technologies:
Playwright, Selenium, GitLab CI

### Responsibilities
- Automated checkout, payment, and user management flows.
- Implemented cross-browser testing pipelines.
- Integrated automation into CI/CD systems.

### Highlights
- Improved release confidence and deployment quality.
- Reduced regression testing time dramatically.

---

# EDUCATION

## Information Technology  
Vietnam

---

# LANGUAGES

- Vietnamese — Native
- English — Fluent

---

# ADDITIONAL INFORMATION

- Strong remote working capability
- Fast learner and adaptable
- Experience collaborating with international teams
- Strong debugging and analytical mindset
- Passionate about automation and product quality