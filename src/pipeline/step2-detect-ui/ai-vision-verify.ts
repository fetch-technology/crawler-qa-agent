// AI: called only during cold-start | recovery
//
// Verifies each UI element detected by the initial batch by cropping a tight
// region around the claimed coordinate and asking AI to confirm. AI either:
//   - CONFIRM (icon matches expected visual description)
//   - REJECT (icon doesn't match — also returns "not_present" or a corrected coord)
//
// Verification loop runs up to N attempts per element; failed elements are
// dropped from the final registry. Adds ~$0.02-0.05 per element verified but
// catches AI vision mistakes (e.g. labeling "+" as spinButton).

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";

export type ElementCoord = { x: number; y: number; confidence: number };
export type ElementMap = Record<string, ElementCoord>;

const VERIFY_CROP_SIZE = 160; // px; large enough to see icon + nearby context
const MAX_REFINE_ROUNDS = 2;

// Critical elements: pipeline breaks without these. If verify drops them, fall
// back to the initial detection with reduced confidence + caveat flag — better
// to test with a possibly-imperfect coord than to fail the whole run.
const CRITICAL_ELEMENTS = new Set(["spinButton", "buyBonusButton"]);

// Strict visual descriptions per element. Used by verifier to compare crop
// against expected appearance. Mirror of ELEMENT_DESCRIPTIONS in batch but
// phrased as questions. Exported so AI recover can reuse for richer prompts.
export const ELEMENT_VISUAL_CHECK: Record<string, string> = {
  spinButton:
    "Is the visual icon at the center a SPIN button? Accept ANY of these forms because the button changes state during gameplay: (a) circular arrow ⟳/↻, (b) STOP / square ◼ icon (when spin in progress), (c) BUY button when free spins active, (d) any LARGE ROUND BUTTON positioned as the primary action between the bet -/+ controls. Reject only if center clearly shows a + sign, − sign, text label, or empty background.",
  autoButton:
    "Is the visual at the center an AUTOPLAY label/button (text 'AUTO' or 'AUTOPLAY' or a small AP icon)? It is typically BELOW the spin button.",
  turboButton:
    "Is the visual at the center a TURBO icon — a lightning bolt ⚡ or 'TURBO' label?",
  buyBonusButton:
    "Is the visual at the center a BUY FEATURE / BUY BONUS panel — typically a rectangular RED/ORANGE button labeled 'BUY FEATURE' or 'BUY BONUS'?",
  historyButton:
    "Is the visual at the center a HISTORY icon — a clock 🕐 or list 📋?",
  paytableButton:
    "Is the visual at the center a paytable INFO icon — a circled lowercase 'i' (italic 'i' inside circle) OR a '?' help symbol? MUST contain an 'i' or '?' character. Reject if it's three horizontal lines (☰) — that is the menu button, NOT this.",
  menuButton:
    "Is the visual at the center a hamburger MENU icon — ☰ THREE HORIZONTAL parallel lines, typically of equal length? Reject if it's a circled 'i' (info icon) or any other shape. The icon must clearly show 3 stacked horizontal bars.",
  betPlus:
    "Is the visual at the center a '+' icon button used to INCREASE bet amount, typically next to the bet value display? It must be a clear '+' symbol, not a circular arrow.",
  betMinus:
    "Is the visual at the center a '−' icon button used to DECREASE bet amount, typically next to the bet value display? It must be a clear '−' (minus dash) symbol, not a circular arrow.",
};

const VERIFY_SYSTEM = `You are a strict UI element verifier for slot games. Given a tight crop screenshot centered at a candidate coordinate, you must STRICTLY confirm whether the visual at the center matches the expected element type.

Return JSON in this shape:
{
  "verdict": "confirmed" | "wrong_icon" | "not_present",
  "what_is_actually_there": "<short description of the icon you actually see at the center>",
  "confidence": 0.0-1.0
}

Rules:
- "confirmed": ONLY if the icon at the center of the crop clearly matches the expected description. Be strict — partial matches do NOT count.
- "wrong_icon": there is a CLICKABLE BUTTON at the center but it's a different icon than expected.
- "not_present": the center of the crop shows no clickable icon (e.g. plain texture, text label, empty area, decorative panel).
- Describe what's actually at the center in "what_is_actually_there" so the caller can re-locate if needed.
- No prose outside JSON.`;

const RELOCATE_SYSTEM = `You are a slot-game UI locator helping CORRECT a previous wrong detection. The original AI claimed it found "<elementKey>" at (x, y) but verification showed the crop actually contains "<what_was_actually_there>".

Given the FULL screenshot, locate the CORRECT position of <elementKey> (matching the visual description) or report that it doesn't exist in this view.

Return JSON:
{
  "found": true | false,
  "x": <int or null>,
  "y": <int or null>,
  "confidence": 0.0-1.0,
  "reason_if_not_found": "<short>"
}

Be strict about the visual description. Coordinates must be within the screenshot bounds.`;

export type VerificationResult = {
  key: string;
  verified: boolean;
  finalCoord: ElementCoord | null;
  rounds: number;
  trace: Array<{ round: number; coord: { x: number; y: number }; verdict: string; what: string }>;
};

