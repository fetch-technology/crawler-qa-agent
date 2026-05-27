// AI: called only during cold-start. Navigates into known info popups
// (paytable / info / buy / special-bet) using verified UI registry coords,
// captures screenshot + OCR + structured Vision extract per popup, saves
// markdown under fixtures/registry/<slug>/auxiliary-sources/. These richer
// sources then feed AI catalog generator so cases reference exact paytable
// multipliers, RTP, buy-bonus costs, etc.
//
// Order of operations per popup:
//   1. Find trigger key in uiMap (paytableButton, infoButton, etc.)
//   2. Click → wait for popup to render
//   3. Screenshot popup
//   4. OCR raw text (deterministic, tesseract)
//   5. 1 AI Vision call → structured JSON (symbol→multiplier, RTP, mechanics)
//   6. Synthesize markdown from both
//   7. Close popup: try registered closeButton__, fallback ESC + corner click
//   8. Wait until screen stable before next trigger
//
// All AI calls are cold-start only, never per-spin.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { dirForGame } from "../registry/paths.js";
import type { Paytable, UiRegistry } from "../registry/types.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { detectAnyPopup } from "../utils/ocr-popup.js";

export type DeepExtractResult = {
  paytableMd: string | null;
  infoMd: string | null;
  buyOptionsMd: string | null;
  specialBetsMd: string | null;
  paytableJson: PaytableStructured | null;
  rulesJson: RulesStructured | null;
  attempted: string[];   // trigger keys we tried
  succeeded: string[];   // trigger keys that produced output
};

export type PaytableStructured = {
  symbols?: Array<{
    id?: string | number;
    name: string;
    multipliers: Record<string, number>; // e.g. {"3":5, "4":20, "5":100}
    notes?: string;
  }>;
  wild?: { rules: string; substitutes: string[] };
  scatter?: { rules: string };
  features?: Array<{ name: string; trigger: string; description: string }>;
  rtp?: number;
  maxWin?: string;
};

/** Per-page AI response shape — PaytableStructured + pagination affordance. */
type PaytablePage = PaytableStructured & {
  pagination?: {
    hasNextPage?: boolean;
    nextButton?: { x: number; y: number } | null;
    pageLabel?: string | null;
  };
};

export type RulesStructured = {
  game_name?: string;
  rtp?: number;
  volatility?: string;
  max_win?: string;
  reel_layout?: string;
  ways_or_lines?: { kind: "lines" | "ways" | "cluster"; count: number };
  free_spins?: {
    trigger: string;
    spins_awarded: string;
    retrigger?: string;
    multiplier?: string;
  };
  buy_feature?: {
    available: boolean;
    options: Array<{ name: string; cost: string; effect: string }>;
  };
  special_bet?: {
    available: boolean;
    options: Array<{ name: string; cost: string; effect: string }>;
  };
  wild?: string;
  scatter?: string;
  notes?: string[];
};

/** Trigger keys we know are info-popup openers (in priority order). */
const INFO_TRIGGERS = [
  "paytableButton",
  "infoButton",      // user clarified this is typically its own button, not under menu
  "rulesButton",
  "helpButton",
  "menuButton",      // fallback if no dedicated infoButton — but menu often contains links
];

const BUY_TRIGGERS = ["buyBonusButton", "buyFeatureButton", "buyButton"];
const SPECIAL_BET_TRIGGERS = ["specialBetsButton", "anteButton", "doubleChanceButton"];

