// AI: locate OCR widget bboxes on a play-screen screenshot. The dashboard's
// OCR Regions panel previously required QA to manually drag-and-mark each
// widget by clicking two corners on the screenshot. Most slot games render
// these widgets in stable, easily-identifiable positions — having QA paint
// them by hand wastes ~30s per game and is the kind of "obvious from the
// image" task vision models solve in one prompt. This module asks Claude to
// emit `{x, y, width, height}` for each requested region in a single vision
// call, plus a confidence + reason per result so callers (manualSession,
// dashboard) can flag low-confidence guesses for QA review.
//
// Output schema mirrors the existing OcrRegions registry shape so results
// can be saved straight to disk via `manualSession.saveOcrRegion()` without
// any reshape.

import { askClaude, extractJsonFromText } from "./claude.js";

export type RegionKey = "balanceArea" | "betArea" | "winArea" | "freeSpinCounter";

export type DetectedRegion = {
  /** Top-left x in viewport CSS px (same coord space as the screenshot). */
  x: number;
  /** Top-left y in viewport CSS px. */
  y: number;
  /** Width in viewport CSS px. */
  width: number;
  /** Height in viewport CSS px. */
  height: number;
  /** AI confidence 0..1. <0.6 → flag for QA review. */
  confidence: number;
  /** Short rationale: what text/icon the AI keyed off (for QA verification). */
  reason: string;
};

export type DetectionResult = Partial<Record<RegionKey, DetectedRegion | { skipped: true; reason: string }>>;

const REGION_DESCRIPTIONS: Record<RegionKey, string> = {
  balanceArea:
    "BALANCE / CREDIT / CASH widget — the main player wallet display. " +
    "Looks like a currency amount (e.g. \"$99,991,152.99\") often labeled " +
    "\"BALANCE\" or \"CREDIT\" or just shown next to a wallet icon. Usually " +
    "in the bottom action bar, bottom-left, or top-right.",
  betArea:
    "BET / TOTAL BET / STAKE widget — the current wager amount the next spin " +
    "will cost. Looks like a currency amount (e.g. \"$10.00\") with a label " +
    "\"BET\" or \"TOTAL BET\" or \"STAKE\". Usually flanked by +/- stepper " +
    "buttons or sits in the bottom action bar.",
  winArea:
    "WIN / LAST WIN / PAY widget — the win amount from the most recent spin. " +
    "Empty (or shows 0.00) between spins. Labeled \"WIN\", \"LAST WIN\", " +
    "\"PAY\". Usually right of the BET widget. SKIP if no win readout is " +
    "visible (some games only show wins via floating popups).",
  freeSpinCounter:
    "FREE SPIN COUNTER — \"X/Y\" or \"FREE SPINS LEFT: N\" display visible " +
    "only DURING a free-spin chain. SKIP unless the screenshot shows an " +
    "active free-spin session.",
};

const SYSTEM_PROMPT =
  "You are a slot-game UI vision detector. You ANALYZE a play-screen " +
  "screenshot and emit tight bounding-boxes (CSS px, viewport coordinate " +
  "space) around small numeric/text widgets that downstream OCR will read. " +
  "Boxes must be SNUG: include the digits/label, exclude surrounding " +
  "background art, dimmers, or large decorative chrome. Output JSON only.";

/**
 * Locate the requested OCR-region widgets in a play-screen screenshot.
 * `regions` defaults to all four canonical keys; pass a subset to limit
 * the call. Returns one entry per requested key — either a `DetectedRegion`
 * or `{skipped: true, reason}` when the widget isn't visible.
 */
