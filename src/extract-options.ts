import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { parseGameUrl, redactUrl, forceLangIfRequested } from "./utils/url.js";
import { resolveGameUrl } from "./utils/resolve-game-url.js";
import { attachRecorder } from "./recorder/attach.js";
import {
  extractPlayScreenSnapshot,
  decideRulesFlow,
  transcribeRulesPage,
  type PlayScreenSnapshot,
  type TranscribedOption,
  type TranscribedRulesPage,
} from "./ai/vision.js";
import { keepBrowserOpenIfRequested } from "./utils/keep-browser-open.js";
import { waitForGamePlayScreen } from "./runner/pre-game.js";
import { extractApiSnapshot, type ApiSnapshot } from "./extractors/network/index.js";
import {
  extractFeaturesFromPaytable,
  mergeFeatures,
  mergeAutoplayIntoUiOptions,
} from "./extractors/network/paytable-features.js";
import { deriveUiOptionsFromVision } from "./extractors/network/ui-options-from-vision.js";
import { enrichTiersFromText, detectTurboFromText } from "./extractors/network/enrich-from-text.js";

loadEnv();

const VIEWPORT = { width: 1440, height: 900 };

// Derive options catalog (flat list compatible với legacy consumers) từ snapshot.
function snapshotToOptions(s: PlayScreenSnapshot): TranscribedOption[] {
  const out: TranscribedOption[] = [];

  if (s.bet.current != null || s.bet.chips) {
    out.push({
      name: "Bet Size",
      category: "control",
      type: s.bet.step_kind === "chips" ? "selector" : s.bet.step_kind === "plus_minus" ? "button" : "selector",
      current_value: s.bet.current,
      possible_values: s.bet.chips,
      description: s.bet.min && s.bet.max ? `range ${s.bet.min}..${s.bet.max}` : null,
      location_hint: "bet control on play screen",
    });
  }

  if (s.buy_feature.available) {
    for (const opt of s.buy_feature.options) {
      out.push({
        name: `Buy Feature — ${opt.label}`,
        category: "game",
        type: "button",
        current_value: null,
        possible_values: null,
        description: [opt.price_multiplier, opt.price_absolute].filter(Boolean).join(" / ") || null,
        location_hint: "buy feature button on play screen",
      });
    }
  }

  if (s.special_bets.available) {
    for (const v of s.special_bets.variants) {
      out.push({
        name: `Special Bet — ${v.label}`,
        category: "control",
        type: "toggle",
        current_value: v.state,
        possible_values: null,
        description: v.price ? `cost: ${v.price}` : null,
        location_hint: "special bets area on play screen",
      });
    }
  }

  for (const c of s.controls) {
    // Dedupe với Spin (không phải option test được)
    if (/^spin$/i.test(c.name)) continue;
    out.push({
      name: c.name,
      category:
        /sound|music/i.test(c.name) ? "audio" :
        /setting|menu|info|help|rules|paytable|history/i.test(c.name) ? "other" :
        /auto|turbo|quick/i.test(c.name) ? "control" :
        "control",
      type: c.kind,
      current_value: c.state_hint,
      possible_values: null,
      description: null,
      location_hint: c.approx_location,
    });
  }

  return out;
}

/**
 * Trong cùng session (sau khi đã extract play-screen snapshot), navigate vào
 * Info / Paytable modal, scroll/page qua hết content, transcribe từng page.
 * Trả về markdown đã merge. Trả `null` nếu không tìm thấy rules.
 *
 * Tách riêng từ extract-rules.ts vì:
 * - Không cần spawn browser mới (tiết kiệm 30s).
 * - Bounded: max 15 iterations, 8 pages — fail-soft, không crash extract-options.
 */