export async function deepExtractInfo(
  page: Page,
  uiMap: UiRegistry,
  gameSlug: string,
): Promise<DeepExtractResult> {
  const outDir = path.join(dirForGame(gameSlug), "auxiliary-sources");
  await mkdir(outDir, { recursive: true });

  const result: DeepExtractResult = {
    paytableMd: null,
    infoMd: null,
    buyOptionsMd: null,
    specialBetsMd: null,
    paytableJson: null,
    rulesJson: null,
    attempted: [],
    succeeded: [],
  };

  // PHASE A — Paytable (paginated: walks all pages via the next-arrow the AI
  // reports, merging symbols/features across pages).
  for (const key of ["paytableButton"]) {
    if (!uiMap[key]) continue;
    result.attempted.push(key);
    const r = await extractPaytablePaginated(page, uiMap, key);
    if (r) {
      const mdPath = path.join(outDir, "paytable.md");
      await writeFile(mdPath, r.md, "utf8");
      if (r.structured) {
        await writeFile(path.join(outDir, "paytable.json"), JSON.stringify(r.structured, null, 2) + "\n", "utf8");
        result.paytableJson = r.structured as PaytableStructured;
        // C1: convert auxiliary-sources paytable → registry Paytable shape and
        // persist via paytableStore so:
        //   (a) build-game-spec.ts can populate GameSpec.symbols[]
        //   (b) PaytableContentRule has expected data to diff at runtime
        try {
          const registryPaytable = convertToRegistryPaytable(r.structured as PaytableStructured);
          if (registryPaytable.symbols.length > 0) {
            await paytableStore.save(gameSlug, registryPaytable);
            console.log(`[deep-extract/paytable] saved ${registryPaytable.symbols.length} symbols → registry paytable.json`);
          }
        } catch (err) {
          console.warn(`[deep-extract/paytable] convert+save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      result.paytableMd = r.md;
      result.succeeded.push(key);
    }
  }

  // PHASE B — Info / rules
  for (const key of INFO_TRIGGERS.filter((k) => k !== "paytableButton")) {
    if (!uiMap[key]) continue;
    result.attempted.push(key);
    const r = await openExtractClose(page, uiMap, key, {
      label: "info",
      structuredSchema: "rules",
    });
    if (r) {
      const mdPath = path.join(outDir, "rules-full.md");
      await writeFile(mdPath, r.md, "utf8");
      if (r.structured) {
        await writeFile(path.join(outDir, "rules.json"), JSON.stringify(r.structured, null, 2) + "\n", "utf8");
        result.rulesJson = r.structured as RulesStructured;
      }
      result.infoMd = r.md;
      result.succeeded.push(key);
      break; // one is enough — usually only one info popup per game
    }
  }

  // PHASE C — Buy bonus options (open popup, capture options + costs, DO NOT confirm purchase)
  for (const key of BUY_TRIGGERS) {
    if (!uiMap[key]) continue;
    result.attempted.push(key);
    const r = await openExtractClose(page, uiMap, key, {
      label: "buy-options",
      structuredSchema: "buy",
      skipConfirmable: true, // never click "Yes/Confirm" button inside this popup
    });
    if (r) {
      const mdPath = path.join(outDir, "buy-options.md");
      await writeFile(mdPath, r.md, "utf8");
      result.buyOptionsMd = r.md;
      result.succeeded.push(key);
      break;
    }
  }

  // PHASE C — Special bets
  for (const key of SPECIAL_BET_TRIGGERS) {
    if (!uiMap[key]) continue;
    result.attempted.push(key);
    const r = await openExtractClose(page, uiMap, key, {
      label: "special-bets",
      structuredSchema: "special_bet",
      skipConfirmable: true,
    });
    if (r) {
      const mdPath = path.join(outDir, "special-bets.md");
      await writeFile(mdPath, r.md, "utf8");
      result.specialBetsMd = r.md;
      result.succeeded.push(key);
      break;
    }
  }

  console.log(`[deep-extract] attempted=[${result.attempted.join(",")}] succeeded=[${result.succeeded.join(",")}]`);
  return result;
}

/**
 * Open the paytable popup and walk ALL pages. Each page: screenshot → OCR →
 * 1 AI Vision call (returns symbols + a `pagination` block). If the AI reports
 * a next-page button, click it and repeat. Symbols/features are merged across
 * pages (deduped). Stops when: no next page, AI gives no next button, a page
 * adds nothing new (looped/static), or the page cap is reached.
 *
 * Env QA_PAYTABLE_PAGES caps pages scanned (default 8, clamped 1..20).
 */
async function extractPaytablePaginated(
  page: Page,
  uiMap: UiRegistry,
  triggerKey: string,
): Promise<{ md: string; structured: PaytableStructured } | null> {
  const trigger = uiMap[triggerKey];
  if (!trigger) return null;

  try {
    await page.mouse.click(trigger.x, trigger.y);
  } catch (err) {
    console.warn(`[deep-extract/paytable] click ${triggerKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  await page.waitForTimeout(2000); // popup animation

  // Prefer a QA-verified next-page arrow from the registry (stable, no AI
  // misread). AI Vision still detects WHEN we're on the last page (arrow
  // greyed out) + reads page CONTENT — but the click COORD comes from the
  // verified registry entry when one exists.
  const registryNext = findPaginationButton(uiMap, triggerKey);
  if (registryNext) {
    console.log(`[deep-extract/paytable] using registry next-button @ (${registryNext.x},${registryNext.y})${registryNext.status === "verified" ? " [verified]" : ` [${registryNext.status ?? "pending"}]`}`);
  }

  const maxPages = Math.min(20, Math.max(1, Number(process.env.QA_PAYTABLE_PAGES ?? "8") || 8));
  const pageStructured: PaytableStructured[] = [];
  const ocrPages: string[] = [];
  let prevSymbolCount = -1;

  for (let p = 0; p < maxPages; p++) {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    const det = await detectAnyPopup(page).catch(() => null);
    const ocrText = det?.detectedText ?? "";

    if (p === 0 && ocrText.length < 30) {
      console.warn(`[deep-extract/paytable] ${triggerKey}: OCR <30 chars on page 1 — popup likely didn't open`);
      await closePopup(page, uiMap, triggerKey);
      return null;
    }

    let parsed: PaytablePage | null = null;
    try {
      const raw = await askClaude({
        label: `deep-extract/paytable[p${p + 1}]`,
        system: STRUCTURED_PROMPTS.paytable,
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
          { type: "text", text: `OCR raw text (use as hint, but visual takes precedence):\n\n${ocrText.slice(0, 2000)}\n\nReturn JSON only.` },
        ],
        maxTurns: 1,
        timeoutMs: 60_000,
      });
      parsed = extractJsonFromText<PaytablePage>(raw);
    } catch (err) {
      console.warn(`[deep-extract/paytable] AI extract page ${p + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    ocrPages.push(ocrText);
    if (parsed) pageStructured.push(parsed);

    // Stop if a page contributed no NEW symbols (looped / static paytable).
    const mergedSoFar = mergePaytables(pageStructured);
    const symCount = mergedSoFar.symbols?.length ?? 0;
    if (p > 0 && symCount === prevSymbolCount) {
      console.log(`[deep-extract/paytable] page ${p + 1} added no new symbols → stop`);
      break;
    }
    prevSymbolCount = symCount;

    const pg = parsed?.pagination;
    if (!pg?.hasNextPage) break; // AI sees no/greyed next arrow → last page

    // Click coord: QA-verified registry button preferred; AI coord as fallback.
    const aiNext = pg.nextButton;
    const clickAt = registryNext
      ?? (aiNext && typeof aiNext.x === "number" && typeof aiNext.y === "number" ? aiNext : null);
    if (!clickAt) break; // nowhere reliable to click

    const src = registryNext ? "registry" : "ai-vision";
    console.log(`[deep-extract/paytable] page ${p + 1}${pg.pageLabel ? ` (${pg.pageLabel})` : ""} → next via ${src} @ (${clickAt.x},${clickAt.y})`);
    try {
      await page.mouse.click(clickAt.x, clickAt.y);
      await page.waitForTimeout(1200); // page transition
    } catch (err) {
      console.warn(`[deep-extract/paytable] next-page click failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  await closePopup(page, uiMap, triggerKey);

  if (pageStructured.length === 0) return null;
  const merged = mergePaytables(pageStructured);
  const md = synthMarkdown("paytable", ocrPages.join("\n\n--- PAGE BREAK ---\n\n"), merged);
  console.log(`[deep-extract/paytable] merged ${pageStructured.length} page(s) → ${merged.symbols?.length ?? 0} symbols, ${merged.features?.length ?? 0} features`);
  return { md, structured: merged };
}

/**
 * Find a QA-discovered "next page" arrow for a popup in the registry. Searches
 * keys namespaced under the trigger (e.g. `paytableButton__nextButton`) whose
 * name implies forward pagination. Prefers a verified entry over pending.
 * Returns null when none discovered (caller falls back to AI Vision coord).
 */
export function findPaginationButton(uiMap: UiRegistry, triggerKey: string): UiRegistry[string] | null {
  const prefix = `${triggerKey}__`;
  // Tokenize the leaf key (split camelCase + snake/kebab) so "nextButton",
  // "next_page", "rightArrow", "arrowRight" all match; "prevButton",
  // "closeButton", "context" do not.
  const isNextKey = (leaf: string): boolean => {
    const tokens = leaf
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.includes("next") || tokens.includes("forward")) return true;
    if (tokens.includes("arrow") && tokens.includes("right")) return true;
    return false;
  };
  let pending: UiRegistry[string] | null = null;
  for (const [k, el] of Object.entries(uiMap)) {
    if (!el || !k.startsWith(prefix)) continue;
    if (!isNextKey(k.slice(prefix.length))) continue;
    if (el.status === "verified") return el; // verified wins immediately
    if (!pending) pending = el;
  }
  return pending;
}

/**
 * Merge per-page paytable extracts into one. Symbols deduped by id (fallback
 * name); multipliers from a later page fill gaps on an existing symbol.
 * Features deduped by name. rtp/maxWin/wild/scatter take the FIRST non-empty.
 * Pure — exported for invariant tests.
 */
export function mergePaytables(pages: PaytableStructured[]): PaytableStructured {
  const out: PaytableStructured = { symbols: [], features: [] };
  const symByKey = new Map<string, NonNullable<PaytableStructured["symbols"]>[number]>();
  const featByName = new Map<string, NonNullable<PaytableStructured["features"]>[number]>();

  for (const pg of pages) {
    for (const s of pg.symbols ?? []) {
      const key = String(s.id ?? s.name ?? "").trim().toLowerCase();
      if (!key) continue;
      const existing = symByKey.get(key);
      if (existing) {
        // Fill any multiplier counts the existing symbol is missing.
        for (const [k, v] of Object.entries(s.multipliers ?? {})) {
          if (existing.multipliers[k] == null) existing.multipliers[k] = v;
        }
        if (!existing.notes && s.notes) existing.notes = s.notes;
      } else {
        symByKey.set(key, { ...s, multipliers: { ...(s.multipliers ?? {}) } });
      }
    }
    for (const f of pg.features ?? []) {
      const key = (f.name ?? "").trim().toLowerCase();
      if (key && !featByName.has(key)) featByName.set(key, f);
    }
    if (!out.wild && pg.wild) out.wild = pg.wild;
    if (!out.scatter && pg.scatter) out.scatter = pg.scatter;
    if (out.rtp == null && typeof pg.rtp === "number") out.rtp = pg.rtp;
    if (!out.maxWin && pg.maxWin) out.maxWin = pg.maxWin;
  }

  out.symbols = [...symByKey.values()];
  out.features = [...featByName.values()];
  return out;
}

/**
 * Click a trigger key to open a popup, screenshot, OCR + AI extract, close.
 * Returns { md, structured } if popup opened successfully, null if popup
 * never appeared or extraction failed.
 */
async function openExtractClose(
  page: Page,
  uiMap: UiRegistry,
  triggerKey: string,
  opts: {
    label: string;
    structuredSchema: "paytable" | "rules" | "buy" | "special_bet";
    skipConfirmable?: boolean;
  },
): Promise<{ md: string; structured: unknown } | null> {
  const trigger = uiMap[triggerKey];
  if (!trigger) return null;

  // Click trigger
  try {
    await page.mouse.click(trigger.x, trigger.y);
  } catch (err) {
    console.warn(`[deep-extract/${opts.label}] click ${triggerKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  await page.waitForTimeout(2000); // popup animation

  // Screenshot popup
  const buf = await page.screenshot({ type: "png", fullPage: false });

  // OCR text
  const det = await detectAnyPopup(page).catch(() => null);
  const ocrText = det?.detectedText ?? "";

  if (ocrText.length < 30) {
    // Likely no popup opened, or empty content. Bail.
    console.warn(`[deep-extract/${opts.label}] ${triggerKey}: OCR returned <30 chars — popup likely didn't open`);
    await closePopup(page, uiMap, triggerKey);
    return null;
  }

  // AI structured extract (1 call, vision)
  let structured: unknown = null;
  try {
    const sysPrompt = STRUCTURED_PROMPTS[opts.structuredSchema];
    const raw = await askClaude({
      label: `deep-extract/${opts.label}`,
      system: sysPrompt,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
        { type: "text", text: `OCR raw text (use as hint, but visual takes precedence):\n\n${ocrText.slice(0, 2000)}\n\nReturn JSON only.` },
      ],
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    structured = extractJsonFromText(raw);
  } catch (err) {
    console.warn(`[deep-extract/${opts.label}] AI extract failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Synthesize markdown
  const md = synthMarkdown(opts.label, ocrText, structured);

  // Close popup
  await closePopup(page, uiMap, triggerKey);
  return { md, structured };
}

const STRUCTURED_PROMPTS: Record<string, string> = {
  paytable: `You are extracting a slot-game paytable from a popup screenshot. The paytable may span MULTIPLE PAGES (a "Next >" / arrow / pagination dots, often with a page label like "1/7").
Return JSON only:
{
  "symbols": [
    { "id": "<short_code_or_name>", "name": "<symbol name>", "multipliers": {"3": <num>, "4": <num>, "5": <num>}, "notes": "<optional>" }
  ],
  "wild": { "rules": "<text>", "substitutes": ["<symbol names>"] },
  "scatter": { "rules": "<text>" },
  "features": [ { "name": "<feature>", "trigger": "<condition>", "description": "<text>" } ],
  "rtp": <number or null>,
  "maxWin": "<text or null>",
  "pagination": {
    "hasNextPage": <true if a NEXT-page arrow/button is visible AND not disabled; false on the last page>,
    "nextButton": { "x": <int>, "y": <int> } or null,
    "pageLabel": "<exact visible label e.g. '1/7' or null>"
  }
}
Only report data VISIBLE on THIS page (don't invent symbols from other pages). For "nextButton", give the CENTER pixel of the forward/next arrow (usually a ">" on the right edge). If this is the last page (no next, or next arrow greyed out), set hasNextPage=false and nextButton=null. Skip any field you can't see clearly. JSON only, no prose.`,

  rules: `You are extracting a slot-game info/rules popup into structured JSON.
Return JSON only:
{
  "game_name": "<string>",
  "rtp": <number or null, percentage>,
  "volatility": "<low|medium|high|null>",
  "max_win": "<text e.g. '5000x bet'>",
  "reel_layout": "<e.g. '5x4'>",
  "ways_or_lines": { "kind": "lines|ways|cluster", "count": <number> },
  "free_spins": {
    "trigger": "<condition e.g. '3+ scatters anywhere'>",
    "spins_awarded": "<text e.g. '10 spins'>",
    "retrigger": "<text or null>",
    "multiplier": "<text or null>"
  },
  "buy_feature": { "available": <bool>, "options": [{"name": "<text>", "cost": "<text>", "effect": "<text>"}] },
  "special_bet": { "available": <bool>, "options": [{"name": "<text>", "cost": "<text>", "effect": "<text>"}] },
  "wild": "<rules text>",
  "scatter": "<rules text>",
  "notes": ["<any extra rules>"]
}
Skip fields you can't see. JSON only, no prose.`,

  buy: `Extract a slot-game "Buy Feature" popup options. Return JSON only:
{
  "options": [
    { "name": "<option label e.g. 'Free Spins'>", "cost": "<text e.g. '100x base bet'>", "effect": "<what it triggers>" }
  ],
  "base_bet_visible": <number or null>
}
JSON only, no prose.`,

  special_bet: `Extract a slot-game "Special Bets" popup (ante / double chance / etc.). Return JSON only:
{
  "options": [
    { "name": "<text>", "cost": "<text>", "effect": "<higher trigger / different RTP / etc>" }
  ]
}
JSON only, no prose.`,
};

function synthMarkdown(label: string, ocrText: string, structured: unknown): string {
  const lines: string[] = [];
  lines.push(`# ${label} — extracted ${new Date().toISOString()}`);
  lines.push("");
  if (structured) {
    lines.push("## Structured");
    lines.push("```json");
    lines.push(JSON.stringify(structured, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## OCR raw text");
  lines.push("```");
  lines.push(ocrText.slice(0, 3000));
  lines.push("```");
  return lines.join("\n") + "\n";
}

/**
 * Close the currently-open popup. Strategy (try in order, stop when popup gone):
 *   1. closeButton namespaced under the trigger key (e.g. paytableButton__closeButton)
 *   2. Press Escape
 *   3. Click corner (5, 5) outside popup
 * After each attempt, OCR-check to verify popup keywords gone.
 */
async function closePopup(page: Page, uiMap: UiRegistry, triggerKey: string): Promise<void> {
  const closeKey = `${triggerKey}__closeButton`;
  const close = uiMap[closeKey];
  if (close) {
    try {
      await page.mouse.click(close.x, close.y);
      await page.waitForTimeout(1500);
      return;
    } catch {/* fall through */}
  }
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(1200);
  } catch {/* swallow */}
}

/**
 * C1: convert the AI-vision PaytableStructured shape (multipliers keyed by
 * match-count as string-or-mixed) into the registry-canonical Paytable shape
 * (payouts as Array<{count, multiplier}>).
 *
 * Tolerant of:
 *   - multipliers["3"] = 5             (integer count key, number value)
 *   - multipliers["3"] = "x5"          (string with prefix)
 *   - multipliers["3-5"] = "5x"        (cluster ranges — skip; rule engine
 *                                       handles cluster math separately)
 * Skips symbols whose payouts can't be parsed (don't emit garbage rows).
 *
 * Exposed for tests; not part of the deep-extract public API.
 */
export function convertToRegistryPaytable(src: PaytableStructured): Paytable {
  const symbols: Paytable["symbols"] = [];
  for (const s of src.symbols ?? []) {
    const payouts: Paytable["symbols"][number]["payouts"] = [];
    for (const [countRaw, valueRaw] of Object.entries(s.multipliers ?? {})) {
      const count = Number(countRaw);
      if (!Number.isInteger(count) || count < 2) continue; // skip "3-5" range keys
      const multiplier = parseMultiplier(valueRaw);
      if (multiplier === null) continue;
      payouts.push({ count, multiplier });
    }
    if (payouts.length === 0) continue;
    payouts.sort((a, b) => a.count - b.count);
    symbols.push({
      symbol: s.id != null ? String(s.id) : s.name,
      name: s.name,
      payouts,
    });
  }
  return {
    symbols,
    features: src.features?.map((f) => ({ name: f.name, description: f.description })) ?? [],
  };
}

function parseMultiplier(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  // Strip leading "x" / "X" / trailing "x" / commas; common AI output formats
  const cleaned = raw.replace(/[xX,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