export async function detectOcrRegions(opts: {
  screenshotBase64: string;
  viewport: { width: number; height: number };
  regions?: ReadonlyArray<RegionKey>;
}): Promise<DetectionResult> {
  const targetKeys = opts.regions ?? (["balanceArea", "betArea", "winArea", "freeSpinCounter"] as const);
  const targetList = targetKeys.map((k) => `- ${k}: ${REGION_DESCRIPTIONS[k]}`).join("\n");

  const prompt =
    `Viewport ${opts.viewport.width}x${opts.viewport.height} CSS px.\n\n` +
    `Locate the following widgets on this play screen. For each one, emit a tight ` +
    `bounding box that wraps JUST the digits/text (plus its short label if adjacent ` +
    `and on the same row). Exclude background art, dimmers, large icons.\n\n` +
    `TARGETS:\n${targetList}\n\n` +
    `Return ONLY this JSON object — one key per target above:\n` +
    `{\n` +
    `  "<targetKey>": {\n` +
    `    "x": number,        // top-left x in viewport CSS px\n` +
    `    "y": number,        // top-left y\n` +
    `    "width": number,    // box width\n` +
    `    "height": number,   // box height\n` +
    `    "confidence": number, // 0..1 — how sure you are about this bbox\n` +
    `    "reason": string    // 1 short sentence: what label / text you keyed off\n` +
    `  },\n` +
    `  // OR — when the widget is NOT visible / not applicable:\n` +
    `  "<targetKey>": { "skipped": true, "reason": "<why>" }\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Use the EXACT keys from TARGETS as JSON keys.\n` +
    `- Coordinates in the SAME coordinate space as the screenshot (CSS px, ` +
    `top-left origin).\n` +
    `- Boxes must lie ENTIRELY within the viewport.\n` +
    `- BALANCE and BET are almost always present on a normal play screen. ` +
    `WIN may be missing on idle screens. FREE_SPIN_COUNTER appears only ` +
    `during active free spins.\n` +
    `- If two widgets touch, pick the smaller box for each (don't merge).\n` +
    `- Be CONSERVATIVE on confidence — 0.9+ only when label text is fully ` +
    `readable; 0.6-0.8 when you're guessing from value-shape alone; ≤0.5 ` +
    `when unsure.`;

  const raw = await askClaude({
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: opts.screenshotBase64 } },
      { type: "text", text: prompt },
    ],
    system: SYSTEM_PROMPT,
    label: "ocr-region/detect",
    maxTurns: 1,
    timeoutMs: 60_000,
  });

  const parsed = extractJsonFromText<Record<string, unknown>>(raw);
  if (!parsed) return {};

  const out: DetectionResult = {};
  for (const key of targetKeys) {
    const entry = parsed[key];
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (r.skipped === true) {
      out[key] = { skipped: true, reason: typeof r.reason === "string" ? r.reason : "skipped" };
      continue;
    }
    const region = sanitizeRegion(r, opts.viewport);
    if (region) out[key] = region;
  }
  return out;
}

export type CropVerdict = {
  /** True ⇔ the crop unambiguously shows ONLY the requested widget (or
   *  contains it plus a tightly-adjacent label). */
  verified: boolean;
  /** Free-form numeric/text content the model can read off the crop — used
   *  as a cheap sanity-check ("does this match what OCR will read?"). */
  valueRead: string | null;
  /** Short rationale (what label/number convinced the model it's right or wrong). */
  reason: string;
  /** When verified=false: AI's preferred bbox adjustment (relative to the
   *  full screenshot's coord space). null when AI can't suggest a fix. */
  refinedBbox: { x: number; y: number; width: number; height: number } | null;
};

const VERIFY_SYSTEM_PROMPT =
  "You are auditing a CROPPED image taken from a slot-game play screen to " +
  "confirm whether the crop wraps a specific UI widget. Output JSON only.";

/**
 * Second-pass AI vision check: given a CROP that was cut from a full
 * screenshot at the locator's proposed bbox, ask the model whether the crop
 * actually shows the intended widget. The model can (a) approve the crop
 * (verified=true), (b) reject it and suggest a refined bbox in original
 * screenshot coords, or (c) reject without a fix (refinedBbox=null).
 *
 * This is the closed-loop step that catches confidently-wrong bboxes from
 * `detectOcrRegions` — e.g. AI picks the BET widget when asked for BALANCE.
 * Composes with `detectOcrRegions` to produce a vision → crop → vision
 * verification chain that's more robust than confidence alone.
 */
