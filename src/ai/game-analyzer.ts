/**
 * AI Game Analyzer — canonical JSON output described in
 * docs/ai_powered_slot_game_testing.md §6.
 *
 * Input: existing `GameSpec` (from authoring.ts) + recording sample.
 * Output: minimal "analyzer report" with consistent field names so
 * downstream tools (dashboard, adapters, statistical sim) can rely on
 * shape regardless of provider.
 *
 * This module does NOT call the LLM — it maps already-analyzed `GameSpec`
 * (produced by `understandGameRules()`) into the canonical schema. The
 * AI step happened earlier; here we just normalize.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GameSpec } from "./authoring.js";
import { resolveAdapter } from "../adapters/registry.js";
import { tryParseBody } from "../runner/spin-detect.js";

/** Canonical Game Analyzer schema (§6). */
export type GameAnalyzerReport = {
  gameCode: string;
  transport: "http_querystring" | "http_json" | "websocket" | "unknown";
  /** Provider code as classified by adapter registry (PP / RG / GENERIC). */
  provider: string;
  /** Mechanic family (ways / paylines / cluster). */
  mechanic: string;
  /** Field names in the spin response (provider-specific). */
  reelField: string | null;
  widthField: string | null;
  heightField: string | null;
  winField: string | null;
  totalWinField: string | null;
  balanceField: string | null;
  /** Bet formula in plain language (echoed from GameSpec). */
  betFormula: string | null;
  /** Stable feature tags. */
  features: string[];
  /** Top-level keys in observed response shape. */
  observedResponseKeys: string[];
  /** Provenance: when this analyzer report was emitted. */
  generatedAt: string;
  /** Confidence — based on what's filled vs. null. */
  confidence: "high" | "medium" | "low";
  /**
   * Game logic version markers extracted from response/config:
   *   - PP: `cver` (client version), `sver` (server version), `ver` (config)
   *   - RG: `version`, `gameVersion`
   * Critical for QA: track which logic build is being tested.
   */
  logicVersion: {
    cver: string | null;
    sver: string | null;
    ver: string | null;
  };
};

const PP_FIELD_DEFAULTS = {
  reelField: "s",
  widthField: "sw",
  heightField: "sh",
  winField: "w",
  totalWinField: "tw",
  balanceField: "balance",
} as const;

const RG_FIELD_DEFAULTS = {
  reelField: "matrix",
  widthField: "reelWidth",
  heightField: "reelHeight",
  winField: "winAmount",
  totalWinField: "totalWinAmount",
  balanceField: "endingBalance",
} as const;

function pickFieldDefaults(provider: string) {
  if (provider === "PP") return PP_FIELD_DEFAULTS;
  if (provider === "RG") return RG_FIELD_DEFAULTS;
  return {
    reelField: null,
    widthField: null,
    heightField: null,
    winField: null,
    totalWinField: null,
    balanceField: null,
  };
}

function classifyTransport(sampleBody: string): GameAnalyzerReport["transport"] {
  if (!sampleBody) return "unknown";
  const trimmed = sampleBody.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "http_json";
  if (/^[\w._-]+=/.test(trimmed)) return "http_querystring";
  return "unknown";
}

function extractFeatureTags(spec: GameSpec): string[] {
  const tags: Set<string> = new Set(["base_spin"]);
  for (const f of spec.features ?? []) {
    const n = (f.name ?? "").toLowerCase();
    if (/free.?spin/.test(n)) tags.add("free_spin");
    if (/bonus/.test(n)) tags.add("bonus_possible");
    if (/cascade|tumble/.test(n)) tags.add("cascade");
    if (/multiplier/.test(n)) tags.add("multiplier");
    if (/scatter/.test(n)) tags.add("scatter");
    if (/wild/.test(n)) tags.add("wild");
    if (/buy|ante/.test(n)) tags.add("feature_buy");
  }
  return [...tags];
}

