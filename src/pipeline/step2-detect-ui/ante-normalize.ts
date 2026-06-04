// Ante-bet normalization. Many slot titles have an ANTE BET toggle that
// inflates the wager by ~25% (1.25× multiplier — sometimes 1.5×/1.9×) in
// exchange for higher scatter frequency. Our Discover phase + test-case
// runs MUST happen with ante OFF, because:
//
//   1. The bet-selector popup shows DIFFERENT chip values when ante is ON
//      (e.g. 0.05/0.10/0.50 vs 0.0625/0.125/0.625). Discovering bet chips
//      under ante ON contaminates the registry permanently.
//   2. game-mechanics inference reads observed bet/coin/lines from spin
//      requests; ante-inflated samples produce wrong `betMultiplier`.
//   3. Test cases asserting `spin.betAmount === <expected>` fail under
//      ante because the engine adds the ante surcharge.
//
// This module provides three operations:
//
//   - normalizeAnteOff(page, slug, registry, …)
//       FIRST-TIME bootstrap: no baseline yet. Tier 1 = OCR. Tier 1.5 =
//       toggle-and-observe (click ante, watch bet display change to
//       infer prior state). Captures the OFF state as a PNG baseline
//       and writes the relative path into registry[anteButton].offBaseline.
//
//   - verifyAnteOff(page, slug, registry, …)
//       Cheap post-condition check used after normalize + by discover-
//       time guards. Pixel-diffs current ante button vs saved baseline.
//
//   - ensureAnteOff(page, slug, registry, …)
//       Runtime preamble (case-run): if baseline exists, pixel-diff →
//       click once if drifted. If no baseline, run full normalizeAnteOff.
//
// All three are no-ops when registry has no `anteButton` entry — games
// without ante feature.