async function capturePaytableInSession(args: {
  page: Page;
  runDir: string;
  viewport: { width: number; height: number };
}): Promise<{ markdown: string; pages: TranscribedRulesPage[] } | null> {
  const { page, runDir, viewport } = args;
  const maxIter = Number(process.env.OPTIONS_PAYTABLE_MAX_ITERATIONS ?? 15);
  const maxPages = Number(process.env.OPTIONS_PAYTABLE_MAX_PAGES ?? 8);
  const captured: TranscribedRulesPage[] = [];
  const seenPageKeys = new Set<string>();
  let lastAction: { action: string; reason: string; phase: string } | null = null;
  let stuckCount = 0;
  let lastShotHash = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const shotPath = join(runDir, "screenshots", `paytable-iter-${String(iter).padStart(2, "0")}.png`);
    await page.screenshot({ path: shotPath });

    let decision;
    try {
      decision = await decideRulesFlow({
        screenshotPath: shotPath,
        viewport,
        iteration: iter,
        pagesCaptured: captured.length,
        lastAction,
      });
    } catch (err) {
      console.warn(`[paytable] decideRulesFlow error iter=${iter}: ${(err as Error).message}`);
      break;
    }
    console.log(`[paytable] iter=${iter} action=${decision.action} phase=${decision.phase} rules_visible=${decision.rules_visible} reason=${decision.reason.slice(0, 80)}`);

    if (decision.action === "done" || decision.phase === "completed") break;
    if (decision.action === "error") {
      stuckCount++;
      if (stuckCount >= 2) {
        console.warn(`[paytable] AI báo error 2 lần liên tiếp — dừng`);
        break;
      }
    } else {
      stuckCount = 0;
    }

    // Nếu rules visible → transcribe page (dedupe theo current_page key)
    if (decision.rules_visible) {
      const key = `p=${decision.current_page ?? captured.length + 1}|t=${decision.estimated_total_pages ?? "x"}`;
      if (!seenPageKeys.has(key)) {
        seenPageKeys.add(key);
        try {
          const transcribed = await transcribeRulesPage({
            screenshotPath: shotPath,
            pageNumber: decision.current_page ?? captured.length + 1,
          });
          captured.push(transcribed);
          console.log(`[paytable]   ✔ transcribed page ${transcribed.page_number} (${transcribed.symbols.length} symbols, ${transcribed.features.length} features)`);
          if (captured.length >= maxPages) {
            console.log(`[paytable] reached max pages (${maxPages}) — dừng`);
            break;
          }
        } catch (err) {
          console.warn(`[paytable]   transcribe failed: ${(err as Error).message}`);
        }
      }
    }

    // Execute action
    try {
      if (decision.action === "click") {
        await page.mouse.click(decision.x, decision.y);
        await page.waitForTimeout(700);
      } else if (decision.action === "scroll") {
        const dir = decision.scroll_direction === "up" ? -1 : 1;
        const amount = (decision.scroll_amount ?? 400) * dir;
        await page.mouse.move(decision.x || viewport.width / 2, decision.y || viewport.height / 2);
        await page.mouse.wheel(0, amount);
        await page.waitForTimeout(400);
      } else if (decision.action === "wait") {
        await page.waitForTimeout(800);
      }
    } catch (err) {
      console.warn(`[paytable] action exec failed: ${(err as Error).message}`);
    }

    // Stuck detection: same screenshot bytes
    const shotBuf = (await page.screenshot()).toString("base64").slice(0, 200);
    if (shotBuf === lastShotHash) stuckCount++;
    else stuckCount = 0;
    lastShotHash = shotBuf;
    if (stuckCount >= 3) {
      console.warn(`[paytable] màn hình không đổi 3 iter — dừng`);
      break;
    }

    lastAction = { action: decision.action, reason: decision.reason, phase: decision.phase };
  }

  if (captured.length === 0) return null;

  // Build markdown
  const md: string[] = [`# Paytable / Rules (in-session capture, ${captured.length} pages)`, ""];
  for (const p of captured) {
    md.push(`## Page ${p.page_number}${p.title ? ` — ${p.title}` : ""}`);
    if (p.symbols.length) {
      md.push(`### Symbols`);
      for (const s of p.symbols) {
        const mults = s.multipliers
          ? Object.entries(s.multipliers)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "(no multipliers on this page)";
        md.push(`- **${s.code ?? s.name ?? "?"}**${s.name && s.code ? ` (${s.name})` : ""}: ${mults}${s.note ? ` — ${s.note}` : ""}`);
      }
      md.push("");
    }
    if (p.features.length) {
      md.push(`### Features`);
      for (const f of p.features) md.push(`- ${f}`);
      md.push("");
    }
    if (p.sections.length) {
      for (const sec of p.sections) {
        md.push(`### ${sec.heading}`);
        md.push(sec.body);
        md.push("");
      }
    }
    if (p.raw_text && !p.symbols.length && !p.sections.length) {
      md.push("```");
      md.push(p.raw_text);
      md.push("```");
      md.push("");
    }
  }

  return { markdown: md.join("\n"), pages: captured };
}

