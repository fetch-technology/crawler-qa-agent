// Per-trigger sub-state hint loader. Defaults are the universal slot-game
// triggers (spinButton, betMinus, buyBonusButton, etc.). Per-game override
// file `sub-state-hints.json` can add new triggers or rename labels.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { SubStateHintsConfig, RegistryStore } from "./types.js";

export type SubStateHint = {
  stateLabel: string;
  description: string;
  /** Optional extra guidance appended to the popup-discovery AI prompt for
   *  THIS state. Use to pin a naming convention or list expected children so
   *  discovery is consistent (e.g. autoplay count presets → autoCountSlide-N). */
  discoverHint?: string;
  /** Discrete stops on a CONTINUOUS slider (e.g. autoplay count: 10,20,...,1000).
   *  After discovery, the marks are synthesized by interpolating evenly between
   *  two anchor elements the AI returns (the track's min/max ends). Produces
   *  `<keyPrefix>-<value>` pending entries with ESTIMATED coords — QA re-picks
   *  for precision. */
  sliderMarks?: {
    keyPrefix: string;     // e.g. "autoCountSlide"
    values: number[];      // e.g. [10,20,30,50,70,100,500,1000]
    minAnchor: string;     // AI key for the LEFT/min end (e.g. "autospinsSliderMin")
    maxAnchor: string;     // AI key for the RIGHT/max end (e.g. "autospinsSliderMax")
  };
};

export const SUB_STATE_HINTS_DEFAULTS: Record<string, SubStateHint> = {
  buyBonusButton: { stateLabel: "buy_feature_popup", description: "Buy Feature popup" },
  paytableButton: {
    stateLabel: "paytable",
    description: "Paytable / info screen",
    discoverHint:
      "This is the PAYTABLE / INFO popup, often MULTI-PAGE. If you see pagination arrows, emit the forward/next arrow as 'nextButton' (key MUST be exactly 'nextButton') and the back arrow as 'prevButton'. Emit the close X as 'closeButton'. The backend reuses the verified 'nextButton' coord to walk all paytable pages, so naming it exactly matters.",
  },
  menuButton: {
    stateLabel: "menu",
    description: "Main menu drawer",
    discoverHint:
      "This is the main MENU drawer. It usually links to sub-screens. If you see a GAME HISTORY / ROUNDS entry, emit it with key 'historyButton'. Other common entries: 'settingsButton', 'paytableButton', 'helpButton', 'soundButton'.",
  },
  historyButton: { stateLabel: "history_popup", description: "Game history popup" },
  settingsButton: { stateLabel: "settings", description: "Settings panel" },
  betPlus: { stateLabel: "bet_plus_state", description: "After clicking betPlus (bet multiplier popup or value change)" },
  betMinus: { stateLabel: "bet_minus_state", description: "After clicking betMinus" },
  spinButton: { stateLabel: "spin_in_progress", description: "Spin animation state (STOP button, etc.)" },
  autoButton: {
    stateLabel: "autoplay_popup",
    description: "Autoplay configuration popup",
    discoverHint:
      "This is the AUTOPLAY configuration popup. Emit these elements with EXACT keys:\n"
      + "- 'startAutoplayButton' — the large START AUTOPLAY button (may show the current count in parentheses).\n"
      + "- 'closeButton' — the X / close icon (usually top-right).\n"
      + "- Checkbox toggles, by their label: 'turboSpinToggle', 'quickSpinToggle', 'skipScreensToggle' (only the ones actually present).\n"
      + "NUMBER OF AUTOSPINS control — CRITICAL, you MUST emit BOTH of these two anchor elements regardless of UI type. The backend uses them to register every preset value automatically. Do NOT skip them. Do NOT emit only one. Do NOT emit autoCountSlide-<N> yourself:\n"
      + "  - 'autospinsSliderMin' — the LEFTMOST element of the autospins control:\n"
      + "      • CONTINUOUS slider (a horizontal track with a draggable handle): the far-LEFT end of the track (lowest value position).\n"
      + "      • DISCRETE preset chips (a row of separate clickable numbers like 10 20 30 50 100): the CENTER of the LEFTMOST visible chip (the one showing the smallest number).\n"
      + "  - 'autospinsSliderMax' — the RIGHTMOST element of the autospins control:\n"
      + "      • CONTINUOUS slider: the far-RIGHT end of the track (highest value position).\n"
      + "      • DISCRETE preset chips: the CENTER of the RIGHTMOST visible chip (the one showing the largest number).\n"
      + "If you can only see ONE end, still emit it AND estimate the other end at the opposite side of the visible control area — never skip an anchor.",
    sliderMarks: {
      keyPrefix: "autoCountSlide",
      values: [10, 20, 30, 50, 70, 100, 500, 1000],
      minAnchor: "autospinsSliderMin",
      maxAnchor: "autospinsSliderMax",
    },
  },
  turboButton: { stateLabel: "turbo_state", description: "Turbo toggled" },
};

/** Interpolate discrete slider stops EVENLY between two track-end anchors.
 *  Returns one {value, x, y} per configured value (mark[0] at min end,
 *  mark[last] at max end). Pure — exercised by invariant tests. */
export function interpolateSliderStops(
  min: { x: number; y: number },
  max: { x: number; y: number },
  values: number[],
): Array<{ value: number; x: number; y: number }> {
  const n = values.length;
  return values.map((value, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    return {
      value,
      x: Math.round(min.x + t * (max.x - min.x)),
      y: Math.round(min.y + t * (max.y - min.y)),
    };
  });
}

export const subStateHintsStore: RegistryStore<SubStateHintsConfig> = {
  load: (slug) => loadJson<SubStateHintsConfig>(slug, "subStateHints"),
  save: (slug, data) => saveJson(slug, "subStateHints", data),
  exists: (slug) => fileExists(slug, "subStateHints"),
};

/**
 * Resolve sub-state hints: defaults merged with per-game overrides. Override
 * map keys override default entries; missing keys keep defaults.
 */
export async function resolveSubStateHints(slug: string | null): Promise<Record<string, SubStateHint>> {
  if (!slug) return { ...SUB_STATE_HINTS_DEFAULTS };
  const override = await subStateHintsStore.load(slug);
  if (!override?.hints) return { ...SUB_STATE_HINTS_DEFAULTS };
  return { ...SUB_STATE_HINTS_DEFAULTS, ...override.hints };
}
