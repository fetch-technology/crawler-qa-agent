// AI: called only during recovery when validate-ui-registry fails — NEVER per-spin.
// Single Claude call per recovery attempt; caps prevent infinite loops (see orchestrator/recovery.ts).

import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { ELEMENT_VISUAL_CHECK } from "./ai-vision-verify.js";
import type { UiElement } from "../registry/types.js";

const SYSTEM = `You are a slot-game UI locator. Given a screenshot and a description of ONE element, return its pixel coordinates.

Return STRICT JSON:
{ "x": number, "y": number, "confidence": number }

If you cannot find the element, return:
{ "x": null, "y": null, "confidence": 0 }

Rules:
- Coordinates are CSS pixels from the TOP-LEFT of the screenshot.
- Pick the CENTER of the clickable icon, NOT a nearby label.
- If a popup/overlay is visible, prefer that popup's elements over background ones (when caller asks for popup element).

No prose. JSON only.`;

export type RecoverOptions = {
  /** Rich visual description of the element. Overrides default lookup. */
  description?: string;
  /** Extra context for the AI (e.g. "A buy-feature popup is currently open."). */
  contextHint?: string;
};

export async function aiRecoverLocator(
  page: Page,
  elementKind: string,
  opts: RecoverOptions = {},
): Promise<UiElement | null> {
  const buf = await page.screenshot({ type: "png", fullPage: false });

  // Build a richer prompt:
  // 1. Strip namespace prefix if elementKind is "<state>__<key>" — AI only sees the bare key
  // 2. Use ELEMENT_VISUAL_CHECK lookup for known keys
  // 3. Inject contextHint (e.g. popup state) if provided
  const bareKey = elementKind.includes("__")
    ? elementKind.split("__").slice(1).join("__")
    : elementKind;
  const description = opts.description ?? ELEMENT_VISUAL_CHECK[bareKey] ?? `Find the "${bareKey}" button (semantic key naming).`;
  const context = opts.contextHint ?? "";

  const userText = `Element to locate: ${bareKey}

Visual description:
${description}

${context ? `Context: ${context}` : ""}

Return JSON only.`;

  const text = await askClaude({
    label: `step2/ai-recover/${bareKey}`,
    system: SYSTEM,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
      },
      { type: "text", text: userText },
    ],
    maxTurns: 1,
    timeoutMs: 60_000,
  }).catch((err) => {
    console.warn(`[step2/ai-recover] ${bareKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });

  if (!text) return null;
  const parsed = extractJsonFromText<{ x: number | null; y: number | null; confidence: number }>(text);
  if (!parsed || parsed.x == null || parsed.y == null) return null;
  return {
    x: Math.round(parsed.x),
    y: Math.round(parsed.y),
    strategy: "ai_recover",
    confidence: parsed.confidence ?? 0.8,
    detectedAt: new Date().toISOString(),
  };
}
