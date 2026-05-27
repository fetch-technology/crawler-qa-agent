// AI: called only during cold-start. Single batched call per discovery —
// detects multiple UI elements from one screenshot. Result cached per Page session
// so subsequent tryAiVision() lookups reuse the same response.
//
// 2026-05-27 discovery-recall improvements:
//   P1 — keep low-confidence detections (status decided by QA) instead of
//        silently dropping <0.7 or verify-failures.
//   P2 — wait-for-stable + dismiss popups before the screenshot (avoid
//        capturing a loading/animation/popup frame).
//   P3 — open-ended pass: AI also reports OTHER clickable buttons it sees
//        beyond the expected list, returned as `suggestions` for QA review.
//   P4 — expected element list + descriptions are passed in (per-game
//        configurable) instead of hardcoded.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import type { UiElement } from "../registry/types.js";
import {
  EXPECTED_UI_ELEMENTS_DEFAULTS,
  type ExpectedUiElement,
} from "../registry/expected-ui-elements.js";
import { verifyElement } from "./ai-vision-verify.js";
import { waitUntilStable } from "../utils/pixel-diff/index.js";
import { dismissPopupsLoop } from "../utils/ocr-popup.js";

export type ElementMap = Record<string, { x: number; y: number; confidence: number }>;

/** Open-ended discovery suggestion — a clickable button the AI saw that is
 *  NOT in the expected list. QA reviews + names + confirms these. */
export type DiscoverySuggestion = {
  label: string;
  x: number;
  y: number;
  confidence: number;
  note?: string;
};

export type AiBatchResult = {
  /** Expected-list elements (kept even when low-confidence; status set by QA). */
  elements: ElementMap;
  /** Game-specific / extra clickable buttons the AI noticed (P3). */
  suggestions: DiscoverySuggestion[];
};

const CACHE = new WeakMap<Page, Promise<AiBatchResult | null>>();

/** Below this the element is still kept, but flagged low-confidence (pending). */
const LOW_CONFIDENCE = 0.7;

function buildSystem(elements: ExpectedUiElement[]): string {
  const descriptions = elements
    .map((e) => `- ${e.key}: ${e.description}`)
    .join("\n");
  return `You are a slot-game UI locator. Look at the screenshot of a slot game and return the pixel coordinates of CLICKABLE BUTTONS (icons), NOT text labels.

CRITICAL — common mistakes to avoid:
- DO NOT pick "PLACE YOUR BETS!" or any text caption — that is a label, not a button.
- DO NOT pick numeric values like "$40.00", "CREDIT", "BET" labels.
- DO NOT pick decorative panels (BUY FEATURE 3 OPTIONS is a banner; only target it if you can clearly see a clickable button graphic on top).
- Pick the CENTER PIXEL of the clickable icon, not the surrounding label.

Visual descriptions for each EXPECTED element (slot game conventions):
${descriptions}

Confidence guidance (REPORT, do not omit):
- 0.9+ if you can identify a clear icon matching the description
- 0.7-0.9 if you see a button but uncertain about exact center
- 0.3-0.7 if you see something plausible but ambiguous — STILL INCLUDE IT with the low confidence so a human can verify. Do NOT omit.
- Only omit an element entirely if you genuinely see NOTHING resembling it.

OPEN-ENDED PASS (important):
- Besides the expected elements above, slot games often have GAME-SPECIFIC buttons
  (e.g. ANTE BET, DOUBLE CHANCE, BET-amount presets, FREE-SPINS count presets,
  GAMBLE, COLLECT, sound/settings toggles, close/X buttons).
- Report every OTHER clearly-clickable button you see in a "suggestions" array,
  giving each a short snake_case label you invent (e.g. "ante_bet", "double_chance").

Return STRICT JSON in this shape:
{
  "elements": {
    "spinButton": { "x": 1660, "y": 870, "confidence": 0.95 },
    "autoButton": { "x": 1500, "y": 870, "confidence": 0.55 }
  },
  "suggestions": [
    { "label": "ante_bet", "x": 120, "y": 540, "confidence": 0.8, "note": "ANTE BET toggle left of reels" }
  ]
}

Rules:
- Coordinates are CSS pixels relative to the screenshot top-left.
- confidence is 0..1. Include low-confidence expected elements (>= 0.3) — do not drop them.
- "suggestions" may be an empty array if you see no extra buttons.
- No prose, no markdown, no commentary. JSON only.`;
}

type RawResponse = {
  elements?: ElementMap;
  suggestions?: DiscoverySuggestion[];
};

