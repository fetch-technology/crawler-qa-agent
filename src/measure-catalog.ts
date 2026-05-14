/**
 * Đo cải tiến Phase A.5 OFFLINE — không cần browser.
 *
 * Re-run generateTestCaseCatalog trên fixtures sweet-bonanza-2500 sẵn có
 * (gameSpec + rules + options + spin samples + config response từ recording cũ),
 * so sánh với catalog cũ (sweet-bonanza-2500.test-cases.json đã sinh trước cải tiến).
 *
 * Usage: npx tsx src/measure-catalog.ts
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { generateTestCaseCatalog, type TestCaseCatalog } from "./ai/test-catalog.js";
import { applyFieldMapping, type NetworkHints } from "./ai/network-detect.js";
import { tryParseBody, scoreSpinShape, scoreSpinUrl, shouldSkipUrl } from "./runner/spin-detect.js";

loadEnv();

const SLUG = process.argv[2] ?? "sweet-bonanza-2500";

type HttpEntry = {
  t?: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  status?: number;
  body?: string | null;
};

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {}
  }
  return out;
}

function latestDir(base: string, prefix: string): string | null {
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, full: join(base, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return dirs[0]?.full ?? null;
}

function gatherSpinSamples(recordingDir: string, limit = 5): unknown[] {
  const entries = readJsonl<HttpEntry>(join(recordingDir, "http.jsonl"));
  const samples: Record<string, unknown>[] = [];
  for (const e of entries) {
    if (e.phase !== "response" || !e.body) continue;
    if (shouldSkipUrl(e.url)) continue;
    const parsed = tryParseBody(e.body);
    if (!parsed) continue;
    const urlScore = scoreSpinUrl(e.url);
    const bodyScore = scoreSpinShape(parsed);
    const score = urlScore.score + bodyScore.score + (e.method === "POST" ? 1 : 0);
    if (score >= 7) samples.push(parsed);
    if (samples.length >= limit) break;
  }
  return samples;
}

function gatherConfigResponse(recordingDir: string, gameSlug: string): unknown | null {
  const entries = readJsonl<HttpEntry>(join(recordingDir, "http.jsonl"));
  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (!new RegExp(`api\\.[^/]+/${gameSlug}/config`).test(e.url)) continue;
    if (!e.body) continue;
    try {
      return JSON.parse(e.body);
    } catch {}
  }
  return null;
}

async function main() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY) trong .env");
    process.exit(1);
  }

  console.log("================================================================");
  console.log(` MEASURE CATALOG — re-run Phase A.5 offline trên ${SLUG}`);
  console.log("================================================================\n");

  // Load all fixtures
  const specPath = join("fixtures/specs", SLUG, `${SLUG}.spec.json`);
  if (!existsSync(specPath)) {
    console.error(`✗ GameSpec không có: ${specPath}`);
    process.exit(1);
  }
  const gameSpec = JSON.parse(readFileSync(specPath, "utf8"));
  console.log(`✔ GameSpec: ${gameSpec.invariants.length} invariants, ${gameSpec.symbols.length} symbols, ${gameSpec.features.length} features`);

  const optionsRun = latestDir("fixtures/options", `${SLUG}__`);
  let optionsJson: string | null = null;
  let paytableMarkdown: string | null = null;
  if (optionsRun) {
    const optsPath = join(optionsRun, "options.json");
    if (existsSync(optsPath)) {
      optionsJson = readFileSync(optsPath, "utf8");
      console.log(`✔ options.json: ${optionsJson.length} chars`);
    }
    const paytablePath = join(optionsRun, "paytable.md");
    if (existsSync(paytablePath)) {
      paytableMarkdown = readFileSync(paytablePath, "utf8");
      console.log(`✔ paytable.md: ${paytableMarkdown.length} chars`);
    } else {
      console.log(`(paytable.md không có ở ${optionsRun} — chưa rerun extract-options với feature mới)`);
    }
  }

  // Build rulesMarkdown synthetic from snapshot (same logic as generate-and-run)
  let rulesMarkdown = "";
  if (optionsRun) {
    const snapshotPath = join(optionsRun, "play-screen.json");
    const optionsMdPath = join(optionsRun, "options.md");
    if (existsSync(snapshotPath)) {
      const data = JSON.parse(readFileSync(snapshotPath, "utf8"));
      // Backward compat: schema cũ {snapshot}, mới {vision, api}.
      const s = data.vision ?? data.snapshot;
      const api = data.api ?? null;
      if (!s && !api) {
        console.log(`(play-screen.json không có vision/snapshot/api — bỏ qua synth)`);
        return;
      }
      const lines: string[] = [`# Rules (derived from play screen)`, ""];
      if (s?.game_title) lines.push(`**Title:** ${s.game_title}`);
      else if (api?.game?.name) lines.push(`**Title:** ${api.game.name}`);
      if (s?.rules_summary?.paylines_or_ways) lines.push(`**Lines/Ways:** ${s.rules_summary.paylines_or_ways}`);
      else if (api?.reels?.paylines_or_ways) lines.push(`**Lines/Ways:** ${api.reels.paylines_or_ways}`);
      if (s?.rules_summary?.max_win) lines.push(`**Max Win:** ${s.rules_summary.max_win}`);
      else if (api?.max_win_x) lines.push(`**Max Win:** ${api.max_win_x}x`);
      lines.push("");
      if (s?.rules_summary?.feature_mentions?.length) {
        lines.push(`## Features`);
        for (const f of s.rules_summary.feature_mentions) lines.push(`- ${f}`);
        lines.push("");
      }
      if (s?.rules_summary?.visible_symbols?.length) {
        lines.push(`## Visible symbols`);
        lines.push(s.rules_summary.visible_symbols.join(", "));
        lines.push("");
      }
      if (s?.buy_feature?.available) {
        lines.push(`## Buy Feature options`);
        for (const o of s.buy_feature.options ?? [])
          lines.push(`- ${o.label}: ${[o.price_multiplier, o.price_absolute].filter(Boolean).join(" / ") || "(price n/a)"}`);
        lines.push("");
      }
      if (s?.special_bets?.available) {
        lines.push(`## Special Bets`);
        for (const v of s.special_bets.variants ?? [])
          lines.push(`- ${v.label}${v.price ? ` — price ${v.price}` : ""}${v.state ? ` (state=${v.state})` : ""}`);
        lines.push("");
      }
      if (api?.rtp) {
        lines.push(`## RTP (from API)`);
        if (api.rtp.regular != null) lines.push(`- Regular: ${api.rtp.regular}%`);
        for (const a of api.rtp.ante ?? []) lines.push(`- Ante \`${a.id}\`: ${a.rtp}%${a.max_win_x ? `, max ${a.max_win_x}x` : ""}`);
        for (const p of api.rtp.purchase ?? []) lines.push(`- Purchase \`${p.id}\`: ${p.rtp}%${p.max_win_x ? `, max ${p.max_win_x}x` : ""}`);
        lines.push("");
      }
      if (existsSync(optionsMdPath)) {
        lines.push(`## Options snapshot`, "", readFileSync(optionsMdPath, "utf8"));
      }
      rulesMarkdown = lines.join("\n");
      console.log(`✔ rulesMarkdown synthesized: ${rulesMarkdown.length} chars`);
    }
  }

  // Spin samples + config from auto recording
  const recDir = latestDir("fixtures/recordings", `${SLUG}__auto-`);
  if (!recDir) {
    console.error(`✗ Không có auto recording`);
    process.exit(1);
  }
  const rawSamples = gatherSpinSamples(recDir, 5);
  console.log(`✔ raw spin samples: ${rawSamples.length} từ ${recDir}`);

  // Normalize via existing hints if available
  const hintsPath = join("fixtures/specs", SLUG, "network-hints.json");
  let normalizedSamples: unknown[] = rawSamples;
  if (existsSync(hintsPath)) {
    const hints = JSON.parse(readFileSync(hintsPath, "utf8")) as NetworkHints;
    normalizedSamples = rawSamples.map((s) =>
      applyFieldMapping(s as Record<string, unknown>, hints.field_mapping),
    );
    console.log(`✔ normalized via hints: ${normalizedSamples.length}`);
  }

  const configResponse = gatherConfigResponse(recDir, SLUG);
  console.log(`${configResponse ? "✔" : "✗"} config response: ${configResponse ? "found" : "NOT found"}`);

  // Compare with old catalog
  const oldCatalogPath = join("fixtures/specs", SLUG, `${SLUG}.test-cases.json`);
  let oldCatalog: TestCaseCatalog | null = null;
  if (existsSync(oldCatalogPath)) {
    oldCatalog = JSON.parse(readFileSync(oldCatalogPath, "utf8")) as TestCaseCatalog;
    console.log(`\n=== OLD CATALOG (baseline) ===`);
    console.log(`  total cases: ${oldCatalog.total_cases}`);
    const oldByCat = new Map<string, number>();
    for (const c of oldCatalog.cases) oldByCat.set(c.category, (oldByCat.get(c.category) ?? 0) + 1);
    for (const [cat, n] of oldByCat) console.log(`    ${cat}: ${n}`);
    const totalAssertions = oldCatalog.cases.reduce((s, c) => s + (c.custom_assertions?.length ?? 0), 0);
    console.log(`  total custom_assertions: ${totalAssertions}`);
  }

  // ===== RUN NEW CATALOG GEN =====
  console.log(`\n=== Running NEW catalog gen với cải tiến #1+#2+#3+#7 ===\n`);
  const t0 = Date.now();
  const newCatalog = await generateTestCaseCatalog({
    gameSpec,
    rulesMarkdown,
    optionsJson,
    sampleSpinResponses: normalizedSamples,
    configResponse,
    paytableMarkdown,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== NEW CATALOG ===`);
  console.log(`  total cases: ${newCatalog.total_cases}`);
  console.log(`  elapsed: ${elapsed}s`);
  const newByCat = new Map<string, number>();
  for (const c of newCatalog.cases) newByCat.set(c.category, (newByCat.get(c.category) ?? 0) + 1);
  for (const [cat, n] of newByCat) console.log(`    ${cat}: ${n}`);
  const newTotalAssertions = newCatalog.cases.reduce((s, c) => s + (c.custom_assertions?.length ?? 0), 0);
  console.log(`  total custom_assertions: ${newTotalAssertions}`);
  console.log(`  generation_meta:`);
  console.log(`    inputs_used: ${newCatalog.generation_meta?.inputs_used.join(", ")}`);
  console.log(`    rules_chars: ${newCatalog.generation_meta?.rules_chars}`);
  console.log(`    config_keys_top: ${newCatalog.generation_meta?.config_keys_top.slice(0, 10).join(", ")}${(newCatalog.generation_meta?.config_keys_top.length ?? 0) > 10 ? "…" : ""}`);
  console.log(`    paytable_symbols_count: ${newCatalog.generation_meta?.paytable_symbols_count}`);
  console.log(`    bet_sizes_count: ${newCatalog.generation_meta?.bet_sizes_count}`);
  console.log(`    features_count: ${newCatalog.generation_meta?.features_count}`);
  console.log(`    plan_categories: ${newCatalog.generation_meta?.plan_categories.join(", ")}`);

  // Diff
  if (oldCatalog) {
    console.log(`\n=== DIFF ===`);
    const delta = newCatalog.total_cases - oldCatalog.total_cases;
    console.log(`  Δ total_cases: ${delta >= 0 ? "+" : ""}${delta}`);
    const oldCats = new Set(oldCatalog.cases.map((c) => c.category));
    const newCats = new Set(newCatalog.cases.map((c) => c.category));
    const added = [...newCats].filter((c) => !oldCats.has(c));
    const removed = [...oldCats].filter((c) => !newCats.has(c));
    if (added.length) console.log(`  new categories: ${added.join(", ")}`);
    if (removed.length) console.log(`  dropped categories: ${removed.join(", ")}`);
    const oldAssertCount = oldCatalog.cases.reduce((s, c) => s + (c.custom_assertions?.length ?? 0), 0);
    const assertDelta = newTotalAssertions - oldAssertCount;
    console.log(`  Δ custom_assertions: ${assertDelta >= 0 ? "+" : ""}${assertDelta}`);

    // Sample case names
    console.log(`\n  NEW case names:`);
    for (const c of newCatalog.cases) console.log(`    - [${c.category}/${c.severity}] ${c.id} — ${c.name}`);
  }

  const outPath = join("fixtures/specs", SLUG, `${SLUG}.test-cases.NEW.json`);
  writeFileSync(outPath, JSON.stringify(newCatalog, null, 2));
  console.log(`\n✔ NEW catalog saved: ${outPath} (compare bằng diff vs ${oldCatalogPath})`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