async function main() {
  const gameUrl = resolveGameUrl("options");
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error("Thiếu CLAUDE_CODE_OAUTH_TOKEN (hoặc ANTHROPIC_API_KEY)");
    process.exit(1);
  }

  const info = parseGameUrl(gameUrl);
  const outBase = process.env.OPTIONS_OUT_DIR ?? "fixtures/options";
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outBase, `${info.gameSlug}__${runId}`);

  console.log("================================================================");
  console.log(` EXTRACT-OPTIONS (1-shot from play screen): ${info.gameSlug}`);
  console.log(` URL           : ${redactUrl(gameUrl)}`);
  console.log(` Output dir    : ${runDir}`);
  console.log("================================================================");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(runDir, "video"), size: VIEWPORT },
  });
  const page: Page = await context.newPage();
  const recorder = await attachRecorder(context, page, runDir);

  let snapshot: PlayScreenSnapshot | null = null;
  let options: TranscribedOption[] = [];
  let paytableResult: { markdown: string; pages: TranscribedRulesPage[] } | null = null;
  let apiSnapshot: ApiSnapshot | null = null;
  let stopReason = "completed";

  try {
    const finalUrl = forceLangIfRequested(gameUrl);
    if (finalUrl !== gameUrl) console.log(`[lang] URL force-lang: ${redactUrl(finalUrl)}`);
    await page.goto(finalUrl, { waitUntil: "domcontentloaded" });

    await page.waitForTimeout(2_500);
    const preGameRes = await waitForGamePlayScreen(page, {
      viewport: VIEWPORT,
      label: "pre-game",
      maxIterations: Number(process.env.PRE_GAME_MAX_ITERATIONS ?? 25),
    });
    console.log(
      `[extract-options] play screen ${preGameRes.ready ? "ready" : "NOT READY"} sau ${preGameRes.iterations} iter, dismissed ${preGameRes.dismissed} blockers`,
    );

    if (!preGameRes.ready) {
      console.warn("[extract-options] Play screen không ready — vẫn chụp để debug");
      stopReason = "play_screen_not_ready";
    }

    // 1-shot: chụp 1 screenshot, gửi Claude, parse JSON
    const shotPath = join(runDir, "screenshots", "play-screen.png");
    await page.screenshot({ path: shotPath });
    console.log(`[extract-options] Chụp play screen → ${shotPath}, gửi AI extract...`);

    try {
      snapshot = await extractPlayScreenSnapshot({ screenshotPath: shotPath, viewport: VIEWPORT });
      options = snapshotToOptions(snapshot);
      console.log(`[extract-options] ✔ extracted ${options.length} options`);
      console.log(`[extract-options]   title=${snapshot.game_title ?? "?"}, bet=${snapshot.bet.current ?? "?"}, buy_feature=${snapshot.buy_feature.available}, special_bets=${snapshot.special_bets.available}`);
    } catch (err) {
      console.error("[extract-options] AI error:", err);
      stopReason = "ai-error";
    }

    // API extractor: parse http.jsonl mà recorder đang ghi → ApiSnapshot canonical.
    // Deterministic cho PP/RG, AI fallback cho providers khác. Fail-soft.
    const skipApiExtract = process.env.OPTIONS_SKIP_API_EXTRACT === "1";
    if (!skipApiExtract) {
      console.log(`\n[extract-options] >>> Parse API traffic → ApiSnapshot...`);
      try {
        apiSnapshot = await extractApiSnapshot(join(runDir, "http.jsonl"), {
          forceAi: process.env.OPTIONS_FORCE_AI_EXTRACT === "1",
          skipAi: process.env.OPTIONS_SKIP_AI_EXTRACT === "1",
        });
        if (apiSnapshot) {
          console.log(
            `[extract-options] ✔ ApiSnapshot ready (provider=${apiSnapshot.provider}, kind=${apiSnapshot.extractor_kind}, sources=${apiSnapshot.source_endpoints.length})`,
          );
        } else {
          console.log(`[extract-options] (API extractor không tìm được endpoint config)`);
        }
      } catch (err) {
        console.warn(`[extract-options] API extract failed: ${(err as Error).message}`);
      }
    }

    // In-session paytable capture: sau khi đã có snapshot, mở Info / Paytable
    // navigate qua các page rồi transcribe. Fail-soft.
    const skipPaytable = process.env.OPTIONS_SKIP_PAYTABLE === "1";
    if (!skipPaytable && snapshot) {
      console.log(`\n[extract-options] >>> Bắt đầu in-session paytable capture...`);
      try {
        paytableResult = await capturePaytableInSession({ page, runDir, viewport: VIEWPORT });
        if (paytableResult) {
          console.log(`[extract-options] ✔ paytable captured: ${paytableResult.pages.length} pages, ${paytableResult.markdown.length} chars`);
        } else {
          console.log(`[extract-options] (paytable không capture được — fall back to play-screen-derived rules)`);
        }
      } catch (err) {
        console.warn(`[extract-options] paytable capture failed: ${(err as Error).message}`);
      }
    }

    // Enrich apiSnapshot.features + autoplay từ paytable text (mechanics rules + autoplay
    // config chỉ có ở rules screen). 1 AI call duy nhất extract cả 2 block.
    let paytableExtraction: { features: ApiSnapshot["features"]; autoplay: NonNullable<ApiSnapshot["ui_options"]>["autoplay"] } | null = null;
    if (apiSnapshot && paytableResult && process.env.OPTIONS_SKIP_FEATURE_ENRICH !== "1") {
      console.log(`\n[extract-options] >>> Trích features mechanics + autoplay options từ paytable text...`);
      try {
        const result = await extractFeaturesFromPaytable(paytableResult.markdown);
        if (result) {
          paytableExtraction = result;
          if (result.features) {
            apiSnapshot.features = mergeFeatures(apiSnapshot.features, result.features);
            console.log(`[extract-options] ✔ features enriched từ paytable`);
          }
        }
      } catch (err) {
        console.warn(`[extract-options] feature enrich failed: ${(err as Error).message}`);
      }
    }

    // Derive ui_options.autoplay/sound/turbo skeleton từ vision controls.
    if (apiSnapshot && snapshot && !apiSnapshot.ui_options) {
      apiSnapshot.ui_options = deriveUiOptionsFromVision(snapshot);
      if (apiSnapshot.ui_options) {
        console.log(`[extract-options] ✔ ui_options derived từ vision controls`);
      }
    }

    // Merge autoplay detail (presets, max_rounds, stop conditions) từ paytable AI.
    if (apiSnapshot && paytableExtraction?.autoplay) {
      apiSnapshot.ui_options = mergeAutoplayIntoUiOptions(apiSnapshot.ui_options, paytableExtraction.autoplay);
      console.log(`[extract-options] ✔ autoplay options merged từ paytable text`);
    }

    // Enrich tier/variant labels + prices từ features.other_features text.
    if (apiSnapshot) {
      const before = JSON.stringify({
        bf: apiSnapshot.buy_feature?.tiers,
        sb: apiSnapshot.special_bets?.variants,
      });
      apiSnapshot = enrichTiersFromText(apiSnapshot);
      const after = JSON.stringify({
        bf: apiSnapshot.buy_feature?.tiers,
        sb: apiSnapshot.special_bets?.variants,
      });
      if (before !== after) {
        console.log(`[extract-options] ✔ buy_feature/special_bets labels + prices enriched`);
      }
    }

    // Detect Turbo Spin từ vision raw obs + paytable (sweet bonanza ẩn dưới hint text).
    if (apiSnapshot) {
      const beforeTurbo = apiSnapshot.ui_options?.turbo_spin;
      apiSnapshot = detectTurboFromText({
        apiSnapshot,
        visionFeatureMentions: snapshot?.rules_summary?.feature_mentions ?? null,
        visionRawObservations: snapshot?.raw_observations ?? null,
        paytableMarkdown: paytableResult?.markdown ?? null,
      });
      if (!beforeTurbo && apiSnapshot.ui_options?.turbo_spin?.available) {
        console.log(`[extract-options] ✔ turbo_spin detected từ feature mentions`);
      }
    }
  } catch (err) {
    console.error("Fatal:", err);
    stopReason = "exception";
  } finally {
    console.log(`\n<<< extract-options kết thúc (${stopReason}). Flush output...`);
    await page.screenshot({ path: join(runDir, "screenshots", "final.png") }).catch(() => {});

    // options.json (flat catalog — tương thích với generate-and-run.ts cũ)
    writeFileSync(
      join(runDir, "options.json"),
      JSON.stringify(
        {
          game: info.gameSlug,
          provider: info.provider,
          capturedAt: new Date().toISOString(),
          optionsCount: options.length,
          options,
        },
        null,
        2,
      ),
    );

    // play-screen.json (snapshot đầy đủ — vision + api + raw)
    const playScreenPayload = {
      game: info.gameSlug,
      provider: info.provider,
      capturedAt: new Date().toISOString(),
      vision: snapshot,
      api: apiSnapshot,
    };
    writeFileSync(join(runDir, "play-screen.json"), JSON.stringify(playScreenPayload, null, 2));

    // api-snapshot.json riêng (canonical structured data từ network)
    if (apiSnapshot) {
      writeFileSync(join(runDir, "api-snapshot.json"), JSON.stringify(apiSnapshot, null, 2));
    }

    // Markdown dễ đọc
    const md: string[] = [`# Play Screen Snapshot — ${info.gameSlug}`, ""];
    md.push(`Captured: ${new Date().toISOString()}`);
    md.push(`Provider: ${info.providerName} (${info.provider})`, "");
    if (snapshot) {
      md.push(`**Title:** ${snapshot.game_title ?? "(n/a)"}`);
      md.push(`**Balance:** ${snapshot.balance.value ?? "?"} ${snapshot.balance.currency ?? ""}`);
      md.push(
        `**Bet:** current=${snapshot.bet.current ?? "?"}, step=${snapshot.bet.step_kind}, chips=${snapshot.bet.chips?.join(",") ?? "(n/a)"}`,
      );
      md.push("");

      md.push(`## Rules Summary`);
      md.push(`- Paylines/Ways: ${snapshot.rules_summary.paylines_or_ways ?? "(n/a)"}`);
      md.push(`- Max Win: ${snapshot.rules_summary.max_win ?? "(n/a)"}`);
      if (snapshot.rules_summary.feature_mentions.length) {
        md.push(`- Features:`);
        for (const f of snapshot.rules_summary.feature_mentions) md.push(`  - ${f}`);
      }
      if (snapshot.rules_summary.visible_symbols.length) {
        md.push(`- Symbols visible: ${snapshot.rules_summary.visible_symbols.join(", ")}`);
      }
      md.push("");

      if (snapshot.buy_feature.available) {
        md.push(`## Buy Feature`);
        for (const o of snapshot.buy_feature.options) {
          md.push(`- ${o.label}: ${[o.price_multiplier, o.price_absolute].filter(Boolean).join(" / ") || "(price n/a)"}`);
        }
        md.push("");
      }
      if (snapshot.special_bets.available) {
        md.push(`## Special Bets`);
        for (const v of snapshot.special_bets.variants) {
          md.push(`- ${v.label} — state=${v.state ?? "?"}${v.price ? `, price=${v.price}` : ""}`);
        }
        md.push("");
      }

      md.push(`## Controls`);
      for (const c of snapshot.controls) {
        md.push(`- **${c.name}** (${c.kind}) — ${c.approx_location}${c.state_hint ? `, state=${c.state_hint}` : ""}`);
      }
      md.push("");
    } else {
      md.push(`_(snapshot extraction failed)_`);
    }

    if (apiSnapshot) {
      md.push(`## API Snapshot (${apiSnapshot.provider} / ${apiSnapshot.extractor_kind})`);
      md.push("```json");
      md.push(JSON.stringify(apiSnapshot, null, 2));
      md.push("```");
      md.push("");
    }
    writeFileSync(join(runDir, "options.md"), md.join("\n"));

    // Save paytable nếu capture thành công
    if (paytableResult) {
      writeFileSync(join(runDir, "paytable.md"), paytableResult.markdown);
      writeFileSync(
        join(runDir, "paytable.json"),
        JSON.stringify(
          {
            game: info.gameSlug,
            capturedAt: new Date().toISOString(),
            pageCount: paytableResult.pages.length,
            pages: paytableResult.pages,
          },
          null,
          2,
        ),
      );
    }

    await keepBrowserOpenIfRequested(page);

    await recorder.finalize({
      gameUrl,
      gameSlug: info.gameSlug,
      operator: info.operator,
      stopReason,
      extra: { optionsCount: options.length, hasSnapshot: !!snapshot },
    });

    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log(`\n✔ Output: ${runDir}`);
    console.log(` - options.json     (${options.length} flat options)`);
    console.log(` - play-screen.json (vision + api combined snapshot)`);
    console.log(` - options.md       (human-readable, includes embedded JSON)`);
    if (apiSnapshot) {
      console.log(` - api-snapshot.json (${apiSnapshot.provider} / ${apiSnapshot.extractor_kind}, ${apiSnapshot.source_endpoints.length} endpoint(s))`);
    }
    if (paytableResult) {
      console.log(` - paytable.md      (${paytableResult.pages.length} pages transcribed in-session)`);
    }

    // JSON đầy đủ đã ghi ra file ở runDir; chỉ log summary ngắn để full-log tab không phình.
    if (apiSnapshot) {
      const endpointCount = apiSnapshot.source_endpoints?.length ?? 0;
      const balance = apiSnapshot.balance?.cash ?? null;
      const currency = apiSnapshot.balance?.currency ?? null;
      console.log(
        ` API summary: provider=${apiSnapshot.provider}, kind=${apiSnapshot.extractor_kind}, endpoints=${endpointCount}, balance=${balance} ${currency ?? ""}`.trim(),
      );
    }
    if (snapshot) {
      const controlCount = snapshot.controls?.length ?? 0;
      console.log(` Vision summary: title=${snapshot.game_title ?? "n/a"}, controls=${controlCount}, bet=${snapshot.bet?.current ?? "n/a"}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
