// AI: called only when state observer returns UNKNOWN (Phase 8.5 — opt-in
// recovery path, not per-spin). One AI call per unknown screen. Output
// validated against strict schema; suggested signature goes through Patch
// Validator (Phase 7.6) before persisting. Cost ~$0.02-0.05 per encounter.

import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { validate as validateSchema, type Schema } from "../registry/schemas/index.js";

export type LearnedSignature = {
  /** Canonical state name suggested (e.g. "BIG_WIN_POPUP", "CUSTOM_TUTORIAL"). */
  state: string;
  /** OCR keywords that identify this state — used in future runs by classify(). */
  ocrAny: string[];
  ocrAll?: string[];
  /** Recommended handler strategy — runner uses this hint to choose dismiss flow. */
  suggestedHandler: "dismiss_center" | "dismiss_close_button" | "wait_and_observe" | "manual";
  /** Optional region hash for non-OCR matching. */
  regionHash?: string;
};

export type LearnResult = {
  ok: boolean;
  confidence: number;
  signature?: LearnedSignature;
  reason: string;
  /** Token cost telemetry. */
  meta: { durationMs: number };
};

const LEARN_OUTPUT_SCHEMA: Schema = {
  type: "object",
  required: ["state", "confidence", "ocrAny", "suggestedHandler", "reason"],
  properties: {
    state: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" }, // SCREAMING_SNAKE
    confidence: { type: "number", min: 0, max: 1 },
    ocrAny: { type: "array", items: { type: "string" } },
    ocrAll: { type: "array", items: { type: "string" }, nullable: true },
    suggestedHandler: {
      type: "string",
      enum: ["dismiss_center", "dismiss_close_button", "wait_and_observe", "manual"],
    },
    regionHash: { type: "string", nullable: true },
    reason: { type: "string" },
  },
};

const SYSTEM_PROMPT = `You are a slot-game state classifier. The automation tool encountered a screen
it doesn't recognize. Your job: identify what kind of screen this is and
suggest signature keywords + dismiss strategy.

Rules:
1. Output JSON only.
2. \`state\` must be SCREAMING_SNAKE_CASE (e.g. "BIG_WIN_POPUP", "TUTORIAL_OVERLAY").
3. \`ocrAny\` = list of UNIQUE keywords that identify this screen (any-match).
   Use lowercase, 2-4 entries. Avoid generic words like "ok", "win", "spin".
4. \`suggestedHandler\`:
   - "dismiss_center": click center to dismiss (most popups)
   - "dismiss_close_button": needs a close button click (modal dialogs)
   - "wait_and_observe": game is animating, just wait
   - "manual": QA needs to look — engine can't auto-handle
5. \`confidence\` low (<0.7) if you're unsure — runner will mark NEEDS_REVIEW.
6. \`reason\` ≤ 2 sentences explaining what the screen shows.

Output JSON:
{
  "state": "<SCREAMING_SNAKE>",
  "confidence": <0..1>,
  "ocrAny": ["kw1", "kw2"],
  "ocrAll": ["..."],
  "suggestedHandler": "dismiss_center",
  "regionHash": null,
  "reason": "<short>"
}`;

/**
 * Classify an unknown screen using AI vision + OCR text. Returns a learned
 * signature that the engine can save (after patch validation) to recognize
 * the same screen in future runs.
 */
export async function learnUnknownState(
  page: Page,
  ocrText: string,
): Promise<LearnResult> {
  const start = Date.now();
  let screenshotBase64 = "";
  try {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    screenshotBase64 = buf.toString("base64");
  } catch (err) {
    return {
      ok: false,
      confidence: 0,
      reason: `screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  let raw: string;
  try {
    raw = await askClaude({
      label: `unknown-state-learn`,
      system: SYSTEM_PROMPT,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotBase64 } },
        { type: "text", text: `OCR text (use as hint, but visual takes precedence):\n\n${ocrText.slice(0, 1500)}\n\nReturn JSON classification.` },
      ],
      maxTurns: 1,
      timeoutMs: 60_000,
    });
  } catch (err) {
    return {
      ok: false,
      confidence: 0,
      reason: `AI call failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  const parsed = extractJsonFromText<Record<string, unknown>>(raw);
  if (!parsed) {
    return {
      ok: false,
      confidence: 0,
      reason: `AI returned non-JSON: ${raw.slice(0, 200)}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  const errors = validateSchema(parsed, LEARN_OUTPUT_SCHEMA);
  if (errors.length > 0) {
    return {
      ok: false,
      confidence: 0,
      reason: `AI output failed schema: ${errors.slice(0, 2).map((e) => `${e.path} ${e.message}`).join("; ")}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  return {
    ok: true,
    confidence: parsed.confidence as number,
    signature: {
      state: parsed.state as string,
      ocrAny: parsed.ocrAny as string[],
      ocrAll: parsed.ocrAll as string[] | undefined,
      suggestedHandler: parsed.suggestedHandler as LearnedSignature["suggestedHandler"],
      regionHash: parsed.regionHash as string | undefined,
    },
    reason: parsed.reason as string,
    meta: { durationMs: Date.now() - start },
  };
}
