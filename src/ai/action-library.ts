import type { TestCase, TestCaseCategory } from "./test-catalog.js";

function textOf(tc: TestCase): string {
  return `${tc.id} ${tc.name} ${tc.description}`.toLowerCase();
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function buyFeatureInstructions(tc: TestCase): string[] {
  const t = textOf(tc);
  if (hasAny(t, ["500x", "tier-2", "tier 2"])) {
    return [
      "click the Buy Feature button",
      "select the higher buy option (usually 500x or tier-2)",
      "click confirm in the buy dialog",
    ];
  }
  if (hasAny(t, ["100x", "tier-1", "tier 1"])) {
    return [
      "click the Buy Feature button",
      "select the default/lower buy option (usually 100x or tier-1)",
      "click confirm in the buy dialog",
    ];
  }
  return [
    "click the Buy Feature button",
    "select the intended buy option shown for this case",
    "click confirm in the buy dialog",
  ];
}

function specialBetInstructions(tc: TestCase): string[] {
  const t = textOf(tc);
  if (hasAny(t, ["ante", "double chance", "special bet"])) {
    return [
      "locate and click the special bet toggle (Ante/Double Chance/Special Bet)",
    ];
  }
  return [
    "toggle the special bet control once",
  ];
}

function optionsInstructions(tc: TestCase): string[] {
  const t = textOf(tc);
  if (hasAny(t, ["sound", "audio", "music"])) {
    return [
      "open options/settings panel",
      "toggle sound/audio once",
      "close options/settings panel",
    ];
  }
  return [
    "open options/settings panel",
    "toggle one stable option once",
    "close options/settings panel",
  ];
}

function historyInstructions(_tc: TestCase): string[] {
  return [
    "open history/rounds panel",
    "verify entries are visible, then close history/rounds panel",
  ];
}

function turboInstructions(_tc: TestCase): string[] {
  return [
    "open options/settings panel if needed and toggle Turbo/Quick Spin once",
  ];
}

export function getReplayOrVisionInstructions(tc: TestCase): string[] {
  switch (tc.category as TestCaseCategory) {
    case "buy_feature":
      return buyFeatureInstructions(tc);
    case "special_bet":
      return specialBetInstructions(tc);
    case "options":
      return optionsInstructions(tc);
    case "history":
      return historyInstructions(tc);
    case "turbo_spin":
      return turboInstructions(tc);
    default:
      return ["perform the case-specific UI action for this test"]; 
  }
}
