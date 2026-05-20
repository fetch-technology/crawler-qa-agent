/**
 * CLI: print aggregated pre-game replay stats.
 *
 * Usage:
 *   tsx src/runner/pre-game-stats-cli.ts             # all slugs
 *   tsx src/runner/pre-game-stats-cli.ts fiesta-magenta
 *   tsx src/runner/pre-game-stats-cli.ts --raw       # list all attempts
 *
 * Reads fixtures/pre-game/_stats.jsonl (populated by replay/vision wrapper).
 */

import { aggregatePreGameStats, readAllAttempts } from "./pre-game-stats.js";

function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}
function ms(v: number | null): string {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--raw")) {
    const all = readAllAttempts();
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  const slug = args.find((a) => !a.startsWith("-"));
  const aggs = aggregatePreGameStats(slug);
  if (aggs.length === 0) {
    console.log(`No pre-game attempts recorded yet${slug ? ` for ${slug}` : ""}.`);
    return;
  }
  for (const a of aggs) {
    console.log("\n=== " + a.slug + " ===");
    console.log(`Total attempts     : ${a.total}`);
    console.log(`  ready=true       : ${a.ready}  (${pct(a.ready / (a.total || 1))})`);
    console.log(`  ready=false      : ${a.notReady}`);
    console.log(`By source:`);
    console.log(`  replay           : ${a.bySource.replay}`);
    console.log(`  vision           : ${a.bySource.vision}  (of which ${a.fallbacks} were fallback)`);
    console.log(`Replay success %   : ${pct(a.replaySuccessRate)}`);
    console.log(`Vision rate %      : ${pct(a.visionRate)}  ← % needed AI confirm`);
    console.log(`Avg duration:`);
    console.log(`  replay           : ${ms(a.avgDurationMs.replay)}`);
    console.log(`  vision           : ${ms(a.avgDurationMs.vision)}`);
    console.log(`Last attempt       : ${a.lastAttemptAt ?? "n/a"}`);
    if (a.recent.length > 0) {
      console.log(`Recent attempts:`);
      for (const r of a.recent) {
        const tag = r.is_fallback ? "↪vision" : r.source;
        const heal = r.auto_healed ? " 🔧healed" : "";
        const diff = r.replay_diff_ratio != null ? ` diff=${pct(r.replay_diff_ratio)}` : "";
        console.log(
          `  ${r.ts}  ${tag.padEnd(9)} ready=${r.ready ? "✓" : "✗"} ${ms(r.duration_ms)}${diff}${heal} ${r.reason.slice(0, 60)}`,
        );
      }
    }
  }
  console.log();
}

main();
