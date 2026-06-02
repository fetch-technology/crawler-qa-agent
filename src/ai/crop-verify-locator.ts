// AI: per-element coord refinement via iterative crop-and-verify.
//
// Adapted from logic-data-crawler-creator-main's `canvas-click` skill. Instead
// of trusting a single AI vision call to label every element of a screen at
// once (drift typically ±10-50px on canvas-rendered slots), we localize ONE
// element at a time with a feedback loop:
//
//   1. Take full-page screenshot.
//   2. AI estimates bbox {x,y,w,h} for the target description.
//   3. Take a CROP of the bbox.
//   4. AI inspects the crop:
//        - Is this actually the button? If no → bail, can't recover.
//        - Is the button centered in the crop? If no → return dx/dy/expand*.
//   5. Apply adjustment + clamp to viewport. Re-crop.
//   6. Loop up to N times; when centered, return crop center as click coord.
//
// Result: each canonical main button gets a coord verified by VISUAL feedback,
// not "AI said so once". Costs more AI calls per element (~3-8 each) but
// drastically reduces drift → fewer probe failures, less QA Pick needed.
//
// USAGE: cold-start seed of canonical main keys (spinButton/betPlus/...) where
// each key has a known description. NOT for sub-state popups (use batch
// aiDiscoverState — popup children aren't pre-listed).

import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "./claude.js";

export type CropBBox = { x: number; y: number; w: number; h: number };

export type CropVerifyResult = {
  ok: boolean;
  /** Final click coord (center of the centered crop) when ok. Best-effort
   *  center when not ok (low confidence). */
  x?: number;
  y?: number;
  /** 0..1 — 0.9 if first crop centered, decays per iteration; 0.3 if never converged. */
  confidence: number;
  attempts: number;
  reason?: string;
  /** Per-iteration trail for debugging. */
  trail: Array<{ iter: number; bbox: CropBBox; verdict?: string }>;
};

const SYSTEM_INITIAL =
  "You are a precise UI locator for slot-game screens. Given a full-screen screenshot and a button description, return the button's bounding box (or `found: false` if absent). The bbox must tightly fit the CLICKABLE button shape — exclude decorative glow/shadow. Return ONLY JSON, no prose.";

const SYSTEM_VERIFY =
  "You inspect a CROPPED image that should contain a specific UI button. Decide (a) whether the crop actually contains that button, and (b) whether the button sits at or near the center of the crop. If off-center, return a precise pixel adjustment so the next crop is centered. Return ONLY JSON, no prose.";

const INITIAL_PROMPT = (description: string, viewport: { width: number; height: number }): string =>
  `Find this button in the screenshot: ${description}\n\n` +
  `Viewport is ${viewport.width}×${viewport.height} px. Coordinates are screenshot CSS pixels, origin top-left.\n` +
  `Return JSON:\n` +
  `{\n` +
  `  "found": boolean,\n` +
  `  "bbox": { "x": int, "y": int, "w": int, "h": int },\n` +
  `  "confidence": number  // 0..1\n` +
  `}\n` +
  `If found=false, omit bbox. Bbox should TIGHTLY fit the clickable button (not surrounding glow/shadow).`;

const VERIFY_PROMPT = (description: string): string =>
  `This crop should contain: ${description}\n\n` +
  `Inspect carefully and answer in JSON:\n` +
  `{\n` +
  `  "correct": boolean,         // is this actually the right button?\n` +
  `  "centered": boolean,        // does the button sit AT or NEAR the center? (~10px tolerance)\n` +
  `  "adjustment": {             // pixel deltas to apply (ignored if centered=true)\n` +
  `    "dx": int,                // shift crop horizontally (positive = right)\n` +
  `    "dy": int,                // shift crop vertically (positive = down)\n` +
  `    "expandLeft": int,        // grow LEFT edge outward (positive) or shrink (negative)\n` +
  `    "expandRight": int,\n` +
  `    "expandTop": int,\n` +
  `    "expandBottom": int\n` +
  `  },\n` +
  `  "reason": string            // one short sentence\n` +
  `}\n` +
  `If button is fully out of the crop, set correct=false.\n` +
  `If button is mostly visible but off-center, set correct=true, centered=false, and propose adjustments.`;

type Verdict = {
  correct: boolean;
  centered: boolean;
  adjustment?: {
    dx?: number; dy?: number;
    expandLeft?: number; expandRight?: number;
    expandTop?: number; expandBottom?: number;
  };
  reason?: string;
};

/** Apply a verdict's adjustment to a bbox. Pure. Exported for tests. */
export function applyAdjustment(bbox: CropBBox, adjustment: Verdict["adjustment"]): CropBBox {
  const a = adjustment ?? {};
  const dx = a.dx ?? 0;
  const dy = a.dy ?? 0;
  const eL = a.expandLeft ?? 0;
  const eR = a.expandRight ?? 0;
  const eT = a.expandTop ?? 0;
  const eB = a.expandBottom ?? 0;
  return {
    x: Math.round(bbox.x + dx - eL),
    y: Math.round(bbox.y + dy - eT),
    w: Math.round(bbox.w + eL + eR),
    h: Math.round(bbox.h + eT + eB),
  };
}

/** Clamp bbox to viewport bounds + enforce a sane minimum size so
 *  page.screenshot's clip parameter doesn't throw. Pure. Exported for tests. */
