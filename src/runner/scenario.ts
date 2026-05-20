/**
 * Scenario fixture — labeled spin response captured from a real recording.
 * Một scenario = 1 deterministic outcome (vd "bonus_trigger", "big_win", "no_win").
 *
 * Scenario được generate từ fixtures/recordings/{slug}__(timestamp)/http.jsonl
 * bằng scenario-extractor.ts (CLI). Sau khi extract, scenario được mount vào page
 * qua deterministic.ts → mỗi lần test gọi /spin sẽ nhận response cố định.
 *
 * Format JSON file: fixtures/scenarios/{slug}/{label}.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ScenarioLabel =
  | "no_win"
  | "small_win"
  | "normal_win"
  | "big_win"
  | "max_win"
  | "bonus_trigger"
  | "free_spin"
  | "cascade"
  | "custom";

export type SpinResponseFixture = {
  /** Nguyên URL khi record (giữ để debug; matching dùng url_pattern). */
  url: string;
  /** Regex (string form) để match khi mock. Default được build từ spin-detect.getSpinUrlPattern(). */
  url_pattern: string;
  method: "POST" | "GET";
  status: number;
  headers: Record<string, string>;
  /** Raw body string (giữ nguyên format gốc — JSON object hoặc URL-encoded form). */
  body: string;
  /** Parsed body — convenience field cho extractor. Không dùng khi mock. */
  parsed?: Record<string, unknown>;
};

export type Scenario = {
  /** Slug game (vd "fiesta-magenta"). */
  slug: string;
  /** Label phân loại scenario. */
  label: ScenarioLabel;
  /** Free-form description (vd "Bonus trigger from spin #4 of recording auto-2026-05-13"). */
  description: string;
  /** Source recording dir (relative to repo root). Giữ để traceability. */
  source_recording: string;
  /**
   * Spin response chính. Mỗi lần page gọi /spin (URL match url_pattern) sẽ
   * trả response này. Nếu scenario gồm cascade/multiple spin responses,
   * dùng `spin_sequence` thay.
   */
  spin_response: SpinResponseFixture;
  /**
   * Cho cascade game (vd Sweet Bonanza): mỗi UI spin → nhiều API response.
   * Khi mock với sequence, request thứ N nhận response thứ N. Hết sequence
   * → trả response cuối lặp.
   */
  spin_sequence?: SpinResponseFixture[];
  /**
   * Các response phụ thuộc (authorize-game, config, balance). Mock cùng để
   * game khởi động được mà không gọi server thật.
   */
  prelude?: {
    authorize?: SpinResponseFixture;
    config?: SpinResponseFixture;
    balance?: SpinResponseFixture;
  };
  /** Metadata để assertion biết expected values. */
  expected: {
    bet?: number;
    win?: number;
    ending_balance?: number;
    starting_balance?: number;
    has_bonus?: boolean;
    is_free_spin?: boolean;
    round_id?: string;
  };
  /** Frozen wall-clock time để Date.now() trả về số này. */
  frozen_time_ms: number;
  /** Seed cho Math.random() (mulberry32). */
  random_seed: number;
};

const SCENARIOS_DIR = "fixtures/scenarios";

export function scenarioPath(slug: string, label: string): string {
  return join(SCENARIOS_DIR, slug, `${label}.json`);
}

export function loadScenario(slug: string, label: string): Scenario {
  const path = scenarioPath(slug, label);
  if (!existsSync(path)) {
    throw new Error(
      `Scenario not found: ${path}. Run \`npm run extract-scenarios -- ${slug}\` first.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Scenario;
}

export function listScenarios(slug: string): string[] {
  const dir = join(SCENARIOS_DIR, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function saveScenario(scenario: Scenario): string {
  const path = scenarioPath(scenario.slug, scenario.label);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}

/**
 * Heuristic phân loại scenario từ parsed spin body. Best-effort —
 * cascade game / provider lạ có thể return "custom". User có thể relabel
 * trong file JSON sau.
 */
export function classifyScenario(parsed: Record<string, unknown>): ScenarioLabel {
  const bet = num(parsed.betAmount ?? parsed.bet ?? (parsed as any).c);
  const win = num(parsed.winAmount ?? parsed.win ?? (parsed as any).tw);
  const isFreeSpin = parsed.isFreeSpin === true;
  const winFreeSpins = num((parsed as any).winFreeSpins);
  const isMaxWin = parsed.isMaxWin === true || parsed.isMaxCap === true;

  if (isMaxWin) return "max_win";
  if (winFreeSpins != null && winFreeSpins > 0) return "bonus_trigger";
  if (isFreeSpin) return "free_spin";
  if (win == null || win === 0) return "no_win";
  if (bet != null && bet > 0) {
    const ratio = win / bet;
    if (ratio >= 20) return "big_win";
    if (ratio >= 5) return "normal_win";
    return "small_win";
  }
  return "custom";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