export async function verifyOcrRegionCrop(opts: {
  /** Crop PNG (already extracted at proposed bbox). */
  cropBase64: string;
  /** Original full-page screenshot for context (lets the model relocate the
   *  widget if the crop is off). */
  fullScreenshotBase64: string;
  /** Where the crop sits in the full screenshot (top-left + size). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Which widget the bbox is supposed to wrap. */
  region: RegionKey;
  /** Viewport CSS px — needed so the model can return a refined bbox in the
   *  same coordinate space. */
  viewport: { width: number; height: number };
  /** Bboxes already tried + rejected on previous iterations, with the AI's
   *  rejection reason for each. Passed so the model doesn't propose a
   *  refinement that maps back into a previously-rejected region (observed
   *  on vs20rnriches: AI oscillated betArea between two wrong rows on
   *  successive iters because each call started from scratch). */
  rejectedHistory?: ReadonlyArray<{ bbox: { x: number; y: number; width: number; height: number }; reason: string }>;
}): Promise<CropVerdict> {
  const description = REGION_DESCRIPTIONS[opts.region];
  const historyBlock = opts.rejectedHistory && opts.rejectedHistory.length > 0
    ? `\nALREADY-REJECTED bboxes (do NOT suggest these again or anything within ±10 px of them — pick a DIFFERENT location):\n` +
      opts.rejectedHistory
        .map((h, i) => `  [${i + 1}] (x=${h.bbox.x}, y=${h.bbox.y}, w=${h.bbox.width}, h=${h.bbox.height}) — ${h.reason}`)
        .join("\n") +
      `\n`
    : "";
  const prompt =
    `Viewport ${opts.viewport.width}x${opts.viewport.height} CSS px.\n\n` +
    `The first image is the FULL screenshot. The second image is a CROP cut at ` +
    `bbox (x=${opts.bbox.x}, y=${opts.bbox.y}, width=${opts.bbox.width}, height=${opts.bbox.height}) — ` +
    `it should wrap the **${opts.region}** widget:\n\n` +
    `${description}\n` +
    `${historyBlock}` +
    `\nAudit the crop and return ONLY this JSON:\n\n` +
    `{\n` +
    `  "verified": boolean,            // true ⇔ crop unambiguously shows the ${opts.region} widget\n` +
    `  "value_read": string | null,    // numeric/text you can read off the crop (e.g. "10.00", "$99,991,152.99"). null if not visible.\n` +
    `  "reason": string,               // 1 short sentence: what convinced you\n` +
    `  "refined_bbox": null | { "x": number, "y": number, "width": number, "height": number }\n` +
    `                                  // null when verified=true. Otherwise YOUR corrected bbox\n` +
    `                                  // in the ORIGINAL FULL-SCREENSHOT coord space.\n` +
    `}\n\n` +
    `Decision rules:\n` +
    `- Approve (verified=true) only when the crop's MAIN visible content is the requested widget — its digits and (ideally) its label. Adjacent buttons cut in are OK only if they don't take >30% of the crop.\n` +
    `- REJECT and suggest refined_bbox when:\n` +
    `  • The crop is OFF (wraps a different widget — e.g. BET instead of BALANCE).\n` +
    `  • The crop is too LARGE (digits occupy <40% of the crop area, surrounded by lots of background).\n` +
    `  • The crop is too SMALL (digits clipped, label cut off).\n` +
    `- If you can't find the correct widget anywhere on the full screenshot, refined_bbox=null and reason="widget not on screen".\n` +
    `- IMPORTANT: read the ALREADY-REJECTED list (when present) and AVOID those areas. If your refined bbox is within ±10 px of a rejected one, you are repeating a known wrong answer — pick a completely different region instead, OR set refined_bbox=null with reason="exhausted candidates".\n` +
    `- "value_read" is your TRUTH FOR OCR — if the digits in the crop are clearly "$10.00", emit "$10.00". This lets the caller cross-check downstream OCR.`;

  let raw: string;
  try {
    raw = await askClaude({
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: opts.fullScreenshotBase64 } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: opts.cropBase64 } },
        { type: "text", text: prompt },
      ],
      system: VERIFY_SYSTEM_PROMPT,
      label: `ocr-region/verify-crop/${opts.region}`,
      maxTurns: 1,
      timeoutMs: 60_000,
    });
  } catch (err) {
    return {
      verified: false,
      valueRead: null,
      reason: `verify call threw: ${err instanceof Error ? err.message : String(err)}`,
      refinedBbox: null,
    };
  }
  const parsed = extractJsonFromText<{
    verified?: boolean;
    value_read?: string | null;
    reason?: string;
    refined_bbox?: { x: number; y: number; width: number; height: number } | null;
  }>(raw);
  if (!parsed) {
    return { verified: false, valueRead: null, reason: "verify response not parseable", refinedBbox: null };
  }
  const refined = parsed.refined_bbox && typeof parsed.refined_bbox === "object"
    ? sanitizeRegion({ ...(parsed.refined_bbox as Record<string, unknown>), confidence: 1, reason: parsed.reason ?? "" } as Record<string, unknown>, opts.viewport)
    : null;
  return {
    verified: Boolean(parsed.verified),
    valueRead: typeof parsed.value_read === "string" ? parsed.value_read : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    refinedBbox: refined
      ? { x: refined.x, y: refined.y, width: refined.width, height: refined.height }
      : null,
  };
}