export async function verifyElement(
  page: Page,
  key: string,
  initial: ElementCoord,
  fullScreenshot: Buffer,
  debugDir: string,
): Promise<VerificationResult> {
  const description = ELEMENT_VISUAL_CHECK[key];
  if (!description) {
    // No specific check rule → trust initial detection
    return { key, verified: true, finalCoord: initial, rounds: 0, trace: [] };
  }

  let coord = initial;
  const trace: VerificationResult["trace"] = [];

  for (let round = 1; round <= MAX_REFINE_ROUNDS + 1; round++) {
    // Capture a tight crop around the candidate coord.
    const cropBuf = await captureCrop(page, coord.x, coord.y, VERIFY_CROP_SIZE);
    const verdict = await askVerify(key, description, cropBuf);
    trace.push({ round, coord: { x: coord.x, y: coord.y }, verdict: verdict.verdict, what: verdict.what_is_actually_there });

    // ALWAYS persist crop with verdict in filename so human can inspect WHY
    // verification failed (instead of only confirmed ones).
    const cropTag = `${key}-r${round}-${verdict.verdict}.png`;
    await writeFile(path.join(debugDir, cropTag), cropBuf).catch(() => undefined);

    if (verdict.verdict === "confirmed") {
      return { key, verified: true, finalCoord: { ...coord, confidence: verdict.confidence }, rounds: round, trace };
    }

    // Failed: try to re-locate (unless we're out of rounds).
    if (round > MAX_REFINE_ROUNDS) break;

    const relocated = await askRelocate(key, description, verdict.what_is_actually_there, fullScreenshot);
    if (!relocated.found || relocated.x === null || relocated.y === null) {
      // AI says element doesn't exist. For critical elements, fall back to
      // initial coord with reduced confidence — better imperfect than missing.
      if (CRITICAL_ELEMENTS.has(key)) {
        console.warn(`[verify] ${key} verifier said "not present" but element is CRITICAL — falling back to initial coord (${initial.x},${initial.y}) with confidence 0.5`);
        return { key, verified: true, finalCoord: { ...initial, confidence: 0.5 }, rounds: round, trace };
      }
      return { key, verified: false, finalCoord: null, rounds: round, trace };
    }
    coord = { x: relocated.x, y: relocated.y, confidence: relocated.confidence };
  }

  // Exhausted rounds without confirmation.
  if (CRITICAL_ELEMENTS.has(key)) {
    console.warn(`[verify] ${key} could not be confirmed after ${MAX_REFINE_ROUNDS + 1} rounds — CRITICAL fallback to initial coord (${initial.x},${initial.y}) with confidence 0.5`);
    return { key, verified: true, finalCoord: { ...initial, confidence: 0.5 }, rounds: MAX_REFINE_ROUNDS + 1, trace };
  }
  return { key, verified: false, finalCoord: null, rounds: MAX_REFINE_ROUNDS + 1, trace };
}

async function captureCrop(page: Page, cx: number, cy: number, size: number): Promise<Buffer> {
  const half = Math.floor(size / 2);
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const x = Math.max(0, Math.min(cx - half, vp.width - size));
  const y = Math.max(0, Math.min(cy - half, vp.height - size));
  return page.screenshot({ type: "png", clip: { x, y, width: size, height: size } });
}

type VerifyResponse = {
  verdict: "confirmed" | "wrong_icon" | "not_present";
  what_is_actually_there: string;
  confidence: number;
};

async function askVerify(key: string, description: string, cropBuf: Buffer): Promise<VerifyResponse> {
  const text = await askClaude({
    label: `verify/${key}`,
    system: VERIFY_SYSTEM,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: cropBuf.toString("base64") },
      },
      {
        type: "text",
        text: `Element being verified: ${key}\n\nDescription:\n${description}\n\nReturn JSON only.`,
      },
    ],
    maxTurns: 1,
    timeoutMs: 60_000,
  });
  const parsed = extractJsonFromText<VerifyResponse>(text);
  if (!parsed) {
    return { verdict: "not_present", what_is_actually_there: "unparseable AI response", confidence: 0 };
  }
  return parsed;
}

type RelocateResponse = {
  found: boolean;
  x: number | null;
  y: number | null;
  confidence: number;
  reason_if_not_found: string;
};

async function askRelocate(
  key: string,
  description: string,
  wrongFinding: string,
  fullScreenshot: Buffer,
): Promise<RelocateResponse> {
  const sys = RELOCATE_SYSTEM.replaceAll("<elementKey>", key).replaceAll(
    "<what_was_actually_there>",
    wrongFinding,
  );
  const text = await askClaude({
    label: `relocate/${key}`,
    system: sys,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: fullScreenshot.toString("base64") },
      },
      {
        type: "text",
        text: `Element: ${key}\n\nVisual description:\n${description}\n\nPrevious wrong detection contained: "${wrongFinding}".\n\nReturn JSON only.`,
      },
    ],
    maxTurns: 1,
    timeoutMs: 60_000,
  });
  const parsed = extractJsonFromText<RelocateResponse>(text);
  if (!parsed) {
    return { found: false, x: null, y: null, confidence: 0, reason_if_not_found: "unparseable AI response" };
  }
  return parsed;
}
