import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type ScenarioFile = {
  label?: string;
  expected?: {
    has_bonus?: boolean;
    is_free_spin?: boolean;
  };
};

type SlugReport = {
  slug: string;
  total: number;
  labels: string[];
  hasNoWin: boolean;
  hasRequiredWin: boolean;
  hasBonusOrFS: boolean;
  meetsMinimum: boolean;
  missing: string[];
};

function loadScenarioFiles(slugDir: string): ScenarioFile[] {
  const files = readdirSync(slugDir).filter((f) => f.endsWith(".json"));
  const out: ScenarioFile[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(slugDir, f), "utf8")) as ScenarioFile);
    } catch {
      // Ignore malformed files and continue.
    }
  }
  return out;
}

function main() {
  const base = join("fixtures", "scenarios");
  if (!existsSync(base)) {
    console.error("fixtures/scenarios not found");
    process.exit(1);
  }

  const slugs = readdirSync(base).filter((n) => existsSync(join(base, n)));
  const reports: SlugReport[] = [];

  for (const slug of slugs) {
    const scenarios = loadScenarioFiles(join(base, slug));
    const labels = scenarios
      .map((s) => (typeof s.label === "string" ? s.label : ""))
      .filter(Boolean);

    const hasNoWin = labels.includes("no_win");
    // Some high-variance games may not emit small/normal wins in short captures
    // but still have valid win outcomes (big_win). Any win label is acceptable.
    const hasRequiredWin =
      labels.includes("small_win") || labels.includes("normal_win") || labels.includes("big_win");
    const hasBonusOrFS = scenarios.some(
      (s) => s.expected?.has_bonus === true || s.expected?.is_free_spin === true,
    );

    const missing: string[] = [];
    if (!hasNoWin) missing.push("no_win");
    if (!hasRequiredWin) missing.push("small_win|normal_win|big_win");

    reports.push({
      slug,
      total: scenarios.length,
      labels: [...new Set(labels)].sort(),
      hasNoWin,
      hasRequiredWin,
      hasBonusOrFS,
      meetsMinimum: missing.length === 0,
      missing,
    });
  }

  const ok = reports.filter((r) => r.meetsMinimum).length;
  const fail = reports.length - ok;

  console.log("=== Scenario Minimum Coverage ===");
  console.log(`slugs=${reports.length} ok=${ok} fail=${fail}`);
  for (const r of reports) {
    const status = r.meetsMinimum ? "OK" : "MISSING";
    console.log(
      `${status} ${r.slug} total=${r.total} labels=[${r.labels.join(",")}] bonusOrFS=${r.hasBonusOrFS} missing=[${r.missing.join(",")}]`,
    );
  }
}

main();
