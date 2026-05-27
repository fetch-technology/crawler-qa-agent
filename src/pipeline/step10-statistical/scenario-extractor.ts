// Classify dedup'd spin results into QA-meaningful labels, then persist the
// first occurrence of each label as a scenario fixture for regression testing
// and rule-engine unit tests.
//
// Labels:
//   - no_win        — win == 0 (baseline shape check)
//   - small_win     — 0 < win < bet (loss net)
//   - normal_win    — bet ≤ win < 10× bet (typical)
//   - big_win       — 10× bet ≤ win < 50× bet
//   - huge_win      — 50× bet ≤ win < 500× bet
//   - mega_win      — 500× bet ≤ win
//   - bonus_trigger — first spin entering BONUS state
//   - free_spin     — isFreeSpin=true
//   - retrigger     — state == RETRIGGER
//   - cascade_full  — cascadeFrames.length >= 5

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { dirForGame } from "../registry/paths.js";

export type ScenarioLabel =
  | "no_win"
  | "small_win"
  | "normal_win"
  | "big_win"
  | "huge_win"
  | "mega_win"
  | "bonus_trigger"
  | "free_spin"
  | "retrigger"
  | "cascade_full";

export type ScenarioFixture = {
  label: ScenarioLabel;
  capturedAt: string;
  source: "cold-start" | "warm-start";
  spin: NormalizedSpinResult;
  winRatio: number; // win / bet for context
};

export type ExtractResult = {
  fixtures: ScenarioFixture[];
  savedPaths: string[];
};

export async function extractScenarios(
  gameSlug: string,
  spins: NormalizedSpinResult[],
  source: "cold-start" | "warm-start" = "cold-start",
): Promise<ExtractResult> {
  const seen = new Set<ScenarioLabel>();
  const fixtures: ScenarioFixture[] = [];

  for (const spin of spins) {
    const labels = classify(spin);
    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);
      fixtures.push({
        label,
        capturedAt: new Date().toISOString(),
        source,
        spin,
        winRatio: spin.bet > 0 ? spin.win / spin.bet : 0,
      });
    }
  }

  const dir = path.join(dirForGame(gameSlug), "scenarios");
  await mkdir(dir, { recursive: true });
  const savedPaths: string[] = [];
  for (const fx of fixtures) {
    const filePath = path.join(dir, `${fx.label}.json`);
    await writeFile(filePath, JSON.stringify(fx, null, 2) + "\n", "utf8");
    savedPaths.push(filePath);
  }

  return { fixtures, savedPaths };
}

function classify(spin: NormalizedSpinResult): ScenarioLabel[] {
  const labels: ScenarioLabel[] = [];

  // Win-amount tiers (skip if free spin since bet = 0).
  if (!spin.isFreeSpin && spin.bet > 0) {
    const ratio = spin.win / spin.bet;
    if (spin.win === 0) labels.push("no_win");
    else if (ratio < 1) labels.push("small_win");
    else if (ratio < 10) labels.push("normal_win");
    else if (ratio < 50) labels.push("big_win");
    else if (ratio < 500) labels.push("huge_win");
    else labels.push("mega_win");
  }

  // State-based labels (orthogonal to win tier).
  if (spin.isFreeSpin) labels.push("free_spin");
  if (spin.hasBonus) labels.push("bonus_trigger");
  if (spin.state === "RETRIGGER") labels.push("retrigger");
  if (spin.cascadeFrames.length >= 5) labels.push("cascade_full");

  return labels;
}
