import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { parseGameUrl, redactUrl } from "./utils/url.js";
import { resolveGameUrl } from "./utils/resolve-game-url.js";
import { cleanGame } from "./utils/cleanup.js";
import { understandGameRules, generatePlaywrightTest, type GameSpec } from "./ai/authoring.js";
import { runExecutionPreflight, formatPreflightResult } from "./ai/execution-preflight.js";
import { generateTestCaseCatalog, type TestCaseCatalog } from "./ai/test-catalog.js";
import { catalogToMarkdown } from "./ai/catalog-markdown.js";
import { validateCatalog } from "./ai/catalog-validator.js";
import { tryParseBody, scoreSpinShape, scoreSpinUrl, shouldSkipUrl } from "./runner/spin-detect.js";
import {
  detectSpinEndpointWithAI,
  applyFieldMapping,
  type NetworkHints,
  type ResponseSummary,
} from "./ai/network-detect.js";

loadEnv();

type HttpEntry = {
  t?: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  status?: number;
  body?: string | null;
};

function latestDirIn(base: string, filter?: (name: string) => boolean): string | null {
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((name) => filter?.(name) ?? true)
    .map((name) => ({ name, full: join(base, name) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return dirs[0]?.full ?? null;
}

function findRulesFor(gameSlug: string): string | null {
  const base = "fixtures/rules";
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((n) => n.startsWith(gameSlug + "__"))
    .map((n) => ({ n, full: join(base, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  for (const d of dirs) {
    const rulesPath = join(d.full, "rules.md");
    if (!existsSync(rulesPath)) continue;
    const content = readFileSync(rulesPath, "utf8").trim();
    // Quality gate: phải đủ dài + có ít nhất 1 H2 section + chứa keyword paytable/symbol/feature.
    // Tránh dùng rules.md gần rỗng hoặc placeholder.
    if (content.length < 500) continue;
    if (!/^##\s+/m.test(content)) continue;
    if (!/(paytable|symbol|feature|payline|free spin|wild|scatter|payout)/i.test(content)) continue;
    return d.full;
  }
  return null;
}

function findOptionsRunFor(gameSlug: string): string | null {
  const base = "fixtures/options";
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((n) => n.startsWith(gameSlug + "__"))
    .map((n) => ({ n, full: join(base, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return dirs[0]?.full ?? null;
}

/** Build rulesMarkdown synthetic từ play-screen snapshot (khi không có rules.md đầy đủ).
 *  Backward compatible với schema cũ (`{snapshot}`) và mới (`{vision, api}`). Khi có `api`,
 *  enrich thêm RTP/max-win/bet-ladder vốn không thấy được trên play-screen 1-shot. */
function synthRulesFromSnapshot(snapshotJson: string, optionsMd: string | null): string | null {
  try {
    const data = JSON.parse(snapshotJson);
    // New shape: { vision, api }; old shape: { snapshot }
    const s = data.vision ?? data.snapshot;
    const api = data.api ?? null;
    if (!s && !api) return null;

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

    // Vision-side buy_feature/special_bets (label-only)
    if (s?.buy_feature?.available) {
      lines.push(`## Buy Feature options (vision)`);
      for (const o of s.buy_feature.options ?? []) {
        lines.push(`- ${o.label}: ${[o.price_multiplier, o.price_absolute].filter(Boolean).join(" / ") || "(price n/a)"}`);
      }
      lines.push("");
    }
    if (s?.special_bets?.available) {
      lines.push(`## Special Bets (vision)`);
      for (const v of s.special_bets.variants ?? []) {
        lines.push(`- ${v.label}${v.price ? ` — price ${v.price}` : ""}${v.state ? ` (state=${v.state})` : ""}`);
      }
      lines.push("");
    }

    // API-side enrichment: chi tiết RTP/max_win mỗi tier mà vision không thấy.
    if (api?.rtp) {
      lines.push(`## RTP (from API)`);
      if (api.rtp.regular != null) lines.push(`- Regular: ${api.rtp.regular}%`);
      for (const a of api.rtp.ante ?? []) lines.push(`- Ante \`${a.id}\`: ${a.rtp}%${a.max_win_x ? `, max ${a.max_win_x}x` : ""}`);
      for (const p of api.rtp.purchase ?? []) lines.push(`- Purchase \`${p.id}\`: ${p.rtp}%${p.max_win_x ? `, max ${p.max_win_x}x` : ""}`);
      lines.push("");
    }
    if (api?.bet) {
      lines.push(`## Bet (from API)`);
      if (api.bet.coin_values) lines.push(`- Coin ladder (${api.bet.coin_values.length}): ${api.bet.coin_values.slice(0, 20).join(", ")}${api.bet.coin_values.length > 20 ? "…" : ""}`);
      if (api.bet.bet_levels) lines.push(`- Levels: ${api.bet.bet_levels.join(", ")}`);
      if (api.bet.total_min != null || api.bet.total_max != null) {
        lines.push(`- Total range: ${api.bet.total_min ?? "?"} → ${api.bet.total_max ?? "?"}`);
      }
      lines.push("");
    }
    if (api?.features) {
      const f = api.features;
      lines.push(`## Feature mechanics (from API + paytable)`);
      if (f.free_spins?.available) {
        const fs = f.free_spins;
        lines.push(`- **Free Spins**: trigger=${fs.trigger ?? "?"}, awarded=${fs.spins_awarded ?? "?"}${fs.retrigger ? `, retrigger=${fs.retrigger}` : ""}${fs.multiplier_during ? `, mult=${fs.multiplier_during}` : ""}${fs.buy_in_available ? `, buy-in available` : ""}`);
      }
      if (f.tumble?.available) lines.push(`- **Tumble/Cascade**: ${f.tumble.description ?? "available"}${f.tumble.max_multiplier ? `, max ${f.tumble.max_multiplier}` : ""}`);
      if (f.wild?.available) lines.push(`- **Wild**: ${f.wild.substitutes ?? "available"}${f.wild.multiplier_values ? `, mult values=${f.wild.multiplier_values.join(",")}` : ""}${f.wild.sticky ? ", sticky" : ""}${f.wild.expanding ? ", expanding" : ""}`);
      if (f.scatter?.available) lines.push(`- **Scatter**: min ${f.scatter.min_count_to_pay ?? "?"} to pay${f.scatter.pays ? `, pays ${f.scatter.pays}` : ""}`);
      if (f.bonus_round?.available) lines.push(`- **Bonus**: ${f.bonus_round.type ?? "?"}${f.bonus_round.description ? ` — ${f.bonus_round.description}` : ""}`);
      for (const o of f.other_features ?? []) lines.push(`- ${o}`);
      lines.push("");
    }
    if (api?.buy_feature?.tiers?.length) {
      lines.push(`## Buy Feature tiers (from API)`);
      for (const t of api.buy_feature.tiers) {
        lines.push(`- \`${t.id}\`${t.label ? ` — ${t.label}` : ""}: rtp=${t.rtp ?? "?"}, max=${t.max_win_x ?? "?"}x${t.price_multiplier ? `, price=${t.price_multiplier}x` : ""}`);
      }
      lines.push("");
    }
    if (api?.special_bets?.variants?.length) {
      lines.push(`## Special Bets variants (from API)`);
      for (const v of api.special_bets.variants) {
        lines.push(`- \`${v.id}\`${v.label ? ` — ${v.label}` : ""}: rtp=${v.rtp ?? "?"}, max=${v.max_win_x ?? "?"}x${v.cost_multiplier ? `, cost=${v.cost_multiplier}x` : ""}`);
      }
      lines.push("");
    }

    if (optionsMd) {
      lines.push(`## Options snapshot`, "", optionsMd);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/** Save hints để user inspect (KHÔNG reuse — mỗi run detect fresh). */
function saveHints(gameSlug: string, hints: NetworkHints) {
  const dir = join("fixtures/specs", gameSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "network-hints.json"), JSON.stringify(hints, null, 2));
}

/** Extract top N POST/GET response previews để gửi AI detect */
function extractResponsesSummary(recordingDir: string, n = 20): ResponseSummary[] {
  const entries = readJsonl<HttpEntry>(join(recordingDir, "http.jsonl"));
  const out: ResponseSummary[] = [];
  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (!e.body) continue;
    if (shouldSkipUrl(e.url)) continue;
    if (e.method !== "POST" && e.method !== "GET") continue;
    const parsed = tryParseBody(e.body);
    const parsedKeys = parsed ? Object.keys(parsed) : [];
    // Filter noise: chỉ lấy response có body parse được VÀ có keys
    if (parsedKeys.length < 2) continue;
    out.push({
      url: e.url,
      method: e.method,
      status: e.status ?? 0,
      body_length: e.body.length,
      body_preview: e.body.slice(0, 400),
      parsed_keys: parsedKeys,
    });
    if (out.length >= n) break;
  }
  return out;
}

/** Build hints từ heuristic detection result */
function hintsFromHeuristic(
  gameSlug: string,
  provider: string,
  topCandidate: SpinCandidate | undefined,
  topScore: number,
): NetworkHints | null {
  if (!topCandidate) return null;
  const raw = topCandidate.parsed;
  const keys = Object.keys(raw);

  const pick = (...names: string[]) =>
    names.find((n) => keys.some((k) => k.toLowerCase() === n.toLowerCase())) ?? null;

  // Map theo tên field thực tế trong response (case-preserving)
  const findExact = (lc: string) => keys.find((k) => k.toLowerCase() === lc) ?? null;

  let endpointPath = "";
  try {
    const u = new URL(topCandidate.entry.url);
    endpointPath = u.pathname;
  } catch {}

  return {
    game_slug: gameSlug,
    provider,
    detected_at: new Date().toISOString(),
    detection_method: "heuristic",
    spin_endpoint: {
      url_pattern: endpointPath || topCandidate.entry.url,
      method: topCandidate.entry.method ?? "POST",
      body_format: topCandidate.entry.body?.trim().startsWith("{") ? "json" : "urlencoded",
    },
    field_mapping: {
      bet: findExact("betamount") ?? findExact("bet") ?? findExact("stake") ?? findExact("c"),
      win:
        findExact("winamount") ??
        findExact("win") ??
        findExact("totalwin") ??
        findExact("earn") ??
        findExact("tw"),
      balance:
        findExact("balance") ??
        findExact("balance_cash") ??
        findExact("updatedbalance"),
      starting_balance: findExact("startingbalance"),
      ending_balance: findExact("endingbalance") ?? findExact("updatedbalance"),
      matrix:
        findExact("matrix") ??
        findExact("reels") ??
        findExact("result") ??
        findExact("s") ??
        findExact("sb"),
      round_id: findExact("id") ?? findExact("round") ?? findExact("index") ?? findExact("counter"),
      status: findExact("status") ?? findExact("state"),
      currency: findExact("currency"),
      extras: {},
    },
    reasoning: `Heuristic matched with score ${topScore} (${topCandidate.reasons.join(", ")})`,
    confidence: Math.min(topScore / 25, 1),
  };
}

function findAutoRunWithSpin(gameSlug: string): {
  dir: string;
  samples: unknown[];
  config: unknown | null;
  endpointHint: string | null;
  candidates: SpinCandidate[];
} | null {
  const base = "fixtures/recordings";
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((n) => n.includes(gameSlug + "__auto-"))
    .map((n) => ({ n, full: join(base, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  for (const d of dirs) {
    const res = gatherSpinSamples(d.full, 3);
    if (res.samples.length > 0) {
      return {
        dir: d.full,
        samples: res.samples,
        config: gatherConfigResponse(d.full, gameSlug),
        endpointHint: res.endpointHint,
        candidates: res.candidates,
      };
    }
  }
  return null;
}

function debugNoSpinsFound(gameSlug: string) {
  const base = "fixtures/recordings";
  if (!existsSync(base)) return;
  const dirs = readdirSync(base)
    .filter((n) => n.includes(gameSlug + "__auto-"))
    .map((n) => ({ n, full: join(base, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  if (dirs.length === 0) {
    console.warn("[spin-detect] No auto-play recordings found at all.");
    return;
  }
  const latest = dirs[0]!.full;
  const entries = readJsonl<HttpEntry>(join(latest, "http.jsonl"));
  console.warn(
    `[spin-detect] NO SPIN RESPONSE matched in ${latest} (${entries.length} entries).`,
  );
  // Show top 10 POST responses that have JSON bodies — likely candidates
  const postJsonResponses = entries
    .filter((e) => e.phase === "response" && e.method === "POST" && e.body)
    .filter((e) => {
      try {
        const p = JSON.parse(e.body!);
        return p && typeof p === "object";
      } catch {
        return false;
      }
    })
    .slice(0, 10);
  console.warn(
    `[spin-detect] Top ${postJsonResponses.length} POST JSON responses (candidates for spin endpoint):`,
  );
  for (const e of postJsonResponses) {
    const bodyPreview = (e.body ?? "").slice(0, 120).replace(/\s+/g, " ");
    console.warn(`  ${e.status} ${e.url.slice(0, 100)}`);
    console.warn(`    body: ${bodyPreview}`);
  }
  console.warn(
    `[spin-detect] Nếu đúng spin endpoint nằm ở đây, set QA_SPIN_URL_PATTERN=<regex> trong .env`,
  );
  console.warn(
    `  VD cho PP: QA_SPIN_URL_PATTERN=/gs2c/|/playGame|/doSpin`,
  );
}

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

type SpinCandidate = {
  entry: HttpEntry;
  parsed: Record<string, unknown>;
  score: number;
  reasons: string[];
};

/**
 * Multi-heuristic spin detection dùng shared module src/runner/spin-detect.ts.
 * Score = URL score + body shape score. Hỗ trợ JSON và URL-encoded form.
 */
function gatherSpinSamples(recordingDir: string, limit = 3): {
  samples: unknown[];
  candidates: SpinCandidate[];
  endpointHint: string | null;
} {
  const entries = readJsonl<HttpEntry>(join(recordingDir, "http.jsonl"));
  const candidates: SpinCandidate[] = [];

  for (const e of entries) {
    if (e.phase !== "response") continue;
    if (!e.body) continue;
    if (shouldSkipUrl(e.url)) continue;

    const parsed = tryParseBody(e.body);
    if (!parsed) continue;

    const urlScore = scoreSpinUrl(e.url);
    const bodyScore = scoreSpinShape(parsed);

    let score = urlScore.score + bodyScore.score;
    const reasons = [...urlScore.reasons.map((r) => `url:${r}`), ...bodyScore.reasons.map((r) => `body:${r}`)];
    if (e.method === "POST") {
      score += 1;
      reasons.push("method:POST");
    }

    if (score >= 7) {
      candidates.push({ entry: e, parsed, score, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Dedup: lấy tối đa `limit` unique samples, ưu tiên score cao
  const samples: Record<string, unknown>[] = [];
  const seenKeys = new Set<string>();
  for (const c of candidates) {
    const id =
      (c.parsed as any).id ??
      (c.parsed as any).round ??
      (c.parsed as any).index ??
      (c.parsed as any).counter ??
      `${c.entry.t}-${c.score}`;
    if (seenKeys.has(String(id))) continue;
    seenKeys.add(String(id));
    samples.push(c.parsed);
    if (samples.length >= limit) break;
  }

  const topEndpoint = candidates[0]?.entry.url
    ? (() => {
        try {
          const u = new URL(candidates[0]!.entry.url);
          return `${u.host}${u.pathname}`;
        } catch {
          return null;
        }
      })()
    : null;

  return { samples, candidates, endpointHint: topEndpoint };
}

/**
 * Load tất cả artifacts đã được phase=collect produce trước đó.
 * Dùng khi user chạy phase=generate hoặc phase=run mà collect đã chạy ở session khác.
 * Throw nếu thiếu artifact bắt buộc (spec, options run, recording).
 */
function loadCollectArtifacts(gameSlug: string, gameUrl: string): {
  spec: GameSpec;
  rulesMarkdown: string;
  optionsJson: string | null;
  paytableMarkdown: string | null;
  optionsRunPath: string | null;
  normalizedSamples: unknown[];
  configResponse: unknown | null;
  hints: NetworkHints | null;
  autoDir: string | null;
  existingRulesRun: string | null;
  skipRulesNav: boolean;
} {
  const skipRulesNav = process.env.QA_SKIP_RULES_NAV !== "0";

  // 1. spec.json (Phase A output)
  const specPath = join("fixtures/specs", gameSlug, `${gameSlug}.spec.json`);
  if (!existsSync(specPath)) {
    throw new Error(
      `[load] Thiếu spec ${specPath}. Cần chạy phase=collect trước (POST /api/tasks/:id/collect hoặc QA_PHASE=collect).`,
    );
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as GameSpec;

  // 2. options run (snapshot + options.json + paytable.md)
  const optionsRunPath = findOptionsRunFor(gameSlug);
  if (!optionsRunPath) {
    throw new Error(`[load] Thiếu options run cho ${gameSlug}. Cần phase=collect trước.`);
  }
  const optionsJson = existsSync(join(optionsRunPath, "options.json"))
    ? readFileSync(join(optionsRunPath, "options.json"), "utf8")
    : null;
  const paytableMarkdown = existsSync(join(optionsRunPath, "paytable.md"))
    ? readFileSync(join(optionsRunPath, "paytable.md"), "utf8")
    : null;

  // 3. rulesMarkdown — derive lại từ snapshot (cùng logic như Phase 0b)
  const existingRulesRun = findRulesFor(gameSlug);
  let rulesMarkdown: string;
  if (existingRulesRun && !skipRulesNav) {
    rulesMarkdown = readFileSync(join(existingRulesRun, "rules.md"), "utf8");
  } else {
    const snapshotPath = join(optionsRunPath, "play-screen.json");
    const optionsMdPath = join(optionsRunPath, "options.md");
    const synth = existsSync(snapshotPath)
      ? synthRulesFromSnapshot(
          readFileSync(snapshotPath, "utf8"),
          existsSync(optionsMdPath) ? readFileSync(optionsMdPath, "utf8") : null,
        )
      : null;
    if (!synth) {
      throw new Error(`[load] Không derive được rulesMarkdown từ ${snapshotPath}`);
    }
    rulesMarkdown = synth;
  }

  // 4. auto recording → spin samples + config + network hints
  const auto = findAutoRunWithSpin(gameSlug);
  if (!auto || auto.samples.length === 0) {
    throw new Error(`[load] Thiếu auto-play recording có spin cho ${gameSlug}. Cần phase=collect trước.`);
  }

  const hintsPath = join("fixtures/specs", gameSlug, "network-hints.json");
  const hints: NetworkHints | null = existsSync(hintsPath)
    ? (JSON.parse(readFileSync(hintsPath, "utf8")) as NetworkHints)
    : null;

  let normalizedSamples = auto.samples;
  if (hints) {
    normalizedSamples = auto.samples.map((s) =>
      applyFieldMapping(s as Record<string, unknown>, hints.field_mapping),
    );
  }

  console.log(`[load] ✔ spec ${specPath}`);
  console.log(`[load] ✔ options run ${optionsRunPath}${paytableMarkdown ? " (with paytable.md)" : ""}`);
  console.log(`[load] ✔ rules synthesized (${rulesMarkdown.length} chars)`);
  console.log(`[load] ✔ auto recording ${auto.dir} (${auto.samples.length} samples)`);
  console.log(`[load] ${hints ? "✔" : "✗"} network hints${hints ? ` (conf=${hints.confidence.toFixed(2)})` : ""}`);

  // Suppress unused-var warning (gameUrl reserved cho future use trong load logic)
  void gameUrl;

  return {
    spec,
    rulesMarkdown,
    optionsJson,
    paytableMarkdown,
    optionsRunPath,
    normalizedSamples,
    configResponse: auto.config,
    hints,
    autoDir: auto.dir,
    existingRulesRun,
    skipRulesNav,
  };
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
  const gameUrl = resolveGameUrl("qa");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY) trong .env");
    process.exit(1);
  }
  // Expose gameUrl lên env cho subprocess bootstrap (rules/auto) inherit
  process.env.GAME_URL = gameUrl;

  const info = parseGameUrl(gameUrl);
  const spinsPerTest = Number(process.env.QA_SPINS_PER_TEST ?? 3);
  const skipExec = process.env.QA_SKIP_EXEC === "1";
  const force = process.env.QA_FORCE === "1";
  // Mặc định: restart = clean sạch artifact cũ của game (rules, options, recordings,
  // specs, generated test). Tắt bằng QA_CLEAN_BEFORE_RUN=0 nếu muốn reuse cache.
  const cleanBeforeRun = process.env.QA_CLEAN_BEFORE_RUN !== "0";

  // QA_PHASE chia pipeline thành 3 stage độc lập (UI dashboard dùng).
  //   collect  = Phase -1 (clean) + 0 (bootstrap) + A (understand → spec) + save context bundle. STOP.
  //   generate = Phase A.5 (catalog) + B (test code). Yêu cầu spec + rules + auto recording đã có.
  //   run      = Phase C (Playwright). Yêu cầu test spec đã sinh.
  //   all      = legacy CLI behaviour — chạy hết.
  const phase = (process.env.QA_PHASE ?? "all").toLowerCase();
  const validPhases = new Set(["all", "collect", "generate", "run"]);
  if (!validPhases.has(phase)) {
    console.error(`Invalid QA_PHASE=${phase}. Use: collect | generate | run | all`);
    process.exit(1);
  }
  const runCollect = phase === "all" || phase === "collect";
  const runGenerate = phase === "all" || phase === "generate";
  const runExec = phase === "all" || phase === "run";

  console.log("================================================================");
  console.log(` QA PIPELINE: ${info.gameSlug}  [phase=${phase}]`);
  console.log(` Spins per test: ${spinsPerTest}${force ? " (force re-collect)" : ""}`);
  console.log(`  Clean before run: ${cleanBeforeRun && runCollect ? "YES" : "no"}`);
  console.log("================================================================");

  // Cleanup chỉ chạy khi collect (tránh xóa spec đã có khi user chỉ muốn generate/run lại).
  if (cleanBeforeRun && runCollect) {
    console.log("\n========== [PHASE -1] CLEAN OLD ARTIFACTS ==========");
    const res = cleanGame(info.gameSlug);
    if (res.removed.length === 0) {
      console.log(`[clean] Không có artifact cũ cho "${info.gameSlug}".`);
    } else {
      console.log(`[clean] Đã xóa ${res.removed.length} item:`);
      for (const p of res.removed) console.log(`[clean]   - ${p}`);
    }
  }

  // ============== PHASE COLLECT (0 + A) ==============
  // Variables đi xuyên các phase — đặt let để cả branch "load" và "run fresh" gán.
  let spec: GameSpec;
  let rulesMarkdown: string;
  let optionsJson: string | null = null;
  let paytableMarkdown: string | null = null;
  let optionsRunPath: string | null = null;
  let normalizedSamples: unknown[];
  let configResponse: unknown | null = null;
  let hints: NetworkHints | null = null;
  let autoDir: string | null = null;
  let existingRulesRun: string | null = null;
  let skipRulesNav = process.env.QA_SKIP_RULES_NAV !== "0";

  if (!runCollect) {
    console.log("\n========== [PHASE COLLECT] SKIPPED — loading existing artifacts ==========");
    const loaded = loadCollectArtifacts(info.gameSlug, gameUrl);
    spec = loaded.spec;
    rulesMarkdown = loaded.rulesMarkdown;
    optionsJson = loaded.optionsJson;
    paytableMarkdown = loaded.paytableMarkdown;
    optionsRunPath = loaded.optionsRunPath;
    normalizedSamples = loaded.normalizedSamples;
    configResponse = loaded.configResponse;
    hints = loaded.hints;
    autoDir = loaded.autoDir;
    existingRulesRun = loaded.existingRulesRun;
    skipRulesNav = loaded.skipRulesNav;
  } else {

  // ===== Phase 0: Bootstrap — thu thập data nếu chưa có =====
  // Bootstrap subprocesses KHÔNG được giữ browser mở (chỉ dành cho Phase C test).
  const bootstrapEnv = {
    ...process.env,
    QA_KEEP_BROWSER_OPEN: "",
  };

  console.log("\n========== [PHASE 0] BOOTSTRAP ==========");

  // Step 0a: 1-shot extract từ play screen (options + rules_summary + buy_feature + special_bets)
  let optionsRun = force ? null : findOptionsRunFor(info.gameSlug);
  if (!optionsRun) {
    console.log(`[bootstrap] Chưa có play-screen snapshot cho ${info.gameSlug}, chạy extract-options (1-shot)...`);
    const code = await runCmd("npm", ["run", "options"], {
      ...bootstrapEnv,
      QA_SCREENSHOT_SCOPE: "options",
    });
    if (code !== 0) {
      console.error("[bootstrap] extract-options thất bại");
      process.exit(code);
    }
    optionsRun = findOptionsRunFor(info.gameSlug);
    if (!optionsRun) {
      console.error("[bootstrap] Không tìm thấy options run sau khi chạy — dừng");
      process.exit(1);
    }
  }
  console.log(`[bootstrap] ✔ play-screen snapshot: ${optionsRun}`);

  // Step 0b: rules — thử tìm rules.md cũ; nếu không có HOẶC skipRulesNav → derive từ snapshot
  existingRulesRun = force ? null : findRulesFor(info.gameSlug);
  if (existingRulesRun && !skipRulesNav) {
    rulesMarkdown = readFileSync(join(existingRulesRun, "rules.md"), "utf8");
    console.log(`[bootstrap] ✔ rules (multi-page legacy): ${existingRulesRun}`);
  } else {
    const snapshotPath = join(optionsRun, "play-screen.json");
    const optionsMdPath = join(optionsRun, "options.md");
    if (!existsSync(snapshotPath)) {
      console.error(`[bootstrap] Thiếu play-screen.json tại ${snapshotPath} — dừng`);
      process.exit(1);
    }
    const synth = synthRulesFromSnapshot(
      readFileSync(snapshotPath, "utf8"),
      existsSync(optionsMdPath) ? readFileSync(optionsMdPath, "utf8") : null,
    );
    if (!synth) {
      console.error(`[bootstrap] Không derive được rulesMarkdown từ snapshot — dừng`);
      process.exit(1);
    }
    rulesMarkdown = synth;
    console.log(`[bootstrap] ✔ rules derived from play-screen snapshot (skip multi-page nav)`);
  }

  let auto = force ? null : findAutoRunWithSpin(info.gameSlug);

  if (!auto) {
    // Default 5 spins (was 1) — đa dạng samples giúp Phase A detect intermediate
    // states (cascade, free-spin sub-rounds) chính xác hơn. Tăng tiếp qua
    // QA_BOOTSTRAP_SPINS nếu cần observe feature trigger tự nhiên.
    const bootstrapSpins = process.env.QA_BOOTSTRAP_SPINS ?? "5";
    console.log(`[bootstrap] Chưa có auto-play recording có spin, chạy auto-play (${bootstrapSpins} spins)...`);
    const code = await runCmd("npm", ["run", "auto"], {
      ...bootstrapEnv,
      AUTO_SPIN_COUNT: bootstrapSpins,
      QA_SCREENSHOT_SCOPE: "auto",
    });
    if (code !== 0) {
      console.error("[bootstrap] auto-play thất bại");
      process.exit(code);
    }
    auto = findAutoRunWithSpin(info.gameSlug);
  }

  // ===== Network detection: heuristic → AI fallback (KHÔNG cache, luôn detect fresh) =====
  // hints declared in outer scope

  // Heuristic pass (fresh mỗi lần)
  if (auto) {
    const topScore = auto.candidates[0]?.score ?? 0;
    if (topScore >= 10) {
      hints = hintsFromHeuristic(info.gameSlug, info.provider, auto.candidates[0], topScore);
      if (hints) {
        console.log(`[bootstrap] ✔ network hints từ heuristic fresh (score ${topScore}, conf=${hints.confidence.toFixed(2)})`);
        saveHints(info.gameSlug, hints); // ghi file để user inspect, KHÔNG reuse
      }
    }
  }

  // Fallback: heuristic yếu HOẶC không tìm thấy spin → AI detect
  if (!hints) {
    // Lấy recording mới nhất bất kể có heuristic match hay không
    const latestAutoDir = auto?.dir ?? latestDirIn("fixtures/recordings", (n) => n.includes(info.gameSlug + "__auto-"));
    if (!latestAutoDir) {
      console.error("[bootstrap] Không có recording để AI phân tích — dừng");
      process.exit(1);
    }
    console.log(`[bootstrap] Heuristic không tự tin, gọi AI detect spin endpoint...`);
    const responses = extractResponsesSummary(latestAutoDir, 20);
    if (responses.length === 0) {
      console.error("[bootstrap] Không có POST/GET response parse được — dừng");
      debugNoSpinsFound(info.gameSlug);
      process.exit(1);
    }
    try {
      hints = await detectSpinEndpointWithAI({
        gameSlug: info.gameSlug,
        provider: info.provider,
        responses,
      });
      console.log(
        `[bootstrap] ✔ AI detected endpoint: ${hints.spin_endpoint.url_pattern} (${hints.spin_endpoint.method}, ${hints.spin_endpoint.body_format}, conf=${hints.confidence.toFixed(2)})`,
      );
      console.log(`[bootstrap]   reasoning: ${hints.reasoning}`);
      if (hints.confidence < 0.3) {
        console.error("[bootstrap] AI confidence < 0.3 — có thể không đúng. Dừng để bạn review.");
        debugNoSpinsFound(info.gameSlug);
        process.exit(1);
      }
      saveHints(info.gameSlug, hints);
      // Re-gather samples dùng AI endpoint pattern
      const res = gatherSpinSamples(latestAutoDir, 3);
      if (res.samples.length === 0 && hints.spin_endpoint.url_pattern) {
        // AI đã detect — dùng pattern từ AI để lọc
        const entries = readJsonl<HttpEntry>(join(latestAutoDir, "http.jsonl"));
        const aiPattern = new RegExp(hints.spin_endpoint.url_pattern, "i");
        const samples: unknown[] = [];
        for (const e of entries) {
          if (e.phase !== "response" || !e.body) continue;
          if (!aiPattern.test(e.url)) continue;
          const parsed = tryParseBody(e.body);
          if (parsed) samples.push(parsed);
          if (samples.length >= 3) break;
        }
        auto = {
          dir: latestAutoDir,
          samples,
          config: gatherConfigResponse(latestAutoDir, info.gameSlug),
          endpointHint: hints.spin_endpoint.url_pattern,
          candidates: [],
        };
      }
    } catch (err) {
      console.error("[bootstrap] AI detection failed:", (err as Error).message);
      debugNoSpinsFound(info.gameSlug);
      process.exit(1);
    }
  }

  if (!auto || auto.samples.length === 0) {
    console.error("[bootstrap] Không có spin samples — dừng");
    process.exit(1);
  }

  console.log(`[bootstrap] ✔ ${auto.samples.length} spin samples: ${auto.dir}`);
  if (auto.endpointHint) console.log(`[bootstrap] ✔ spin endpoint: ${auto.endpointHint}`);
  if (auto.config) console.log(`[bootstrap] ✔ game config captured`);

  // ===== Normalize samples dùng field mapping (cross-provider standard shape) =====
  normalizedSamples = auto.samples;
  if (hints) {
    normalizedSamples = auto.samples.map((s) =>
      applyFieldMapping(s as Record<string, unknown>, hints!.field_mapping),
    );
    const sample0 = normalizedSamples[0] as Record<string, unknown>;
    console.log(
      `[bootstrap] ✔ normalized sample: betAmount=${sample0.betAmount}, winAmount=${sample0.winAmount}, endingBalance=${sample0.endingBalance}, id=${sample0.id}`,
    );
  }
  configResponse = auto.config;
  autoDir = auto.dir;

  // ===== Phase A: Understand =====
  console.log("\n========== [PHASE A] UNDERSTAND ==========");

  // Build response candidates summary cho AI (so AI có thể reject endpoint sai)
  const responseCandidates = autoDir
    ? extractResponsesSummary(autoDir, 10).map((r) => ({
        url: r.url,
        method: r.method,
        keys: r.parsed_keys,
        sample_values: (() => {
          // Đính kèm vài giá trị field để AI nhận biết wallet snapshot vs real spin
          try {
            const parsed = JSON.parse(r.body_preview.endsWith("}") ? r.body_preview : r.body_preview + "}");
            const out: Record<string, unknown> = {};
            for (const k of ["balance", "totalBet", "totalWin", "win", "bet", "matrix", "reels", "isEndRound"]) {
              if (k in parsed) out[k] = parsed[k];
            }
            return Object.keys(out).length ? out : undefined;
          } catch { return undefined; }
        })(),
      }))
    : [];

  console.log("[A] Đang ask Claude phân tích rules + responses + endpoint candidates → GameSpec...");
  spec = await understandGameRules({
    gameSlug: info.gameSlug,
    rulesMarkdown,
    sampleSpinResponses: normalizedSamples,
    configResponse,
    hintsCandidate: hints
      ? {
          url_pattern: hints.spin_endpoint.url_pattern,
          method: hints.spin_endpoint.method,
          field_mapping: hints.field_mapping as unknown as Record<string, unknown>,
        }
      : null,
    responseCandidates,
  });

  const specOutDir = join("fixtures/specs", info.gameSlug);
  mkdirSync(specOutDir, { recursive: true });
  const specPath = join(specOutDir, `${info.gameSlug}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`    ✔ GameSpec: ${specPath}`);
  console.log(`    ✔ ${spec.invariants.length} invariants, ${spec.symbols.length} symbols, ${spec.features.length} features`);
  if (spec.execution_strategy) {
    console.log(`    ✔ execution_strategy: channel=${spec.execution_strategy.channel}, completion=${spec.execution_strategy.completion_signal?.method}, ${spec.execution_strategy.field_validation?.length ?? 0} field rules, ${spec.execution_strategy.preflight_checks?.length ?? 0} preflight checks`);
    if ((spec.execution_strategy.spin_endpoint_evidence?.rejected_candidates?.length ?? 0) > 0) {
      console.log(`    ⚠ AI suspects current endpoint may be wrong:`);
      for (const r of spec.execution_strategy.spin_endpoint_evidence.rejected_candidates) {
        console.log(`        - ${r.pattern}: ${r.reason}`);
      }
    }
  }

  // ===== Preflight: validate samples khớp execution_strategy.field_validation + preflight_checks =====
  if (spec.execution_strategy) {
    console.log("\n[A] Running execution preflight (validate samples vs strategy)...");
    const preflight = runExecutionPreflight(spec.execution_strategy, normalizedSamples);
    console.log(formatPreflightResult(preflight));

    // Save preflight result vào file để UI hiển thị
    writeFileSync(
      join(specOutDir, `${info.gameSlug}.preflight.json`),
      JSON.stringify(preflight, null, 2),
    );

    if (!preflight.ok) {
      const strict = process.env.QA_PREFLIGHT_STRICT !== "0"; // default ON
      if (strict) {
        console.error(
          `\n[A] ✗ Preflight FAILED. Network detection có thể đã chọn sai endpoint.\n` +
          `    Set QA_PREFLIGHT_STRICT=0 để bypass (KHÔNG khuyến cáo) và tiếp tục dù vậy.\n` +
          `    Hoặc set QA_SPIN_URL_PATTERN=<regex> để override endpoint detection.`
        );
        process.exit(1);
      } else {
        console.warn(`\n[A] ⚠ Preflight FAILED nhưng QA_PREFLIGHT_STRICT=0 → tiếp tục dù vậy`);
      }
    }
  }

  // Save context-collection bundle (rules/config/options/samples) ngay sau Phase A để
  // UI có thể hiển thị "AI đã thu thập gì" — KHÔNG đợi Phase A.5 tạo full catalog.
  // Bundle này được Phase A.5 overwrite với catalog_meta sau.
  const collectCtx = {
    generated_at: new Date().toISOString(),
    game_slug: info.gameSlug,
    game_url_redacted: redactUrl(gameUrl),
    inputs: {
      rules_markdown: rulesMarkdown,
      rules_source: existingRulesRun && !skipRulesNav ? "multi_page_nav" : "synth_from_snapshot",
      options_json: existsSync(join(optionsRun, "options.json"))
        ? readFileSync(join(optionsRun, "options.json"), "utf8")
        : null,
      options_run_path: optionsRun,
      paytable_markdown: existsSync(join(optionsRun, "paytable.md"))
        ? readFileSync(join(optionsRun, "paytable.md"), "utf8")
        : null,
      config_response: configResponse,
      sample_spin_responses: normalizedSamples,
      spin_samples_source: autoDir,
      network_hints: hints,
    },
    catalog_meta: null,
  };
  writeFileSync(
    join(specOutDir, `${info.gameSlug}.catalog-context.json`),
    JSON.stringify(collectCtx, null, 2),
  );
  console.log(`    ✔ Context bundle saved (${(JSON.stringify(collectCtx).length / 1024).toFixed(1)} KB)`);

  // Cache loaded options/paytable cho Phase A.5 dùng tiếp
  optionsJson = collectCtx.inputs.options_json;
  paytableMarkdown = collectCtx.inputs.paytable_markdown;
  optionsRunPath = optionsRun;

  // Emit signal để runner mark stage="context_ready"
  console.log(`EVENT:phase_done ${JSON.stringify({ phase: "collect", stage: "context_ready" })}`);

  } // end if (runCollect)

  // ===== End of COLLECT phase. Early-exit nếu user chỉ chạy collect. =====
  if (!runGenerate && !runExec) {
    console.log("\n========== [PHASE COLLECT] DONE — stopping (QA_PHASE=collect) ==========");
    return;
  }

  // ============== PHASE GENERATE (A.5 + B) ==============
  let catalog: TestCaseCatalog;
  const specOutDirShared = join("fixtures/specs", info.gameSlug);
  const testDir = join("tests", "generated");
  const testPath = join(testDir, `${info.gameSlug}.spec.ts`);
  let testBlockCount: number;

  if (runGenerate) {
  // ===== Phase A.5: Generate Test Case Catalog =====
  console.log("\n========== [PHASE A.5] GENERATE TEST CASE CATALOG ==========");
  console.log("[A.5] Đang ask Claude sinh danh sách test cases từ rules + config + options + spec...");

  if (optionsJson) console.log(`[A.5] ✔ options catalog từ ${optionsRunPath}`);
  else console.log(`[A.5] (options catalog không có)`);
  if (paytableMarkdown) console.log(`[A.5] ✔ paytable transcribed (${paytableMarkdown.length} chars)`);
  else console.log(`[A.5] (paytable in-session không có — chỉ dựa vào rules + config)`);

  catalog = await generateTestCaseCatalog({
    gameSpec: spec,
    rulesMarkdown,
    optionsJson,
    sampleSpinResponses: normalizedSamples,
    configResponse,
    paytableMarkdown,
  });

  mkdirSync(specOutDirShared, { recursive: true });
  const catalogPath = join(specOutDirShared, `${info.gameSlug}.test-cases.json`);
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`[A.5] ✔ ${catalog.total_cases} test cases: ${catalogPath}`);
  const byCategory = new Map<string, number>();
  for (const c of catalog.cases) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
  for (const [cat, n] of byCategory) console.log(`[A.5]   - ${cat}: ${n}`);

  // ===== QA-readable markdown export =====
  // Auto-generate Step/Input/Expect markdown ngay sau khi catalog passed validation.
  // File này dành cho human QA review trước khi commit hoặc trước khi run live.
  try {
    const validationReport = validateCatalog(catalog, spec);
    const md = catalogToMarkdown({ catalog, spec, validationReport });
    const mdPath = join(specOutDirShared, `${info.gameSlug}.test-cases.qa-review.md`);
    writeFileSync(mdPath, md);
    console.log(`[A.5] ✔ QA review markdown: ${mdPath} (${md.length} chars)`);
  } catch (err) {
    console.warn(`[A.5] không tạo được QA review markdown: ${(err as Error).message}`);
  }

  // Cập nhật catalog_meta vào context bundle (đã được Phase A khởi tạo)
  const ctxPath = join(specOutDirShared, `${info.gameSlug}.catalog-context.json`);
  if (existsSync(ctxPath)) {
    try {
      const existing = JSON.parse(readFileSync(ctxPath, "utf8"));
      existing.catalog_meta = catalog.generation_meta ?? null;
      existing.generated_at = new Date().toISOString();
      writeFileSync(ctxPath, JSON.stringify(existing, null, 2));
      console.log(`[A.5] ✔ context bundle updated với catalog_meta`);
    } catch (err) {
      console.warn(`[A.5] không update được context bundle: ${(err as Error).message}`);
    }
  }

  // ===== Phase B: Generate test code =====
  console.log("\n========== [PHASE B] GENERATE TEST CODE ==========");
  console.log(`[B] Đang ask Claude generate Playwright .spec.ts với ${catalog.total_cases} test cases...`);
  const testCode = await generatePlaywrightTest({
    gameSpec: spec,
    harnessImportPath: "../../src/runner/test-harness.js",
    envVarUrl: "GAME_URL",
    spinsPerTest,
    testCases: catalog.cases,
  });

  mkdirSync(testDir, { recursive: true });
  writeFileSync(testPath, testCode);

  testBlockCount = (testCode.match(/\btest\(\s*[`'"]/g) || []).length;
  console.log(`    ✔ Test code: ${testPath} (${testCode.length} chars)`);
  console.log(
    `    ✔ ${testBlockCount} test() blocks emitted for ${catalog.total_cases} catalog cases`,
  );
  if (testBlockCount < catalog.total_cases) {
    console.warn(
      `    ⚠ AI emitted ${testBlockCount} blocks but catalog has ${catalog.total_cases} cases — some cases may be missing`,
    );
  }

  console.log(
    `EVENT:catalog_ready ${JSON.stringify({
      totalCases: catalog.total_cases,
      emittedTests: testBlockCount,
      caseIds: catalog.cases.map((c) => c.id),
    })}`,
  );
  console.log(`EVENT:phase_done ${JSON.stringify({ phase: "generate", stage: "catalog_ready" })}`);

  } else {
    // KHÔNG runGenerate — load catalog + verify test spec đã có (cho phase=run)
    console.log("\n========== [PHASE GENERATE] SKIPPED — loading existing catalog + test spec ==========");
    const catalogPath = join(specOutDirShared, `${info.gameSlug}.test-cases.json`);
    if (!existsSync(catalogPath)) {
      console.error(`[load] Thiếu catalog ${catalogPath}. Cần phase=generate trước.`);
      process.exit(1);
    }
    catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as TestCaseCatalog;
    if (!existsSync(testPath)) {
      console.error(`[load] Thiếu test spec ${testPath}. Cần phase=generate trước.`);
      process.exit(1);
    }
    const testCode = readFileSync(testPath, "utf8");
    testBlockCount = (testCode.match(/\btest\(\s*[`'"]/g) || []).length;
    console.log(`[load] ✔ catalog ${catalog.total_cases} cases, test spec ${testBlockCount} blocks`);
  }

  // ===== End of GENERATE phase. Early-exit nếu user chỉ chạy collect+generate. =====
  if (!runExec) {
    console.log("\n========== [PHASE GENERATE] DONE — stopping (QA_PHASE=generate, runExec=false) ==========");
    return;
  }

  if (skipExec) {
    console.log("\nQA_SKIP_EXEC=1 → dừng trước khi chạy Playwright.");
    return;
  }

  // ===== Phase C: Execute =====
  console.log("\n========== [PHASE C] EXECUTE PLAYWRIGHT TEST ==========");
  console.log("[C] Chạy Playwright test...");
  const hintsAbsPath = resolve(join("fixtures/specs", info.gameSlug, "network-hints.json"));
  // JSON reporter luôn bật để in status table sau khi chạy xong.
  const jsonPath =
    process.env.QA_PLAYWRIGHT_JSON ??
    resolve(join("fixtures/specs", info.gameSlug, "last-run.json"));
  mkdirSync(resolve(join("fixtures/specs", info.gameSlug)), { recursive: true });
  // list = stdout symbols, html = browsable, json = post-run analysis,
  // case-reporter = LIVE EVENT:case_end với full error/stack/attachments
  // (cho phép dashboard show error ngay khi 1 test fail, không đợi cả run xong).
  const caseReporterPath = resolve("src/runner/case-reporter.ts");
  const reporter = `list,html,json,${caseReporterPath}`;
  const pwEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GAME_URL: gameUrl,
    QA_SCREENSHOT_SCOPE: "test",
    QA_HINTS_FILE: hintsAbsPath,
    PLAYWRIGHT_JSON_OUTPUT_FILE: jsonPath,
    // Harness dùng biến này để chỉ giữ browser sau TEST CUỐI (nếu QA_KEEP_BROWSER_OPEN=1).
    // Các test trước đó sẽ đóng bình thường để pipeline chạy liên tục.
    QA_TOTAL_TESTS: String(testBlockCount),
  };
  const exitCode = await runCmd(
    "npx",
    ["playwright", "test", testPath, `--reporter=${reporter}`],
    pwEnv,
  );

  // Parse JSON reporter → in bảng status per-case
  printPerCaseStatus(jsonPath, catalog.cases);

  console.log("\n================================================================");
  if (exitCode === 0) {
    console.log("✔ ALL TESTS PASSED");
  } else {
    console.log(`✗ Some tests failed/skipped (exit ${exitCode})`);
  }
  console.log(`  GameSpec    : ${join(specOutDirShared, `${info.gameSlug}.spec.json`)}`);
  console.log(`  Test file   : ${testPath}`);
  console.log(`  JSON report : ${jsonPath}`);
  console.log(`EVENT:phase_done ${JSON.stringify({ phase: "run", stage: "tests_done", exitCode })}`);
  console.log(`  HTML report : npx playwright show-report reports/html`);
  console.log("================================================================");

  process.exit(exitCode);
}

type PwTestResult = {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  error?: { message?: string };
  errors?: Array<{ message?: string }>;
  duration?: number;
  annotations?: Array<{ type: string; description?: string }>;
};
type PwTest = {
  title: string;
  results: PwTestResult[];
  annotations?: Array<{ type: string; description?: string }>;
};
type PwSpec = { title: string; tests: PwTest[] };
type PwSuite = { specs: PwSpec[]; suites?: PwSuite[] };
type PwJsonReport = { suites: PwSuite[] };

function collectTests(suite: PwSuite): PwTest[] {
  const out: PwTest[] = [];
  for (const spec of suite.specs ?? []) for (const t of spec.tests) out.push({ ...t, title: spec.title });
  for (const child of suite.suites ?? []) out.push(...collectTests(child));
  return out;
}

function printPerCaseStatus(jsonPath: string, cases: { id: string; name: string; category: string }[]) {
  if (!existsSync(jsonPath)) {
    console.warn(`\n[status] Không có JSON report tại ${jsonPath} — skip status table`);
    return;
  }
  let report: PwJsonReport;
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8")) as PwJsonReport;
  } catch (err) {
    console.warn(`[status] JSON parse failed: ${(err as Error).message}`);
    return;
  }
  const tests: PwTest[] = [];
  for (const s of report.suites ?? []) tests.push(...collectTests(s));

  const byTitle = new Map<string, PwTest>();
  for (const t of tests) byTitle.set(t.title, t);

  console.log("\n================================================================");
  console.log(` PER-CASE STATUS (${tests.length} tests)`);
  console.log("================================================================");

  let passed = 0, failed = 0, skipped = 0, missing = 0;
  for (const c of cases) {
    // Playwright title pattern: the template `${id}: ${name}` from authoring
    const found = tests.find((t) => t.title.startsWith(`${c.id}:`)) ?? byTitle.get(c.id);
    if (!found) {
      missing++;
      console.log(`  ? ${c.id.padEnd(40)} [${c.category}] — không tìm thấy trong report`);
      continue;
    }
    const last = found.results[found.results.length - 1];
    const status = last?.status ?? "unknown";
    const dur = last?.duration ? `${Math.round(last.duration / 1000)}s` : "?";
    const errMsg =
      last?.error?.message ??
      last?.errors?.[0]?.message ??
      found.annotations?.find((a) => a.type === "skip")?.description ??
      last?.annotations?.find((a) => a.type === "skip")?.description ??
      "";
    const reasonShort = errMsg ? ` — ${(errMsg.split("\n")[0] ?? "").slice(0, 140)}` : "";

    if (status === "passed") {
      passed++;
      console.log(`  ✔ DONE    ${c.id.padEnd(40)} [${c.category}] (${dur})`);
    } else if (status === "skipped") {
      skipped++;
      console.log(`  ⊘ SKIP    ${c.id.padEnd(40)} [${c.category}]${reasonShort}`);
    } else if (status === "failed" || status === "timedOut" || status === "interrupted") {
      failed++;
      console.log(`  ✗ FAIL    ${c.id.padEnd(40)} [${c.category}] (${dur})${reasonShort}`);
    } else {
      console.log(`  ? ${status.toUpperCase()} ${c.id.padEnd(40)} [${c.category}]`);
    }
  }
  console.log("----------------------------------------------------------------");
  console.log(`  Passed: ${passed}   Failed: ${failed}   Skipped: ${skipped}${missing ? `   Missing: ${missing}` : ""}`);
  console.log("================================================================");
}

function runCmd(cmd: string, args: string[], env = process.env): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