import type { Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "../registry/paths.js";
import { snapshotRegion, regionAround } from "../utils/pixel-diff/region.js";
import { pixelDiff, decodePng } from "../utils/pixel-diff/diff.js";
import { ocrRegion } from "../utils/ocr-popup.js";
import type { UiRegistry } from "../registry/types.js";
import { readFile } from "node:fs/promises";

/** Pixel-diff ratio above which we consider the ante button visually
 *  different from baseline (= state changed since baseline was captured).
 *  Used for RUNTIME drift detection — tuned conservatively to avoid
 *  false positives from minor visual changes (focus rings, hover state). */
const DRIFT_THRESHOLD = 0.08;

/** Below this, we treat the diff as "essentially identical" → ante still
 *  OFF. Between [DIFF_NOISE_FLOOR, DRIFT_THRESHOLD] is "ambiguous" — we
 *  re-snapshot once after a short delay to rule out one-frame animation. */
const DIFF_NOISE_FLOOR = 0.03;

/** Minimum pixel diff required to count a click as "had visible effect"
 *  during Tier 2 toggle-observe (normalize bootstrap). LOWER than
 *  DRIFT_THRESHOLD because real ante toggles often produce modest visual
 *  changes (a single indicator pill flips color, a small "+25%" badge
 *  appears/disappears) — observed as low as 5-7% on real games. Anything
 *  above noise floor (~3%) is signal. Setting to 4% gives margin over
 *  noise while accepting subtle real toggles. Without this looser
 *  threshold, normalize false-fails on subtle-visual games. */
const CLICK_EFFECT_THRESHOLD = 0.04;

/** Crop box around the ante button center for screenshot + OCR. Slightly
 *  wider than the button itself so we catch the text label ("ANTE BET",
 *  "+25%", "ON"/"OFF" indicator). */
const ANTE_CROP_W = 140;
const ANTE_CROP_H = 100;

/** Filename for the persisted baseline (under fixtures/registry/<slug>/). */
const BASELINE_FILENAME = "ante-baseline.png";

type AnteEntry = { x: number; y: number };

function getAnteEntry(registry: UiRegistry): AnteEntry | null {
  const el = registry["anteButton"];
  if (!el || typeof el.x !== "number" || typeof el.y !== "number") return null;
  return { x: el.x, y: el.y };
}

function anteCropRegion(entry: AnteEntry) {
  return regionAround(entry.x, entry.y, ANTE_CROP_W, ANTE_CROP_H);
}

/** Heuristic verdict from raw OCR text near the ante toggle.
 *  - "off": confidently OFF (text contains "OFF" or no on-indicator)
 *  - "on": confidently ON (text contains "ON", "+25%", "+50%", "x1.", multipliers)
 *  - "unknown": OCR returned nothing useful */
function classifyOcrText(raw: string): "off" | "on" | "unknown" {
  const t = raw.toLowerCase();
  if (!t.trim()) return "unknown";
  // Strong ON signals — ante surcharges are commonly displayed as a
  // multiplier ("+25%" / "x1.25") or explicit "ON" badge.
  if (/\+\s*\d+\s*%/.test(t)) return "on";
  if (/x\s*1\.[1-9]/.test(t)) return "on";
  if (/\bon\b/.test(t) && /ante|boost|chance/.test(t)) return "on";
  // Strong OFF signals — explicit "OFF" badge, or just the feature name
  // with no multiplier shown (typical OFF state).
  if (/\boff\b/.test(t)) return "off";
  // Just "ANTE BET" / "BET BOOST" with nothing else → most games hide
  // the multiplier when OFF. Treat as off but with lower confidence —
  // caller can opt into a confirmation toggle if it cares.
  if (/ante|boost|chance|super/.test(t) && !/\d/.test(t)) return "off";
  return "unknown";
}

async function capturePngBuffer(page: Page, entry: AnteEntry): Promise<Buffer> {
  const region = anteCropRegion(entry);
  return await page.screenshot({
    type: "png",
    clip: { x: region.x, y: region.y, width: region.width, height: region.height },
  });
}

/** Resolve the absolute baseline PNG path for a slug. */
export function baselinePath(slug: string): string {
  return path.join(dirForGame(slug), BASELINE_FILENAME);
}

/** Debug crop save — writes each intermediate snapshot under
 *  fixtures/registry/<slug>/ante-debug/<timestamp>/<stepName>.png so QA
 *  can inspect what the OCR + pixel-diff actually "saw". Always on
 *  during normalize bootstrap (cheap — 4-6 small PNGs per run). Logs the
 *  full path so user can paste into preview / image viewer. Failure is
 *  non-fatal — debug writes shouldn't crash normalize.
 *
 *  Returns the relative-to-slug path of the SAVED file (for logging),
 *  or null on write failure. */
async function saveDebugCrop(
  slug: string,
  runStamp: string,
  stepName: string,
  buf: Buffer,
  meta?: Record<string, unknown>,
): Promise<string | null> {
  const debugDir = path.join(dirForGame(slug), "ante-debug", runStamp);
  try {
    await mkdir(debugDir, { recursive: true });
    const file = path.join(debugDir, `${stepName}.png`);
    await writeFile(file, buf);
    if (meta) {
      const metaFile = path.join(debugDir, `${stepName}.meta.json`);
      await writeFile(metaFile, JSON.stringify(meta, null, 2) + "\n", "utf8");
    }
    const rel = path.relative(dirForGame(slug), file);
    console.log(`[ante-normalize/debug] saved ${stepName} → ${rel}`);
    return rel;
  } catch (err) {
    console.warn(`[ante-normalize/debug] failed to save ${stepName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Generate a per-run stamp using a monotonic counter — Date.now() not
 *  available in some test contexts. Falls back to "latest" when env
 *  blocks process.hrtime too. Pattern: `run-NNNN` where NNNN increments
 *  per process. */
let _debugRunCounter = 0;
function newDebugRunStamp(): string {
  _debugRunCounter++;
  return `run-${String(_debugRunCounter).padStart(4, "0")}`;
}

/** Pixel-diff current ante button screenshot vs persisted baseline.
 *  Returns null when no baseline saved yet (caller must run normalize). */
export async function diffVsAnteBaseline(
  page: Page,
  slug: string,
  registry: UiRegistry,
): Promise<{ ratio: number; baselineFound: boolean } | null> {
  const entry = getAnteEntry(registry);
  if (!entry) return null;
  let baselineBuf: Buffer;
  try {
    baselineBuf = await readFile(baselinePath(slug));
  } catch {
    return { ratio: 1, baselineFound: false };
  }
  const baseline = decodePng(baselineBuf);
  const current = await snapshotRegion(page, anteCropRegion(entry));
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return { ratio: 1, baselineFound: true };
  }
  const { ratio } = pixelDiff(baseline, current);
  return { ratio, baselineFound: true };
}

/** Click the ante button once and wait for any animation/transition to
 *  settle. Game-agnostic: just clicks the registry coord, then waits a
 *  short fixed period (most ante toggles animate in <500ms). */
async function clickAnte(page: Page, entry: AnteEntry, settleMs = 800): Promise<void> {
  await page.mouse.click(entry.x, entry.y);
  await page.waitForTimeout(settleMs);
}

/** OCR the ante region — Tier 1 detect. Returns the classification
 *  + the raw text (for logging/debugging). */
async function ocrAnteState(
  page: Page,
  entry: AnteEntry,
): Promise<{ verdict: "off" | "on" | "unknown"; rawText: string }> {
  const region = anteCropRegion(entry);
  try {
    const { text } = await ocrRegion(page, {
      x: region.x,
      y: region.y,
      w: region.width,
      h: region.height,
    });
    return { verdict: classifyOcrText(text), rawText: text };
  } catch (err) {
    console.warn(`[ante-normalize] OCR failed: ${err instanceof Error ? err.message : String(err)}`);
    return { verdict: "unknown", rawText: "" };
  }
}

export type NormalizeResult = {
  ok: boolean;
  reason?: string;
  /** Persisted baseline file path (absolute) when ok=true. */
  baselinePath?: string;
  /** Initial detected ante state before any toggles. "skipped" when no
   *  anteButton in registry. */
  initialState: "off" | "on" | "unknown" | "skipped";
  /** How many times we clicked ante during normalize. Diagnostic only. */
  toggledCount: number;
  /** Which tier produced the final verdict. */
  detectionTier: "ocr" | "toggle-observe" | "skipped" | "failed";
};

/**
 * First-time normalize. Discovers current ante state, forces OFF, captures
 * baseline PNG. Call this ONCE during Discover, after main-state element
 * discovery has populated `anteButton`.
 *
 * Tier order:
 *   1. OCR — read the region text, classify. If OFF → just capture baseline.
 *      If ON → click, OCR again, capture baseline when OFF confirmed.
 *   2. Toggle-observe — OCR unclear. Snapshot before click, click ante,
 *      snapshot after. The CLICK definitely changed state; we now have
 *      both candidates. Heuristic: the state with the SMALLER bet display
 *      (when bet OCR available) is OFF. Fallback heuristic without bet
 *      OCR: assume current AFTER-CLICK state is the toggled one — click
 *      one more time to revert + accept as baseline (best-effort).
 *
 * Returns ok=false if we couldn't establish a confident OFF state — the
 * caller (Discover) should ABORT rather than continue with a contaminated
 * baseline. Better to fail loudly than silently capture wrong reference.
 */
export async function normalizeAnteOff(
  page: Page,
  slug: string,
  registry: UiRegistry,
): Promise<NormalizeResult> {
  const entry = getAnteEntry(registry);
  if (!entry) {
    console.log(`[ante-normalize] ${slug}: SKIP — no anteButton in registry (game has no ante feature)`);
    return {
      ok: true,
      initialState: "skipped",
      toggledCount: 0,
      detectionTier: "skipped",
    };
  }

  const runStamp = newDebugRunStamp();
  console.log(`[ante-normalize] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[ante-normalize] ${slug}: START — anteButton@(${entry.x},${entry.y}) crop=${ANTE_CROP_W}×${ANTE_CROP_H}`);
  console.log(`[ante-normalize] ${slug}: debug dir → fixtures/registry/${slug}/ante-debug/${runStamp}/`);
  console.log(`[ante-normalize] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // ─── Step 1/4: Tier 1 OCR ─────────────────────────────────────────
  console.log(`[ante-normalize] ${slug}: STEP 1/4 — Tier 1 OCR read region…`);
  // Capture the crop BEFORE OCR so QA can see exactly what Tesseract
  // was asked to read. Helps diagnose "OCR returned gibberish" cases —
  // often the crop is misaligned and grabs game art instead of the
  // toggle text.
  const initialCrop = await capturePngBuffer(page, entry);
  await saveDebugCrop(slug, runStamp, "01-initial-crop", initialCrop, {
    step: "Tier 1 OCR input",
    cropRegion: anteCropRegion(entry),
    anteCoord: { x: entry.x, y: entry.y },
  });
  const initialOcr = await ocrAnteState(page, entry);
  await saveDebugCrop(slug, runStamp, "01-initial-ocr-result", initialCrop, {
    step: "Tier 1 OCR result",
    verdict: initialOcr.verdict,
    rawText: initialOcr.rawText,
  });
  console.log(`[ante-normalize] ${slug}: STEP 1/4 — OCR verdict=${initialOcr.verdict} text="${initialOcr.rawText.replace(/\s+/g, " ").slice(0, 80)}"`);

  let toggledCount = 0;
  let finalState: "off" | "on" | "unknown" = initialOcr.verdict;
  let detectionTier: NormalizeResult["detectionTier"] = "ocr";

  if (initialOcr.verdict === "on") {
    // Confidently ON → click once to flip OFF, re-verify.
    console.log(`[ante-normalize] ${slug}: STEP 2/4 — ante reads ON, clicking to flip OFF…`);
    await clickAnte(page, entry);
    toggledCount++;
    const postBuf = await capturePngBuffer(page, entry);
    const after = await ocrAnteState(page, entry);
    await saveDebugCrop(slug, runStamp, "02-post-flip-ocr", postBuf, {
      step: "Tier 1: post-flip OCR",
      verdict: after.verdict,
      rawText: after.rawText,
      toggledCount,
    });
    console.log(`[ante-normalize] ${slug}: STEP 2/4 — post-toggle OCR verdict=${after.verdict}`);
    if (after.verdict === "off") {
      finalState = "off";
    } else if (after.verdict === "on") {
      // Click didn't flip → something wrong with coords or it's a button
      // that needs confirm. Bail.
      return {
        ok: false,
        reason: `ante still reads ON after click (OCR="${after.rawText.slice(0, 60)}") — coords may target wrong element or toggle needs confirmation`,
        initialState: "on",
        toggledCount,
        detectionTier: "ocr",
      };
    } else {
      // Post-click OCR unclear — fall through to toggle-observe to
      // resolve, treating current state as candidate "off".
      detectionTier = "toggle-observe";
      finalState = "unknown";
    }
  }

  // ─── Step 3/4: Tier 2 toggle-observe ──────────────────────────────
  // Use this when OCR is ambiguous from the start, OR Tier 1 left us
  // uncertain post-click. We use a button-region pixel-diff to confirm
  // a click actually changed the visual state — then accept current
  // state as OFF iff additional signal supports it.
  if (finalState === "unknown") {
    console.log(`[ante-normalize] ${slug}: STEP 3/4 — Tier 2 toggle-observe (OCR unclear)…`);
    detectionTier = "toggle-observe";
    const beforeBuf = await capturePngBuffer(page, entry);
    await saveDebugCrop(slug, runStamp, "03a-tier2-before-click", beforeBuf, {
      step: "Tier 2: before click",
    });
    await clickAnte(page, entry);
    toggledCount++;
    const afterBuf = await capturePngBuffer(page, entry);
    const beforePng = decodePng(beforeBuf);
    const afterPng = decodePng(afterBuf);
    const { ratio } =
      beforePng.width === afterPng.width && beforePng.height === afterPng.height
        ? pixelDiff(beforePng, afterPng)
        : { ratio: 1 };
    await saveDebugCrop(slug, runStamp, "03b-tier2-after-click", afterBuf, {
      step: "Tier 2: after click",
      pixelDiffRatio: ratio,
      clickEffectThreshold: CLICK_EFFECT_THRESHOLD,
      passed: ratio >= CLICK_EFFECT_THRESHOLD,
    });
    console.log(`[ante-normalize] ${slug}: STEP 3/4 — click→pixel-diff ratio=${ratio.toFixed(3)} threshold=${CLICK_EFFECT_THRESHOLD}`);
    if (ratio < CLICK_EFFECT_THRESHOLD) {
      // Click produced no visual change → either coords wrong or it
      // really IS a non-toggle (e.g. spinButton mislabeled). Bail.
      // Threshold is intentionally LOOSER than DRIFT_THRESHOLD because
      // many ante toggles produce subtle visual changes (single
      // indicator pill, small badge) — anything above noise (3%) is
      // real signal.
      console.log(`[ante-normalize] ${slug}: STEP 3/4 — FAIL: click produced no visible change`);
      await saveDebugCrop(slug, runStamp, "FAIL-no-click-effect", afterBuf, {
        step: "FAIL: click produced no visible change",
        pixelDiffRatio: ratio,
        threshold: CLICK_EFFECT_THRESHOLD,
        hint: "compare 03a-before vs 03b-after — should look identical (coord wrong) or near-identical (real toggle with tiny indicator)",
      });
      return {
        ok: false,
        reason: `click on anteButton produced no visible change (pixel diff=${ratio.toFixed(3)} < threshold ${CLICK_EFFECT_THRESHOLD}) — registry coord may be wrong or element is not a toggle`,
        initialState: initialOcr.verdict,
        toggledCount,
        detectionTier: "toggle-observe",
      };
    }
    // We toggled the state. Now OCR the new state. If now clearly OFF
    // → accept. If now clearly ON → toggle back. If still unknown →
    // can't proceed without inference signal; bail.
    const recheck = await ocrAnteState(page, entry);
    await saveDebugCrop(slug, runStamp, "03c-tier2-recheck-ocr", afterBuf, {
      step: "Tier 2: recheck OCR after toggle",
      verdict: recheck.verdict,
      rawText: recheck.rawText,
    });
    console.log(`[ante-normalize] ${slug}: STEP 3/4 — recheck OCR after toggle verdict=${recheck.verdict}`);
    if (recheck.verdict === "off") {
      finalState = "off";
    } else if (recheck.verdict === "on") {
      console.log(`[ante-normalize] ${slug}: STEP 3/4 — toggle landed on ON, clicking back to OFF…`);
      await clickAnte(page, entry);
      toggledCount++;
      const finalBuf2 = await capturePngBuffer(page, entry);
      const final = await ocrAnteState(page, entry);
      await saveDebugCrop(slug, runStamp, "03d-tier2-final-ocr", finalBuf2, {
        step: "Tier 2: final OCR after toggle-back",
        verdict: final.verdict,
        rawText: final.rawText,
      });
      finalState = final.verdict === "off" ? "off" : "unknown";
    } else {
      finalState = "unknown";
    }
  }

  if (finalState !== "off") {
    console.log(`[ante-normalize] ${slug}: ❌ FAIL — could not establish OFF state (tier=${detectionTier} finalState=${finalState})`);
    console.log(`[ante-normalize] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return {
      ok: false,
      reason: `could not confidently establish ante OFF state (tier=${detectionTier} finalState=${finalState}) — Discover should abort and QA must inspect`,
      initialState: initialOcr.verdict,
      toggledCount,
      detectionTier: "failed",
    };
  }

  // ─── Step 4/4: Capture baseline ───────────────────────────────────
  console.log(`[ante-normalize] ${slug}: STEP 4/4 — capture OFF-state baseline PNG…`);
  const finalBuf = await capturePngBuffer(page, entry);
  await mkdir(dirForGame(slug), { recursive: true });
  const outPath = baselinePath(slug);
  await writeFile(outPath, finalBuf);
  await saveDebugCrop(slug, runStamp, "04-final-baseline", finalBuf, {
    step: "Final OFF-state baseline (also saved as ante-baseline.png)",
    tier: detectionTier,
    initialState: initialOcr.verdict,
    toggledCount,
  });
  console.log(`[ante-normalize] ${slug}: STEP 4/4 — baseline saved (${finalBuf.length} bytes) → ${outPath}`);
  console.log(`[ante-normalize] ${slug}: ✅ DONE — tier=${detectionTier} toggled=${toggledCount}× initial=${initialOcr.verdict}`);
  console.log(`[ante-normalize] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return {
    ok: true,
    baselinePath: outPath,
    initialState: initialOcr.verdict === "unknown" ? "unknown" : initialOcr.verdict,
    toggledCount,
    detectionTier,
  };
}

export type VerifyResult = {
  isOff: boolean;
  ratio: number | null;
  baselineFound: boolean;
  reason?: string;
};

/**
 * Cheap "is ante still OFF?" check using pixel-diff vs persisted baseline.
 * Returns `isOff = true` when diff < DIFF_NOISE_FLOOR. Ambiguous range
 * [DIFF_NOISE_FLOOR, DRIFT_THRESHOLD] re-samples once after 250ms to
 * filter one-frame animation noise; if still ambiguous, treats as
 * drift (better to false-positive a re-normalize than miss a real flip).
 *
 * Returns isOff=true with baselineFound=false when no anteButton in
 * registry (games without ante feature — nothing to verify).
 */
export async function verifyAnteOff(
  page: Page,
  slug: string,
  registry: UiRegistry,
): Promise<VerifyResult> {
  const entry = getAnteEntry(registry);
  if (!entry) return { isOff: true, ratio: null, baselineFound: false };
  const first = await diffVsAnteBaseline(page, slug, registry);
  if (!first) return { isOff: true, ratio: null, baselineFound: false };
  if (!first.baselineFound) {
    return {
      isOff: false,
      ratio: first.ratio,
      baselineFound: false,
      reason: "no baseline saved yet — call normalizeAnteOff first",
    };
  }
  if (first.ratio < DIFF_NOISE_FLOOR) return { isOff: true, ratio: first.ratio, baselineFound: true };
  if (first.ratio >= DRIFT_THRESHOLD) {
    return {
      isOff: false,
      ratio: first.ratio,
      baselineFound: true,
      reason: `ante region drifted (ratio=${first.ratio.toFixed(3)}) — likely toggled ON`,
    };
  }
  // Ambiguous band — wait then re-sample to filter animation flicker.
  await page.waitForTimeout(250);
  const second = await diffVsAnteBaseline(page, slug, registry);
  if (!second || !second.baselineFound) return { isOff: false, ratio: first.ratio, baselineFound: false };
  return {
    isOff: second.ratio < DRIFT_THRESHOLD,
    ratio: second.ratio,
    baselineFound: true,
    reason: second.ratio < DRIFT_THRESHOLD ? undefined : `ante region drifted (ratio=${second.ratio.toFixed(3)})`,
  };
}

/**
 * Runtime preamble for test cases. Idempotent:
 *   - If no anteButton in registry → no-op.
 *   - If baseline present + verify says OFF → no-op.
 *   - If verify says drifted → click ante once, re-verify, fail if still drifted.
 *   - If no baseline → fall back to normalizeAnteOff (writes baseline).
 *
 * Returns { ok, wasOff, toggledCount, reason }.
 */
export async function ensureAnteOff(
  page: Page,
  slug: string,
  registry: UiRegistry,
): Promise<{ ok: boolean; wasOff: boolean; toggledCount: number; reason?: string }> {
  const entry = getAnteEntry(registry);
  if (!entry) {
    console.log(`[ensure-ante-off] ${slug}: SKIP — no anteButton in registry`);
    return { ok: true, wasOff: true, toggledCount: 0 };
  }
  console.log(`[ensure-ante-off] ${slug}: checking ante state via pixel-diff vs baseline…`);
  const v = await verifyAnteOff(page, slug, registry);
  if (!v.baselineFound) {
    console.log(`[ensure-ante-off] ${slug}: no baseline yet — falling back to first-time normalize`);
    const n = await normalizeAnteOff(page, slug, registry);
    return {
      ok: n.ok,
      wasOff: n.initialState === "off",
      toggledCount: n.toggledCount,
      reason: n.reason,
    };
  }
  if (v.isOff) {
    console.log(`[ensure-ante-off] ${slug}: ✅ already OFF (ratio=${v.ratio?.toFixed(3) ?? "?"})`);
    return { ok: true, wasOff: true, toggledCount: 0 };
  }
  // Drifted → click once + re-verify.
  console.log(`[ensure-ante-off] ${slug}: ⚠ drift detected (ratio=${v.ratio?.toFixed(3) ?? "?"}) — clicking ante to revert…`);
  await clickAnte(page, entry);
  const after = await verifyAnteOff(page, slug, registry);
  if (after.isOff) {
    console.log(`[ensure-ante-off] ${slug}: ✅ reverted to OFF after 1 click (ratio=${after.ratio?.toFixed(3) ?? "?"})`);
    return { ok: true, wasOff: false, toggledCount: 1 };
  }
  console.log(`[ensure-ante-off] ${slug}: ❌ FAIL — still drifted after click (ratio=${after.ratio?.toFixed(3) ?? "?"})`);
  return {
    ok: false,
    wasOff: false,
    toggledCount: 1,
    reason: after.reason ?? `ante still drifted after one click (ratio=${after.ratio?.toFixed(3) ?? "?"})`,
  };
}
