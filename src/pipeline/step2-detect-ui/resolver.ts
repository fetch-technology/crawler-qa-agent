import type { Page } from "playwright";
import type { UiElement, UiRegistry } from "../registry/types.js";
import type { UiDiscoverResult } from "./types.js";
import { tryDom } from "./dom-strategy.js";
import { tryOcr } from "./ocr-strategy.js";
import { tryTemplate } from "./template-strategy.js";
import { tryAiVision } from "./ai-vision-strategy.js";
import { getAiBatchResult } from "./ai-vision-batch.js";
import { resolveExpectedUiElements } from "../registry/expected-ui-elements.js";

export async function discoverUi(
  page: Page,
  opts: { slug?: string | null } = {},
): Promise<UiDiscoverResult> {
  // P4 — element targets + visual descriptions come from per-game config
  // (defaults to the universal slot buttons). QA can add game-specific
  // elements via expected-ui-elements.json.
  const expected = await resolveExpectedUiElements(opts.slug ?? null);

  // Pre-warm the AI batch with the resolved element list so the per-kind
  // resolveOne() lookups below reuse the same cached response (and so the
  // single AI call sees the full custom list + descriptions).
  const batch = await getAiBatchResult(page, expected);

  const uiMap: UiRegistry = {};
  for (const target of expected) {
    const el = await resolveOne(page, target.key);
    if (el) uiMap[target.key] = el;
  }

  // P3 — auto-add open-ended suggestions (game-specific buttons the AI saw
  // beyond the expected list) into the registry as PENDING entries. QA still
  // verifies them in the tree (Click → Confirm) and can rename/remove.
  const autoAdded = mergeSuggestions(uiMap, batch?.suggestions ?? []);

  return {
    uiMap,
    screenshotPath: "",
    autoAdded,
  };
}

const SUGGESTION_OVERLAP_PX = 30;

/** Merge AI suggestions into uiMap as pending entries. Guards:
 *  - skip if the (sanitized) label collides with an existing key (expected wins)
 *  - skip if the coord overlaps an already-placed element (AI double-report)
 *  Returns the entries actually added (for dashboard awareness). */
function mergeSuggestions(
  uiMap: UiRegistry,
  suggestions: Array<{ label: string; x: number; y: number; confidence: number; note?: string }>,
): Array<{ key: string; x: number; y: number; confidence: number; note?: string }> {
  const added: Array<{ key: string; x: number; y: number; confidence: number; note?: string }> = [];
  for (const s of suggestions) {
    const key = sanitizeKey(s.label);
    if (!key) continue;
    if (uiMap[key]) continue; // don't overwrite expected / already-added
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const overlaps = Object.values(uiMap).some(
      (el) => el && Math.abs(el.x - x) < SUGGESTION_OVERLAP_PX && Math.abs(el.y - y) < SUGGESTION_OVERLAP_PX,
    );
    if (overlaps) continue;
    uiMap[key] = {
      x,
      y,
      strategy: "ai_vision",
      confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
      status: "pending",
      detectedAt: new Date().toISOString(),
    };
    added.push({ key, x, y, confidence: s.confidence ?? 0.5, note: s.note });
  }
  return added;
}

function sanitizeKey(label: string): string | null {
  const k = String(label ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return k.length > 0 ? k : null;
}

async function resolveOne(page: Page, kind: string): Promise<UiElement | null> {
  for (const strat of [tryDom, tryOcr, tryTemplate, tryAiVision]) {
    const r = await strat(page, kind);
    if (r.found && r.element) return r.element;
  }
  return null;
}