async function discoverViaAi(
  page: Page,
  elements: ExpectedUiElement[],
): Promise<AiBatchResult | null> {
  // P2 — settle the screen before capture so we don't snapshot a loading /
  // animation / interstitial-popup frame (a major cause of missed elements).
  // Dismiss any "PRESS ANYWHERE" interstitial first, then wait for pixels to
  // stabilize. Both are best-effort (non-fatal).
  try {
    await dismissPopupsLoop(page);
  } catch (err) {
    console.warn(`[step2/ai-vision-batch] pre-shot dismiss failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await waitUntilStable(page, { maxIterations: 12, changeThreshold: 0.005, consecutiveStable: 3 });
  } catch (err) {
    console.warn(`[step2/ai-vision-batch] pre-shot wait-stable failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    await page.waitForTimeout(500);
  }

  const buf = await page.screenshot({ type: "png", fullPage: false });
  const screenshotB64 = buf.toString("base64");
  const viewport = page.viewportSize();

  // Persist the screenshot so the human can verify what the AI was looking at.
  const debugDir = path.join("fixtures", "debug", "ai-vision");
  await mkdir(debugDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(debugDir, `${ts}.png`);
  await writeFile(screenshotPath, buf);
  console.log(`[step2/ai-vision-batch] screenshot saved: ${screenshotPath}`);

  const elementKeys = elements.map((e) => e.key);
  const text = await askClaude({
    label: "step2/ai-vision-batch",
    system: buildSystem(elements),
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshotB64 },
      },
      {
        type: "text",
        text: `Viewport size: ${viewport?.width ?? "?"}×${viewport?.height ?? "?"} pixels. The screenshot you see is at that exact size — coordinates you return MUST be within those bounds.

Find these EXPECTED UI elements if present: ${elementKeys.join(", ")}.
Then list any OTHER clickable buttons in "suggestions".

Checklist before responding:
1. For each expected element, include it even at low confidence (>= 0.3). Only omit if you truly see nothing.
2. Is each (x,y) pointing at the CENTER of the BUTTON (not a nearby label)?
3. Are coordinates within 0..${viewport?.width ?? 1280} × 0..${viewport?.height ?? 720}?
4. Did you scan the WHOLE screen for game-specific buttons to put in "suggestions"?

Return JSON only.`,
      },
    ],
    maxTurns: 1,
    timeoutMs: 60_000,
  });

  const raw = extractJsonFromText<RawResponse>(text);
  await writeFile(path.join(debugDir, `${ts}.response.json`), JSON.stringify({ text, parsed: raw }, null, 2));
  if (!raw) return null;

  // Back-compat: older prompt shape returned the element map at top level.
  const initial: ElementMap = raw.elements ?? (raw as unknown as ElementMap);
  const suggestions: DiscoverySuggestion[] = Array.isArray(raw.suggestions)
    ? raw.suggestions.filter((s) => s && typeof s.x === "number" && typeof s.y === "number" && typeof s.label === "string")
    : [];

  const criticalKeys = new Set(elements.filter((e) => e.critical).map((e) => e.key));

  // Verify each detected element by cropping + asking AI strict check.
  // P1 change: NEVER silently drop. Verify failures are KEPT as low-confidence
  // pending entries (human-in-the-loop QA reviews them). Gated via
  // QA_UI_VERIFY_LOOP=0 to skip the verify pass entirely for fast lanes.
  if (process.env.QA_UI_VERIFY_LOOP === "0") {
    console.log("[step2/verify] skipped (QA_UI_VERIFY_LOOP=0)");
    return { elements: initial, suggestions };
  }

  console.log(`[step2/verify] verifying ${Object.keys(initial).length} elements (keep-on-fail)...`);
  const kept: ElementMap = {};
  const traces: Array<{ key: string; verified: boolean; rounds: number; trace: unknown[] }> = [];
  for (const [key, coord] of Object.entries(initial)) {
    const result = await verifyElement(page, key, coord, buf, debugDir);
    traces.push({ key, verified: result.verified, rounds: result.rounds, trace: result.trace });
    if (result.verified && result.finalCoord) {
      kept[key] = result.finalCoord;
      console.log(`[step2/verify] ${key} ${result.rounds > 1 ? `REFINED (${result.rounds} rounds)` : "confirmed"} @ (${result.finalCoord.x},${result.finalCoord.y})`);
    } else {
      // P1 — keep with reduced confidence instead of dropping. Critical
      // elements floor at 0.5; others at the original (or 0.3) so QA still
      // sees + can confirm/reject/recover them.
      const floor = criticalKeys.has(key) ? 0.5 : Math.min(coord.confidence ?? 0.4, LOW_CONFIDENCE - 0.1);
      kept[key] = { x: coord.x, y: coord.y, confidence: floor };
      console.log(`[step2/verify] ${key} UNVERIFIED — kept as low-confidence (${floor.toFixed(2)}) for QA review`);
    }
  }
  await writeFile(
    path.join(debugDir, `${ts}.verify-trace.json`),
    JSON.stringify({ initial, kept, suggestions, traces }, null, 2),
  );
  return { elements: kept, suggestions };
}

export async function getAiBatchResult(
  page: Page,
  elements: ExpectedUiElement[] = EXPECTED_UI_ELEMENTS_DEFAULTS,
): Promise<AiBatchResult | null> {
  let pending = CACHE.get(page);
  if (!pending) {
    pending = discoverViaAi(page, elements).catch((err) => {
      console.warn(`[step2/ai-vision-batch] failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    CACHE.set(page, pending);
  }
  return pending;
}

export function toUiElement(coord: { x: number; y: number; confidence: number }): UiElement {
  const confidence = coord.confidence ?? 0.8;
  return {
    x: Math.round(coord.x),
    y: Math.round(coord.y),
    strategy: "ai_vision",
    confidence,
    // P1 — low-confidence detections default to pending so QA reviews them;
    // higher-confidence ones also start pending (manual-verify confirms all).
    status: "pending",
    detectedAt: new Date().toISOString(),
  };
}
