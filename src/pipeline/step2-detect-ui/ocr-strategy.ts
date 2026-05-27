// OCR-based UI element resolver. Runs a single full-viewport OCR pass per
// discoverUi() session and caches the word list; subsequent per-kind lookups
// hit the cache (no extra OCR work).
//
// Useful for slot games where buttons carry visible text labels — common for
// "BUY BONUS", "AUTO", "HISTORY", "PAYTABLE/INFO" on PP games. The canvas-only
// spinButton typically has no text and falls through to template / ai_vision.
//
// Why this matters: with this layer wired, the resolver chain becomes
//   dom → ocr → template → ai_vision
// → AI vision (paid) only runs when the cheaper deterministic layers all miss.
//
// AI scope: ZERO AI calls. Pure Tesseract.

import type { Page } from "playwright";
import type { UiElement } from "../registry/types.js";
import type { StrategyResult } from "./types.js";

type Word = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
};

/** Per-element keyword list. All lowercase, matched as substring against
 *  Tesseract-recognized words (also lowercased). Order ranks "primary"
 *  vs "secondary" hint — but in the current matcher we just take the
 *  highest-confidence word that matches ANY keyword. */
const ELEMENT_KEYWORDS: Record<string, readonly string[]> = {
  spinButton: ["spin"],
  autoButton: ["auto", "autoplay"],
  turboButton: ["turbo"],
  buyBonusButton: ["buy bonus", "buy feature", "buy free", "buy", "bonus"],
  historyButton: ["history"],
  menuButton: ["menu"],
  paytableButton: ["paytable", "pay table", "info", "rules"],
};

/** Minimum Tesseract confidence (0-100) to accept a word match. Empirically
 *  ~60+ is reliable on rendered slot UI text; below that gets noisy. */
const MIN_OCR_CONFIDENCE = 60;

// Module-scope cache: ONE OCR pass per Page instance per discoverUi() session.
// Keyed by Page object identity (WeakMap auto-evicts when page closed).
const wordCache = new WeakMap<Page, Promise<Word[] | null>>();

/** Reset the cache for a Page — call when the page navigates or before
 *  starting a fresh discovery pass on the same Page. */
export function resetOcrCache(page: Page): void {
  wordCache.delete(page);
}

export async function tryOcr(page: Page, elementKind: string): Promise<StrategyResult> {
  const keywords = ELEMENT_KEYWORDS[elementKind];
  if (!keywords || keywords.length === 0) return { found: false };

  const words = await getWordsCached(page);
  if (!words || words.length === 0) return { found: false };

  let best: Word | null = null;
  for (const word of words) {
    if (word.confidence < MIN_OCR_CONFIDENCE) continue;
    const lower = word.text.toLowerCase();
    if (!keywords.some((kw) => lower.includes(kw))) continue;
    if (!best || word.confidence > best.confidence) best = word;
  }
  if (!best) return { found: false };

  const cx = Math.round((best.bbox.x0 + best.bbox.x1) / 2);
  const cy = Math.round((best.bbox.y0 + best.bbox.y1) / 2);
  const element: UiElement = {
    x: cx,
    y: cy,
    strategy: "ocr",
    confidence: best.confidence / 100,
    detectedAt: new Date().toISOString(),
  };
  return { found: true, element };
}

async function getWordsCached(page: Page): Promise<Word[] | null> {
  const hit = wordCache.get(page);
  if (hit) return hit;
  const pending = runOcr(page);
  wordCache.set(page, pending);
  return pending;
}

async function runOcr(page: Page): Promise<Word[] | null> {
  try {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(buf);
      return flattenWords(result.data);
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[ocr-strategy] OCR failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Tesseract.js v7 returns `data.blocks[].paragraphs[].lines[].words[]`.
 *  Flatten to a single Word[] for downstream matching. */
function flattenWords(data: unknown): Word[] {
  const out: Word[] = [];
  const blocks = (data as { blocks?: unknown[] })?.blocks;
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    const paragraphs = (block as { paragraphs?: unknown[] })?.paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    for (const para of paragraphs) {
      const lines = (para as { lines?: unknown[] })?.lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        const words = (line as { words?: unknown[] })?.words;
        if (!Array.isArray(words)) continue;
        for (const w of words) {
          const word = w as { text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number }; confidence?: number };
          if (typeof word.text !== "string" || !word.bbox) continue;
          out.push({
            text: word.text,
            bbox: word.bbox,
            confidence: typeof word.confidence === "number" ? word.confidence : 0,
          });
        }
      }
    }
  }
  return out;
}

/** Exposed for tests. Same matching logic the resolver uses but pure
 *  (no Page, no Tesseract) — feed it pre-baked words and assert the choice. */
export function pickBestWordForKind(
  elementKind: string,
  words: ReadonlyArray<Word>,
  minConfidence = MIN_OCR_CONFIDENCE,
): Word | null {
  const keywords = ELEMENT_KEYWORDS[elementKind];
  if (!keywords) return null;
  let best: Word | null = null;
  for (const word of words) {
    if (word.confidence < minConfidence) continue;
    const lower = word.text.toLowerCase();
    if (!keywords.some((kw) => lower.includes(kw))) continue;
    if (!best || word.confidence > best.confidence) best = word;
  }
  return best;
}

export type { Word as OcrWord };
