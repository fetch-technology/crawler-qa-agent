/**
 * CLI: emit canonical GameAnalyzerReport for a slug.
 *
 * Usage:
 *   tsx src/ai/game-analyzer-cli.ts <slug>
 *
 * Reads:
 *   - fixtures/specs/{slug}/{slug}.spec.json    (GameSpec from authoring)
 *   - fixtures/scenarios/{slug}/*.json          (sample spin body)
 *
 * Writes:
 *   - fixtures/analyzers/{slug}.json
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { analyzeGame, saveAnalyzerReport } from "./game-analyzer.js";
import type { GameSpec } from "./authoring.js";
import { listScenarios, loadScenario } from "../runner/scenario.js";

loadEnv();

function loadSpec(slug: string): GameSpec | null {
  const p = join("fixtures", "specs", slug, `${slug}.spec.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as GameSpec;
}

function findSampleResponse(slug: string): { body: string; url: string } | null {
  const labels = listScenarios(slug);
  if (labels.length > 0) {
    const sc = loadScenario(slug, labels[0]!);
    return { body: sc.spin_response.body, url: sc.spin_response.url };
  }
  // Fall back to first http.jsonl entry that looks like a response.
  const recDir = "fixtures/recordings";
  if (!existsSync(recDir)) return null;
  const candidates = readdirSync(recDir).filter((n) => n.startsWith(slug + "__"));
  if (candidates.length === 0) return null;
  const latest = candidates.sort().reverse()[0]!;
  const jsonl = join(recDir, latest, "http.jsonl");
  if (!existsSync(jsonl)) return null;
  for (const line of readFileSync(jsonl, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.phase === "response" && e.body) return { body: e.body, url: e.url ?? "" };
    } catch {}
  }
  return null;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: tsx src/ai/game-analyzer-cli.ts <slug>");
    process.exit(1);
  }
  const spec = loadSpec(slug);
  if (!spec) {
    console.error(`No GameSpec at fixtures/specs/${slug}/${slug}.spec.json. Run authoring first.`);
    process.exit(1);
  }
  const sample = findSampleResponse(slug);
  const report = analyzeGame({
    slug,
    spec,
    sampleResponseBody: sample?.body,
    sampleUrl: sample?.url,
  });
  const path = saveAnalyzerReport(report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${path}`);
}

main().catch((err) => {
  console.error("analyzer failed:", err);
  process.exit(1);
});
