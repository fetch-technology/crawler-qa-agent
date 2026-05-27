// Auxiliary inputs for the AI catalog generator. Auto-detects optional rich
// sources from filesystem so catalog can synthesize bet_boundary / special_bet /
// max_win_cap / turbo_spin / ui_consistency cases when info is available.
//
// Sources, in priority order:
//   1. fixtures/registry/<slug>/options.json         (new pipeline native —
//      written by step4 extract-rules.ts when cold-start runs)
//   2. fixtures/options/<slug>__<ts>/options.json    (legacy extractor output)
//   3. fixtures/options/<slug>__<ts>/api-snapshot.json  (legacy — has config response)
//   4. fixtures/options/<slug>__<ts>/paytable.json   (legacy)
//
// Also builds a SYNTHESIZED minimal options.json from new-pipeline registry
// when no legacy artifact exists.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { ProviderCache, UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";

export type AuxSources = {
  optionsJson: string | null;
  paytableMarkdown: string | null;
  configResponse: unknown | null;
  source: string;
};

export function loadAuxiliarySources(input: {
  gameSlug: string;
  provider: ProviderCache | null;
  uiMap: UiRegistry | null;
  features: FeatureRegistry | null;
  observedBets: number[];
}): AuxSources {
  // 1. Native registry options (written by step4 extract-rules at cold-start)
  const nativeOptions = join(dirForGame(input.gameSlug), "options.json");
  if (existsSync(nativeOptions)) {
    return {
      optionsJson: readFileSync(nativeOptions, "utf8"),
      paytableMarkdown: tryReadPaytableMd(input.gameSlug),
      configResponse: tryReadConfigResponse(input.gameSlug),
      source: "registry-native",
    };
  }

  // 2. Legacy fixtures/options/<slug>__<ts>/
  const legacyDir = findLatestLegacyOptionsDir(input.gameSlug);
  if (legacyDir) {
    const optionsPath = join(legacyDir, "options.json");
    const apiSnapPath = join(legacyDir, "api-snapshot.json");
    const paytablePath = join(legacyDir, "paytable.json");
    return {
      optionsJson: existsSync(optionsPath) ? readFileSync(optionsPath, "utf8") : null,
      configResponse: existsSync(apiSnapPath)
        ? safeParseJson(readFileSync(apiSnapPath, "utf8"))
        : null,
      paytableMarkdown: existsSync(paytablePath)
        ? paytableJsonToMarkdown(readFileSync(paytablePath, "utf8"))
        : null,
      source: `legacy:${legacyDir}`,
    };
  }

  // 3. Synthesize from new-pipeline registry alone
  const synthetic = synthesizeOptionsFromRegistry(input);
  return {
    optionsJson: synthetic,
    paytableMarkdown: null,
    configResponse: null,
    source: "synthesized-from-registry",
  };
}

function findLatestLegacyOptionsDir(slug: string): string | null {
  const root = "fixtures/options";
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root)
    .filter((n) => n.startsWith(slug + "__"))
    .map((n) => ({ name: n, full: join(root, n) }))
    .filter((d) => statSync(d.full).isDirectory())
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return candidates[0]?.full ?? null;
}

function tryReadPaytableMd(slug: string): string | null {
  const path = join(dirForGame(slug), "paytable.md");
  if (existsSync(path)) return readFileSync(path, "utf8");
  return null;
}

function tryReadConfigResponse(slug: string): unknown | null {
  const path = join(dirForGame(slug), "config-response.json");
  if (existsSync(path)) return safeParseJson(readFileSync(path, "utf8"));
  return null;
}

function safeParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function paytableJsonToMarkdown(raw: string): string | null {
  const parsed = safeParseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  // Best-effort flatten — legacy paytable.json shape varies.
  const lines: string[] = ["# Paytable (extracted)"];
  lines.push("```json", JSON.stringify(parsed, null, 2).slice(0, 4000), "```");
  return lines.join("\n");
}

function synthesizeOptionsFromRegistry(input: {
  gameSlug: string;
  provider: ProviderCache | null;
  uiMap: UiRegistry | null;
  features: FeatureRegistry | null;
  observedBets: number[];
}): string {
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

  if (input.observedBets.length > 0) {
    const min = Math.min(...input.observedBets);
    const max = Math.max(...input.observedBets);
    options.push({
      name: "Bet Size",
      category: "control",
      type: "selector",
      current_value: input.observedBets[0]!,
      possible_values: input.observedBets,
      description: `observed range ${min}..${max}`,
      location_hint: "bet control on play screen",
    });
  }

  if (input.uiMap?.buyBonusButton && input.features?.features["buyBonus"]?.present) {
    options.push({
      name: "Buy Feature",
      category: "game",
      type: "button",
      current_value: null,
      possible_values: null,
      description: "buy bonus available",
      location_hint: "buy feature area",
    });
  }
  if (input.uiMap?.autoButton) {
    options.push({
      name: "Autoplay",
      category: "control",
      type: "button",
      current_value: null,
      possible_values: null,
      description: null,
      location_hint: "below spin button",
    });
  }
  if (input.uiMap?.turboButton || input.features?.features["turbo"]?.present) {
    options.push({
      name: "Turbo",
      category: "control",
      type: "toggle",
      current_value: null,
      possible_values: null,
      description: "fast spin toggle",
      location_hint: "play controls",
    });
  }
  if (input.features?.features["gamble"]?.present) {
    options.push({
      name: "Gamble / Double",
      category: "game",
      type: "button",
      current_value: null,
      possible_values: null,
      description: null,
      location_hint: "after win",
    });
  }
  if (input.uiMap?.historyButton || input.features?.features["history"]?.present) {
    options.push({
      name: "History",
      category: "ui",
      type: "button",
      current_value: null,
      possible_values: null,
      description: null,
      location_hint: "menu area",
    });
  }
  if (input.uiMap?.paytableButton || input.features?.features["paytable"]?.present) {
    options.push({
      name: "Paytable / Rules",
      category: "ui",
      type: "button",
      current_value: null,
      possible_values: null,
      description: null,
      location_hint: "menu area",
    });
  }

  return JSON.stringify(
    {
      game: input.gameSlug,
      provider: input.provider?.provider ?? "Unknown",
      capturedAt: new Date().toISOString(),
      optionsCount: options.length,
      synthesized: true,
      options,
    },
    null,
    2,
  );
}
