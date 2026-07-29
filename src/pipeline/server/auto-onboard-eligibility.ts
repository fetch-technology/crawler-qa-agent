// Browserless auto-onboard eligibility check. Replicates the preconditions
// that autoOnboard() enforces server-side (manual-session.ts, OCR-required +
// level-1-verified gates) but reads ONLY from disk — no Playwright, no live
// session. Used by the auto-onboard scheduler to pre-screen games before
// spending a browser slot, and to annotate the dashboard queue.
//
// NOT replicated: game-mismatch + the live in-progress mutex — both need a
// live session, so the scheduler defers them to autoOnboardPreflight() at
// resume time.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { meta } from "../registry/meta.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { ocrRegions } from "../registry/ocr-regions.js";
import { resolveExpectedUiElements } from "../registry/expected-ui-elements.js";
import { dirForGame } from "../registry/paths.js";
import { LEVEL1_EXPECTED_KEYS, hasUsableRegistryCoord, isValidOcrRegion } from "../registry/onboard-primitives.js";

export type EligibilityResult = { ok: boolean; reason?: string };

/** OCR regions that Auto-Onboard requires (balance + bet widgets). Mirrors the
 *  REQUIRED_ONBOARD_OCR_KEYS check inside autoOnboard(). */
const REQUIRED_OCR_KEYS = ["balanceArea", "betArea"] as const;

/** Standalone copy of ManualSessionManager's private loadSkippedMainKeys —
 *  reads qa-main-skip.json from disk, returns a Set (empty on ENOENT). */
async function loadSkippedMainKeysFromDisk(slug: string): Promise<Set<string>> {
  try {
    const raw = await readFile(path.join(dirForGame(slug), "qa-main-skip.json"), "utf8");
    const parsed = JSON.parse(raw) as { keys?: string[] };
    const keys = Array.isArray(parsed?.keys)
      ? parsed.keys.filter((k) => typeof k === "string" && k.length > 0)
      : [];
    return new Set(keys);
  } catch {
    return new Set<string>();
  }
}

/** Check whether `slug` can be auto-onboarded unattended, using only on-disk
 *  fixtures. Returns { ok:true } when every server-checkable precondition
 *  holds, else { ok:false, reason } with the first blocking reason. */
export async function checkAutoOnboardEligibility(slug: string): Promise<EligibilityResult> {
  const m = await meta.load(slug);
  if (!m) return { ok: false, reason: "no _meta.json" };
  if (!m.gameUrl) return { ok: false, reason: "no game URL in _meta.json" };

  const reg = await uiRegistry.load(slug);
  if (!reg) return { ok: false, reason: "no ui-registry.json" };

  // OCR required regions — mirrors autoOnboard()'s balance/bet gate.
  const ocr = await ocrRegions.load(slug).catch(() => null);
  for (const key of REQUIRED_OCR_KEYS) {
    if (!isValidOcrRegion(ocr?.[key])) {
      return { ok: false, reason: `missing/invalid OCR region: ${key} (draw Balance + Bet widgets first)` };
    }
  }

  // Level-1 keys QA-verified or skipped — mirrors autoOnboard()'s level-1 gate.
  const skipped = await loadSkippedMainKeysFromDisk(slug);
  const expectedTopLevel = (await resolveExpectedUiElements(slug))
    .map((e) => e.key)
    .filter((k) => typeof k === "string" && k.length > 0 && !k.includes("__"));
  const requiredMainKeys = Array.from(new Set<string>([...LEVEL1_EXPECTED_KEYS, ...expectedTopLevel]));
  const missing = requiredMainKeys.filter((key) => {
    if (skipped.has(key)) return false;
    const el = reg[key];
    if (!el) return true;
    return el.verifiedBy !== "QA" && !hasUsableRegistryCoord(el);
  });
  if (missing.length > 0) {
    return { ok: false, reason: `unverified level-1 keys: ${missing.join(", ")}` };
  }

  return { ok: true };
}
