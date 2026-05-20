import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strategyFor, type AvailableScenario } from "./ai/hybrid-case-mapper.js";
import type { TestCaseCatalog } from "./ai/test-catalog.js";
import { loadScenario } from "./runner/scenario.js";

type Row = {
  slug: string;
  total: number;
  skip: number;
  skipRate: number;
  replayOrVision: number;
  realNetwork: number;
};

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Number(((n / d) * 100).toFixed(2));
}

function loadAvailableScenarios(slug: string): AvailableScenario[] {
  const dir = join("fixtures", "scenarios", slug);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: AvailableScenario[] = [];
  for (const f of files) {
    const name = f.replace(/\.json$/i, "");
    try {
      const scenario = loadScenario(slug, name);
      out.push({ name, label: scenario.label, scenario });
    } catch {
      // Ignore malformed scenario files.
    }
  }
  return out;
}

function loadCatalog(slug: string): TestCaseCatalog | null {
  const path = join("fixtures", "specs", slug, `${slug}.test-cases.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TestCaseCatalog;
  } catch {
    return null;
  }
}

function listSlugsFromScenarios(): string[] {
  const root = join("fixtures", "scenarios");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => existsSync(join(root, n)));
}

function main() {
  const rows: Row[] = [];
  for (const slug of listSlugsFromScenarios()) {
    const catalog = loadCatalog(slug);
    if (!catalog) continue;
    const scenarios = loadAvailableScenarios(slug);
    let skip = 0;
    let replayOrVision = 0;
    let realNetwork = 0;
    for (const tc of catalog.cases) {
      const s = strategyFor(tc, scenarios, { slug });
      if (s.type === "skip") skip++;
      if (s.type === "replay_or_vision") replayOrVision++;
      if (s.type === "real_network_verify") realNetwork++;
    }
    rows.push({
      slug,
      total: catalog.cases.length,
      skip,
      skipRate: pct(skip, catalog.cases.length),
      replayOrVision,
      realNetwork,
    });
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const totalCases = rows.reduce((a, r) => a + r.total, 0);
  const totalSkip = rows.reduce((a, r) => a + r.skip, 0);

  console.log("=== Skip Projection (catalog + mapper) ===");
  for (const r of rows) {
    console.log(
      `${r.slug}: total=${r.total} skip=${r.skip} skipRate=${r.skipRate}% replayOrVision=${r.replayOrVision} realNetwork=${r.realNetwork}`,
    );
  }
  console.log(`TOTAL: cases=${totalCases} skip=${totalSkip} skipRate=${pct(totalSkip, totalCases)}%`);
}

main();