export function clampBbox(bbox: CropBBox, viewport: { width: number; height: number }): CropBBox {
  const MIN_DIM = 20;
  let x = Math.max(0, Math.floor(bbox.x));
  let y = Math.max(0, Math.floor(bbox.y));
  let w = Math.max(MIN_DIM, Math.floor(bbox.w));
  let h = Math.max(MIN_DIM, Math.floor(bbox.h));
  if (x + w > viewport.width) w = viewport.width - x;
  if (y + h > viewport.height) h = viewport.height - y;
  if (w < MIN_DIM) { x = Math.max(0, viewport.width - MIN_DIM); w = MIN_DIM; }
  if (h < MIN_DIM) { y = Math.max(0, viewport.height - MIN_DIM); h = MIN_DIM; }
  return { x, y, w, h };
}

async function aiEstimateBbox(
  page: Page,
  description: string,
  label: string,
): Promise<{ bbox: CropBBox | null; confidence: number }> {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  try {
    const raw = await askClaude({
      system: SYSTEM_INITIAL,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
        { type: "text", text: INITIAL_PROMPT(description, vp) },
      ],
      label: `crop-verify/initial/${label}`,
      timeoutMs: 60_000,
    });
    const parsed = extractJsonFromText<{ found?: boolean; bbox?: CropBBox; confidence?: number }>(raw);
    if (!parsed?.found || !parsed.bbox) return { bbox: null, confidence: 0 };
    return { bbox: parsed.bbox, confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7 };
  } catch {
    return { bbox: null, confidence: 0 };
  }
}

async function aiVerifyCrop(cropBuf: Buffer, description: string, label: string): Promise<Verdict | null> {
  try {
    const raw = await askClaude({
      system: SYSTEM_VERIFY,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: cropBuf.toString("base64") } },
        { type: "text", text: VERIFY_PROMPT(description) },
      ],
      label: `crop-verify/verify/${label}`,
      timeoutMs: 60_000,
    });
    const parsed = extractJsonFromText<Verdict>(raw);
    if (!parsed || typeof parsed.correct !== "boolean" || typeof parsed.centered !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Localize one UI element by iterative crop-and-verify.
 *
 * @param page Playwright page (must be on the target screen, settled).
 * @param opts.description Human description (e.g. "the spin button — large
 *        circular button at bottom center with a circular-arrow icon").
 * @param opts.label Short tag for log lines (e.g. uiKey).
 * @param opts.initialBbox Optional starting bbox to skip step-1 AI call.
 * @param opts.maxIterations Default 6.
 */
export async function cropVerifyLocator(
  page: Page,
  opts: {
    description: string;
    label: string;
    initialBbox?: CropBBox;
    maxIterations?: number;
  },
): Promise<CropVerifyResult> {
  const maxIter = opts.maxIterations ?? 6;
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const trail: CropVerifyResult["trail"] = [];

  let bbox: CropBBox | null = opts.initialBbox ?? null;
  let initialConfidence = 0.7;
  if (!bbox) {
    const est = await aiEstimateBbox(page, opts.description, opts.label);
    if (!est.bbox) {
      return {
        ok: false,
        confidence: 0,
        attempts: 0,
        trail,
        reason: "AI could not locate the button in the full-page screenshot",
      };
    }
    bbox = est.bbox;
    initialConfidence = est.confidence;
  }
  bbox = clampBbox(bbox, vp);

  for (let i = 0; i < maxIter; i++) {
    let cropBuf: Buffer;
    try {
      cropBuf = await page.screenshot({ type: "png", clip: bbox });
    } catch (err) {
      // Clip went out of bounds despite clamp — try one more clamp and skip.
      bbox = clampBbox(bbox, vp);
      trail.push({ iter: i, bbox, verdict: `screenshot threw: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const verdict = await aiVerifyCrop(cropBuf, opts.description, opts.label);
    trail.push({ iter: i, bbox, verdict: verdict ? `correct=${verdict.correct} centered=${verdict.centered} reason=${verdict.reason ?? ""}` : "verify call failed" });

    if (!verdict) {
      // Couldn't verify — keep this bbox as best-effort.
      break;
    }
    if (verdict.correct === false) {
      return {
        ok: false,
        x: Math.round(bbox.x + bbox.w / 2),
        y: Math.round(bbox.y + bbox.h / 2),
        confidence: 0.1,
        attempts: i + 1,
        trail,
        reason: `AI says crop is not the button (iter ${i + 1}): ${verdict.reason ?? ""}`,
      };
    }
    if (verdict.centered) {
      return {
        ok: true,
        x: Math.round(bbox.x + bbox.w / 2),
        y: Math.round(bbox.y + bbox.h / 2),
        // First-crop convergence keeps initial confidence; each extra iter
        // shaves a bit (still tight but a hint that adjustment was needed).
        confidence: Math.max(0.5, initialConfidence - i * 0.05),
        attempts: i + 1,
        trail,
      };
    }
    bbox = clampBbox(applyAdjustment(bbox, verdict.adjustment), vp);
  }

  // Didn't converge — return best-effort center with low confidence.
  return {
    ok: false,
    x: Math.round(bbox.x + bbox.w / 2),
    y: Math.round(bbox.y + bbox.h / 2),
    confidence: 0.3,
    attempts: maxIter,
    trail,
    reason: `did not converge after ${maxIter} iterations`,
  };
}
