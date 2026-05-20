/**
 * CLI: run statistical sim across N currencies in one batch.
 *
 * Use case: QA sheet has tests #10, #38-43 — "Play with USD/BRL/MXN/COP/GBP/PHP,
 * no payout issues" — repeat smoke test per currency. Single command runs all.
 *
 * Input: JSON config file mapping currency → GAME_URL
 *
 * Output: per-currency stats report + aggregated summary
 *
 * Usage:
 *   tsx src/statistical/currency-batch-cli.ts \
 *     --config currency-urls.json \
 *     --spins 1000 \
 *     --slug candyblitz
 *
 * Config file shape:
 *   {
 *     "USD": "https://...token-usd",
 *     "BRL": "https://...token-brl",
 *     ...
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { simulate, formatReport, type SimulateResult } from "./simulate.js";
import type { GameSpec } from "../ai/authoring.js";

loadEnv();

function parseFlag(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

function parseFlagNum(flag: string, fallback: number): number {
  const v = Number(parseFlag(flag, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function loadSpec(slug: string): GameSpec | null {
  const p = `fixtures/specs/${slug}/${slug}.spec.json`;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GameSpec;
  } catch {
    return null;
  }
}

async function main() {
  const slug = parseFlag("--slug", "");
  const configPath = parseFlag("--config", "");
  if (!slug || !configPath) {
    console.error(`
Currency batch runner — verify game works across multiple currencies.

Usage:
  tsx src/statistical/currency-batch-cli.ts --slug <slug> --config <file.json> [options]

Options:
  --spins <N>        Spins per currency (default 200)
  --concurrency <N>  Parallel requests per currency (default 2)

Config file (currency-urls.json):
{
  "USD": "https://demo.../game?t=tokenUSD...",
  "BRL": "https://demo.../game?t=tokenBRL...",
  "MXN": "https://demo.../game?t=tokenMXN..."
}

Output:
  fixtures/statistical/{slug}-currency-batch-{ts}.json + summary stdout
`);
    process.exit(1);
  }
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }
  const currencies = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>;
  const spins = parseFlagNum("--spins", 200);
  const concurrency = parseFlagNum("--concurrency", 2);
  const spec = loadSpec(slug);

  console.log(`\n[currency-batch] slug=${slug} currencies=${Object.keys(currencies).length} spins/currency=${spins}\n`);

  // NOTE: This runner relies on recordings PER currency. Best practice: have
  // a recording for each currency before running. If recording for currency X
  // doesn't exist, simulate() will throw; we catch and report.
  // For simplicity, this CLI assumes recordings already captured per currency
  // (via `GAME_URL=... npm run record` for each).

  const results: Record<string, SimulateResult | { error: string }> = {};
  for (const [currency, url] of Object.entries(currencies)) {
    console.log(`\n========== ${currency} ==========`);
    console.log(`GAME_URL: ${url.slice(0, 80)}…`);
    process.env.GAME_URL = url;
    try {
      const result = await simulate({
        slug,
        spins,
        concurrency,
        progressEvery: Math.max(50, Math.floor(spins / 10)),
        spec,
        maxResponseMs: 500,
      });
      console.log(`\n[${currency}] ${formatReport(result).split("\n").slice(0, 12).join("\n")}\n`);
      results[currency] = result;
    } catch (err) {
      console.error(`[${currency}] FAILED:`, (err as Error).message);
      results[currency] = { error: (err as Error).message };
    }
  }

  // Aggregated summary table
  console.log("\n\n================ CURRENCY BATCH SUMMARY ================");
  console.log("Currency  | Spins  | Failed | RTP      | Hit%   | Mismatch | Mean ms | SlowSpins");
  console.log("----------|--------|--------|----------|--------|----------|---------|----------");
  for (const [cur, r] of Object.entries(results)) {
    if ("error" in r) {
      console.log(`${cur.padEnd(9)} | ERROR: ${r.error.slice(0, 70)}`);
      continue;
    }
    const rtp = r.observedRTP != null ? (r.observedRTP * 100).toFixed(2) + "%" : "—";
    const hit = r.hitFrequency != null ? (r.hitFrequency * 100).toFixed(1) + "%" : "—";
    const mismatch = r.consistency?.payoutMismatches ?? 0;
    const meanMs = r.performance?.meanMs ?? "—";
    const slowSpins = r.performance?.slowSpins ?? 0;
    console.log(
      `${cur.padEnd(9)} | ${String(r.spinsSuccessful).padEnd(6)} | ${String(r.spinsFailed).padEnd(6)} | ${rtp.padEnd(8)} | ${hit.padEnd(6)} | ${String(mismatch).padEnd(8)} | ${String(meanMs).padEnd(7)} | ${slowSpins}`,
    );
  }
  console.log("=========================================================\n");

  // Persist
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("fixtures/statistical", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `fixtures/statistical/${slug}-currency-batch-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Report saved: ${outPath}`);

  // Exit code: non-zero if any currency had issue
  const anyError = Object.values(results).some((r) =>
    "error" in r ||
    (r as SimulateResult).spinsFailed > 0 ||
    ((r as SimulateResult).consistency?.payoutMismatches ?? 0) > 0,
  );
  process.exit(anyError ? 1 : 0);
}

main().catch((err) => {
  console.error("currency-batch failed:", err);
  process.exit(1);
});
