// Pending OCR-region proposals. When the AI auto-detector returns a
// bbox at confidence < threshold OR its `value_read` doesn't match the
// Tesseract OCR of the crop, we DON'T persist to ocr-regions.json
// (would silently bake a bad bbox). Instead we stash them here so the
// dashboard's "OCR Regions" panel can render them inline with an
// Accept / Reject affordance — QA reviews + decides.
//
// This file fixes a prior UX gap: the manual "🤖 AI Auto-Detect" button
// shows proposals in a one-off popup, but Auto-Onboard's parallel run
// dropped them silently. Persisting to disk lets the dashboard surface
// proposals at any time, including after a fresh page load.
//
// Schema is a flat key→entry map matching the ocr-regions key set so
// loaders can merge with `ocrRegions.load(...)` trivially.

import { loadJson, saveJson, fileExists } from "./io.js";
import { ensureDir } from "./paths.js";
import type { GameSlug } from "./types.js";
import path from "node:path";
import { dirForGame } from "./paths.js";
import { writeFile, readFile } from "node:fs/promises";

const FILENAME = "ocr-regions.proposed.json";

export type OcrProposalEntry = {
  region: { x: number; y: number; width: number; height: number };
  /** Confidence reported by the AI vision model (0..1). */
  visionConfidence: number;
  /** The value the AI claims it can read at that bbox (e.g. "$1,234.56").
   *  When the Tesseract crop of the same bbox returns a different number,
   *  this discrepancy is the reason the proposal isn't auto-saved. */
  aiValueRead: string | null;
  aiReason: string;
  /** Tesseract OCR readback of the AI-picked crop. Useful when QA wants
   *  to compare what each system saw. */
  ocrText?: string;
  ocrParsed?: number | null;
  /** Why the auto-detector demoted this to a proposal instead of saving
   *  (e.g. "ocr_text_mismatch", "confidence_below_threshold"). */
  rejectReason: string;
  /** When this proposal was captured. ISO 8601. */
  proposedAt: string;
};

export type OcrProposalsFile = {
  schemaVersion: 1;
  proposals: Partial<Record<"balanceArea" | "betArea" | "winArea" | "freeSpinCounter", OcrProposalEntry>>;
};

function fileForSlug(slug: GameSlug): string {
  return path.join(dirForGame(slug), FILENAME);
}

export async function loadOcrProposals(slug: GameSlug): Promise<OcrProposalsFile> {
  try {
    const raw = await readFile(fileForSlug(slug), "utf8");
    const parsed = JSON.parse(raw) as OcrProposalsFile;
    if (parsed?.schemaVersion === 1 && parsed.proposals) return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[ocr-proposals] load failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { schemaVersion: 1, proposals: {} };
}

export async function saveOcrProposals(slug: GameSlug, file: OcrProposalsFile): Promise<void> {
  await ensureDir(slug);
  await writeFile(fileForSlug(slug), JSON.stringify(file, null, 2) + "\n", "utf8");
}

/** Replace the full set of proposals — used by the auto-detector after
 *  each run. Wipes prior proposals for keys the new run produced, but
 *  PRESERVES proposals for keys not in the new run (e.g. a previous run
 *  flagged `freeSpinCounter` and this run skipped it — keep the prior). */
export async function mergeOcrProposals(
  slug: GameSlug,
  next: OcrProposalsFile["proposals"],
): Promise<OcrProposalsFile> {
  const cur = await loadOcrProposals(slug);
  const merged: OcrProposalsFile["proposals"] = { ...cur.proposals, ...next };
  const out: OcrProposalsFile = { schemaVersion: 1, proposals: merged };
  await saveOcrProposals(slug, out);
  return out;
}

/** Remove one proposal — used after QA accepts (moved to ocr-regions.json)
 *  or explicitly rejects it. */
export async function dropOcrProposal(slug: GameSlug, key: keyof OcrProposalsFile["proposals"]): Promise<OcrProposalsFile> {
  const cur = await loadOcrProposals(slug);
  if (!cur.proposals[key]) return cur;
  const next: OcrProposalsFile["proposals"] = { ...cur.proposals };
  delete next[key];
  const out: OcrProposalsFile = { schemaVersion: 1, proposals: next };
  await saveOcrProposals(slug, out);
  return out;
}

// Re-exports for symmetry with the other registry stores (in case future
// callers want the standard load/save/exists trio).
export const ocrProposalsStore = {
  load: loadOcrProposals,
  save: saveOcrProposals,
  exists: async (slug: GameSlug) => {
    // Cheap presence check without using fileExists() (which only knows
    // about REGISTRY_FILES keys). We just attempt a load; non-existent
    // files return the empty default which has zero proposal entries.
    const f = await loadOcrProposals(slug);
    return Object.keys(f.proposals).length > 0;
  },
};

// Suppress unused warnings for utilities that may be imported later.
void loadJson;
void saveJson;
void fileExists;