function gradeConfidence(report: GameAnalyzerReport): GameAnalyzerReport["confidence"] {
  const filled = [
    report.reelField,
    report.widthField,
    report.heightField,
    report.winField,
    report.balanceField,
    report.betFormula,
  ].filter(Boolean).length;
  if (filled >= 6) return "high";
  if (filled >= 3) return "medium";
  return "low";
}

export type AnalyzeInput = {
  slug: string;
  spec: GameSpec;
  /** Sample spin response body (raw string) for transport + shape detection. */
  sampleResponseBody?: string;
  /** Sample URL for provider sniffing. */
  sampleUrl?: string;
};

export function analyzeGame(input: AnalyzeInput): GameAnalyzerReport {
  const { slug, spec, sampleResponseBody, sampleUrl } = input;
  const adapter = resolveAdapter({ slug, spec, sampleUrl: sampleUrl ?? null });
  const transport = classifyTransport(sampleResponseBody ?? "");
  const defaults = pickFieldDefaults(adapter.providerCode);

  // Look up provider-specific field names from observed response if present.
  const parsed = sampleResponseBody ? tryParseBody(sampleResponseBody) : null;
  const observedKeys = parsed ? Object.keys(parsed) : [];
  const observedSet = new Set(observedKeys.map((k) => k.toLowerCase()));

  const reelField = defaults.reelField && observedSet.has(defaults.reelField.toLowerCase())
    ? defaults.reelField
    : firstMatch(observedKeys, ["matrix", "reels", "s", "symbols"]);
  const widthField = defaults.widthField && observedSet.has(defaults.widthField.toLowerCase())
    ? defaults.widthField
    : firstMatch(observedKeys, ["sw", "reelWidth", "width"]);
  const heightField = defaults.heightField && observedSet.has(defaults.heightField.toLowerCase())
    ? defaults.heightField
    : firstMatch(observedKeys, ["sh", "reelHeight", "height"]);
  const winField = defaults.winField && observedSet.has(defaults.winField.toLowerCase())
    ? defaults.winField
    : firstMatch(observedKeys, ["winAmount", "win", "w"]);
  const totalWinField = defaults.totalWinField && observedSet.has(defaults.totalWinField.toLowerCase())
    ? defaults.totalWinField
    : firstMatch(observedKeys, ["totalWinAmount", "totalWin", "tw"]);
  const balanceField = defaults.balanceField && observedSet.has(defaults.balanceField.toLowerCase())
    ? defaults.balanceField
    : firstMatch(observedKeys, ["endingBalance", "balance", "updatedBalance"]);

  const cver = parsed?.cver != null ? String(parsed.cver) : null;
  const sver = parsed?.sver != null ? String(parsed.sver) : null;
  const ver = parsed?.ver != null ? String(parsed.ver) : null;

  const report: GameAnalyzerReport = {
    gameCode: spec.game_code || slug,
    transport,
    provider: adapter.providerCode,
    mechanic: adapter.mechanicCode,
    reelField,
    widthField,
    heightField,
    winField,
    totalWinField,
    balanceField,
    betFormula: spec.bet_mechanics?.bet_amount_formula ?? null,
    features: extractFeatureTags(spec),
    observedResponseKeys: observedKeys,
    generatedAt: new Date().toISOString(),
    confidence: "low",
    logicVersion: { cver, sver, ver },
  };
  report.confidence = gradeConfidence(report);
  return report;
}

function firstMatch(keys: string[], candidates: string[]): string | null {
  const lc = new Map(keys.map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const hit = lc.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Persist analyzer report to `fixtures/analyzers/{slug}.json`. */
export function saveAnalyzerReport(report: GameAnalyzerReport): string {
  const path = join("fixtures", "analyzers", `${report.gameCode}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

export function loadAnalyzerReport(slug: string): GameAnalyzerReport | null {
  const path = join("fixtures", "analyzers", `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as GameAnalyzerReport;
}
