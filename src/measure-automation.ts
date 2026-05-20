import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type CaseStats = {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  pending?: number;
};

type TaskRecord = {
  id: string;
  gameSlug?: string;
  status?: string;
  stage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  lastError?: string | null;
  caseStats?: CaseStats | null;
};

type BaselineSnapshot = {
  generatedAt: string;
  windowDays: number;
  totalTasks: number;
  tasksWithCaseStats: number;
  passRate: number | null;
  skipRate: number | null;
  failRate: number | null;
  flakeRateProxy: number | null;
  visionFallbackRateProxy: number | null;
  noSpinResponseRateProxy: number | null;
  statusCounts: Record<string, number>;
  topErrors: Array<{ key: string; count: number }>;
  slugCounts: Array<{ slug: string; tasks: number }>;
};

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Number(((n / d) * 100).toFixed(2));
}

function normalizedErrorKey(err: string): string {
  const e = err.toLowerCase();
  if (e.includes("no spin response") || e.includes("no spin request fired")) return "no_spin_response";
  if (e.includes("target page, context or browser has been closed")) return "page_closed";
  if (e.includes("pre-game không ready") || e.includes("pre-game khong ready")) return "pre_game_not_ready";
  if (e.includes("timeout")) return "timeout";
  if (e.includes("pipeline exited with code")) return "pipeline_exit";
  return "other";
}

function main() {
  const args = new Set(process.argv.slice(2));
  const write = !args.has("--no-write");
  const windowArg = process.argv.find((a) => a.startsWith("--days="));
  const windowDays = windowArg ? Math.max(1, Number(windowArg.split("=")[1] ?? "30")) : 30;
  const now = Date.now();
  const minTs = now - windowDays * 24 * 60 * 60 * 1000;

  const tasksPath = join("fixtures", "tasks", "index.json");
  const raw = readFileSync(tasksPath, "utf8");
  const allTasks = JSON.parse(raw) as TaskRecord[];

  const recent = allTasks.filter((t) => {
    const ts = t.finishedAt ?? t.startedAt;
    if (!ts) return false;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= minTs;
  });

  const statusCounts: Record<string, number> = {};
  const slugCountMap = new Map<string, number>();
  const errorCounts = new Map<string, number>();

  let tasksWithCaseStats = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalCases = 0;

  let flakeNumerator = 0;
  let flakeDenominator = 0;
  let fallbackHits = 0;
  let noSpinHits = 0;

  for (const t of recent) {
    const status = t.status ?? "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const slug = t.gameSlug ?? "unknown";
    slugCountMap.set(slug, (slugCountMap.get(slug) ?? 0) + 1);

    if (t.caseStats) {
      tasksWithCaseStats++;
      const cs = t.caseStats;
      const tp = safeNum(cs.passed);
      const tf = safeNum(cs.failed);
      const ts = safeNum(cs.skipped);
      const tt = safeNum(cs.total);
      passed += tp;
      failed += tf;
      skipped += ts;
      totalCases += tt;

      // Proxy flake: tasks with both pass and fail in same run tend to indicate instability.
      if (tp > 0 && tf > 0) flakeNumerator++;
      flakeDenominator++;
    }

    const e = t.lastError;
    if (typeof e === "string" && e.trim()) {
      const key = normalizedErrorKey(e);
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
      if (key === "pre_game_not_ready") fallbackHits++;
      if (key === "no_spin_response") noSpinHits++;
    }
  }

  const topErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ key, count }));

  const slugCounts = [...slugCountMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, tasks]) => ({ slug, tasks }));

  const baseline: BaselineSnapshot = {
    generatedAt: new Date().toISOString(),
    windowDays,
    totalTasks: recent.length,
    tasksWithCaseStats,
    passRate: pct(passed, totalCases),
    skipRate: pct(skipped, totalCases),
    failRate: pct(failed, totalCases),
    flakeRateProxy: pct(flakeNumerator, Math.max(1, flakeDenominator)),
    visionFallbackRateProxy: pct(fallbackHits, Math.max(1, recent.length)),
    noSpinResponseRateProxy: pct(noSpinHits, Math.max(1, recent.length)),
    statusCounts,
    topErrors,
    slugCounts,
  };

  console.log("=== Automation Baseline ===");
  console.log(JSON.stringify(baseline, null, 2));

  if (write) {
    const outDir = join("fixtures", "tasks");
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, "automation-baseline.json");
    writeFileSync(out, JSON.stringify(baseline, null, 2));
    console.log(`Saved baseline snapshot: ${out}`);
  }
}

main();
