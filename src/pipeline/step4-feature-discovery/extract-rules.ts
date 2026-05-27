// AI: called only during cold-start. Extracts game rules / paytable / play-screen
// snapshot into markdown that feeds the AI catalog generator. NEVER per-spin.
//
// Implementation: reuses legacy `extractPlayScreenSnapshot` from src/ai/vision.ts
// (1 AI call). Saves outputs to registry so ai-catalog can pick them up via
// auxiliary-sources.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { extractPlayScreenSnapshot, type PlayScreenSnapshot } from "../../ai/vision.js";
import { dirForGame } from "../registry/paths.js";

export type RulesExtractionResult = {
  snapshotPath: string | null;
  rulesMdPath: string | null;
  optionsJsonPath: string | null;
  snapshot: PlayScreenSnapshot | null;
};

export async function extractRules(
  page: Page,
  gameSlug: string,
): Promise<RulesExtractionResult> {
  const dir = dirForGame(gameSlug);
  await mkdir(dir, { recursive: true });

  // Capture screenshot for vision input.
  const screenshotPath = path.join(dir, "play-screen.png");
  const buf = await page.screenshot({ type: "png", fullPage: false });
  await writeFile(screenshotPath, buf);

  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  let snapshot: PlayScreenSnapshot;
  try {
    snapshot = await extractPlayScreenSnapshot({ screenshotPath, viewport });
  } catch (err) {
    console.warn(
      `[step4/extract-rules] vision call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      snapshotPath: screenshotPath,
      rulesMdPath: null,
      optionsJsonPath: null,
      snapshot: null,
    };
  }

  // Persist raw snapshot.
  const snapshotJsonPath = path.join(dir, "play-screen.json");
  await writeFile(snapshotJsonPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

  // Synthesize rules.md from the snapshot.
  const rulesMd = synthRulesFromSnapshot(snapshot);
  const rulesMdPath = path.join(dir, "rules.md");
  await writeFile(rulesMdPath, rulesMd, "utf8");

  // Synthesize options.json (registry-native — read by auxiliary-sources).
  const optionsJson = synthOptionsFromSnapshot(gameSlug, snapshot);
  const optionsJsonPath = path.join(dir, "options.json");
  await writeFile(optionsJsonPath, JSON.stringify(optionsJson, null, 2) + "\n", "utf8");

  return { snapshotPath: screenshotPath, rulesMdPath, optionsJsonPath, snapshot };
}

function synthRulesFromSnapshot(s: PlayScreenSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${s.game_title ?? "Game"} — rules summary`);
  lines.push("");
  if (s.provider_guess) lines.push(`Provider: ${s.provider_guess}`);
  if (s.balance.currency) lines.push(`Currency: ${s.balance.currency}`);
  if (s.balance.value) lines.push(`Initial balance observed: ${s.balance.value}`);
  lines.push("");
  lines.push("## Bet mechanics");
  if (s.bet.current) lines.push(`- Current bet: ${s.bet.current}`);
  if (s.bet.min) lines.push(`- Min bet: ${s.bet.min}`);
  if (s.bet.max) lines.push(`- Max bet: ${s.bet.max}`);
  lines.push(`- Step kind: ${s.bet.step_kind}`);
  if (s.bet.chips && s.bet.chips.length > 0) {
    lines.push(`- Chip values: ${s.bet.chips.join(", ")}`);
  }
  lines.push("");
  lines.push("## Visible controls");
  for (const c of s.controls) {
    lines.push(
      `- **${c.name}** (${c.kind}, ${c.visible ? "visible" : "hidden"})${
        c.state_hint ? ` — state: ${c.state_hint}` : ""
      } @ ${c.approx_location}`,
    );
  }
  lines.push("");
  if (s.buy_feature.available) {
    lines.push("## Buy feature");
    for (const opt of s.buy_feature.options) {
      lines.push(
        `- ${opt.label}${opt.price_multiplier ? ` (${opt.price_multiplier})` : ""}${
          opt.price_absolute ? ` — ${opt.price_absolute}` : ""
        }`,
      );
    }
    lines.push("");
  }
  if (s.special_bets.available) {
    lines.push("## Special bets");
    for (const v of s.special_bets.variants) {
      lines.push(
        `- ${v.label}${v.state ? ` (${v.state})` : ""}${v.price ? ` — ${v.price}` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push("## Rules summary (from canvas)");
  if (s.rules_summary.paylines_or_ways) {
    lines.push(`- Paylines / ways: ${s.rules_summary.paylines_or_ways}`);
  }
  if (s.rules_summary.max_win) {
    lines.push(`- Max win: ${s.rules_summary.max_win}`);
  }
  if (s.rules_summary.feature_mentions.length > 0) {
    lines.push("- Feature mentions:");
    for (const f of s.rules_summary.feature_mentions) lines.push(`  - ${f}`);
  }
  if (s.rules_summary.visible_symbols.length > 0) {
    lines.push(`- Visible symbols: ${s.rules_summary.visible_symbols.join(", ")}`);
  }
  lines.push("");
  lines.push("## Vision observations");
  lines.push("```");
  lines.push(s.raw_observations);
  lines.push("```");
  return lines.join("\n") + "\n";
}

function synthOptionsFromSnapshot(slug: string, s: PlayScreenSnapshot): unknown {
  type Option = {
    name: string;
    category: string;
    type: string;
    current_value: unknown;
    possible_values: unknown;
    description: string | null;
    location_hint: string | null;
  };
  const options: Option[] = [];

  if (s.bet.current != null || s.bet.chips) {
    options.push({
      name: "Bet Size",
      category: "control",
      type:
        s.bet.step_kind === "chips"
          ? "selector"
          : s.bet.step_kind === "plus_minus"
            ? "button"
            : "selector",
      current_value: s.bet.current,
      possible_values: s.bet.chips,
      description:
        s.bet.min && s.bet.max ? `range ${s.bet.min}..${s.bet.max}` : null,
      location_hint: "bet control on play screen",
    });
  }

  if (s.buy_feature.available) {
    for (const opt of s.buy_feature.options) {
      options.push({
        name: `Buy Feature — ${opt.label}`,
        category: "game",
        type: "button",
        current_value: opt.price_multiplier ?? opt.price_absolute ?? null,
        possible_values: null,
        description: opt.price_multiplier && opt.price_absolute
          ? `${opt.price_multiplier} (${opt.price_absolute})`
          : null,
        location_hint: "buy feature panel",
      });
    }
  }

  if (s.special_bets.available) {
    for (const v of s.special_bets.variants) {
      options.push({
        name: `Special Bet — ${v.label}`,
        category: "control",
        type: "toggle",
        current_value: v.state,
        possible_values: null,
        description: v.price ?? null,
        location_hint: "special bets area",
      });
    }
  }

  for (const c of s.controls) {
    if (c.kind === "button" || c.kind === "toggle") {
      options.push({
        name: c.name,
        category: c.name.toLowerCase().includes("auto") || c.name.toLowerCase().includes("turbo")
          ? "control"
          : "ui",
        type: c.kind,
        current_value: c.state_hint,
        possible_values: null,
        description: null,
        location_hint: c.approx_location,
      });
    }
  }

  return {
    game: slug,
    provider: s.provider_guess,
    capturedAt: new Date().toISOString(),
    optionsCount: options.length,
    synthesized: true,
    source: "step4-extract-rules",
    options,
  };
}