const READ_NUMERIC_SYSTEM =
  "You read a single number off a cropped slot-game UI widget. Output JSON only. " +
  "Transcribe EXACTLY the digits shown — never infer, round, or guess a 'likely' value.";

/**
 * BLIND numeric read of a single widget crop — the gated fallback used when
 * deterministic OCR (Tesseract) returns an IMPLAUSIBLE value on a hard crop
 * (colored text on photographic game art). Deliberately given NO expected /
 * network value, so the model cannot be biased into agreement; the caller
 * cross-checks the returned number against the network value independently.
 * Returns valueRead=null + confidence 0 on any failure (never throws).
 */
export async function readNumericCropWithAi(opts: {
  /** Crop PNG (base64) — the same pixels Tesseract read. */
  cropBase64: string;
  /** Human label for the prompt + telemetry ("balance" / "bet" / "last win"). */
  label: string;
}): Promise<{ valueRead: string | null; confidence: number; reason: string }> {
  const prompt =
    `This crop is the **${opts.label}** widget from a slot game — it shows ONE number ` +
    `(possibly with a currency symbol and thousands/decimal separators).\n\n` +
    `Return ONLY this JSON:\n` +
    `{\n` +
    `  "value_read": string | null,  // the number EXACTLY as displayed, e.g. "$983,252.80", "45.00". null if you genuinely cannot read it.\n` +
    `  "confidence": number,         // 0..1 — how sure you are of EVERY digit\n` +
    `  "reason": string              // 1 short phrase\n` +
    `}\n\n` +
    `Rules: transcribe the digits you SEE. Do NOT guess a plausible balance/bet. ` +
    `If the crop is blurry, occluded, or empty, set value_read=null with low confidence.`;
  let raw: string;
  try {
    raw = await askClaude({
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: opts.cropBase64 } },
        { type: "text", text: prompt },
      ],
      system: READ_NUMERIC_SYSTEM,
      label: `ocr-region/ai-read/${opts.label}`,
      maxTurns: 1,
      timeoutMs: 60_000,
    });
  } catch (err) {
    return { valueRead: null, confidence: 0, reason: `ai read threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = extractJsonFromText<{ value_read?: string | null; confidence?: number; reason?: string }>(raw);
  if (!parsed) return { valueRead: null, confidence: 0, reason: "ai response not parseable" };
  return {
    valueRead: typeof parsed.value_read === "string" ? parsed.value_read : null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

function sanitizeRegion(
  r: Record<string, unknown>,
  viewport: { width: number; height: number },
): DetectedRegion | null {
  const x = Number(r.x);
  const y = Number(r.y);
  const w = Number(r.width);
  const h = Number(r.height);
  const c = Number(r.confidence);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  // Reject bboxes that escape the viewport meaningfully — small overshoot
  // (~5%) is tolerated for AI rounding, anything larger is bogus.
  const slack = 0.05;
  if (x < -viewport.width * slack || y < -viewport.height * slack) return null;
  if (x + w > viewport.width * (1 + slack)) return null;
  if (y + h > viewport.height * (1 + slack)) return null;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.min(Math.round(w), viewport.width),
    height: Math.min(Math.round(h), viewport.height),
    confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
    reason: typeof r.reason === "string" ? r.reason : "",
  };
}
