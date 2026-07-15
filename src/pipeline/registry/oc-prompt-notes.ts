// Admin-authored prompt notes keyed by OPERATOR CODE (OC), NOT by game slug.
//
// Games are stored per recordSlug (baseGameSlug_CURRENCY_language), but many
// games share the same operator client skin + the same base template case set
// (stable caseIds). So overrides ("drop the closeButton click", "add a UI-bet
// assertion") are authored ONCE per OC and reused across every game with that OC.
//
// Storage is a global per-OC JSON file at `fixtures/oc-notes/<oc>.json` — this
// is deliberately OUTSIDE the per-game registry (io.ts / paths.ts are slug-keyed).
//
// TWO independent note channels, each hierarchical (OC-wide → category → case):
//   - action:    injected into the TRANSLATE prompt (setup → CaseAction[]).
//   - assertion: injected into the ASSERTION-REVISE prompt (regenerates a case's
//                custom_assertions). Both are applied at Re-translate time.
// resolveNote() concatenates all matching levels so the AI sees the most
// specific guidance last.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseGameUrl } from "../../utils/url.js";

/** One note channel across the three scope levels. */
export type OcNoteLevels = {
  /** Applies to EVERY case under this OC. */
  all?: string;
  /** Applies to every case in a category. Key = TestCaseCategory string. */
  byCategory?: Record<string, string>;
  /** Applies to one specific case. Key = caseId. */
  byCase?: Record<string, string>;
};

export type OcPromptNotes = {
  schemaVersion: 1;
  oc: string;
  /** Notes injected into the translate prompt (changes generated actions). */
  action?: OcNoteLevels;
  /** Notes injected into the assertion-revise prompt (changes custom_assertions). */
  assertion?: OcNoteLevels;
};

const ROOT = path.resolve(process.cwd(), "fixtures", "oc-notes");

/** Sanitize an OC value into a filesystem-safe slug. */
function safeOc(oc: string): string {
  return oc.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 80) || "unknown";
}

/** Read the `oc`/`operator`/`casino` params out of a URL hash fragment
 *  (Playtech puts them after `#`, where URLSearchParams on the query misses them). */
function parseHashOperator(raw: string): string | null {
  const hashIdx = raw.indexOf("#");
  if (hashIdx < 0) return null;
  const frag = raw.slice(hashIdx + 1);
  const params = new URLSearchParams(frag);
  return params.get("oc") ?? params.get("operator") ?? params.get("casino");
}

/**
 * Derive a stable operator key from a game launch URL.
 * Order: query `oc`/`operator` → hash-fragment `oc`/`operator`/`casino` →
 * provider code (e.g. "pp") → "unknown".
 */
export function deriveOcKey(gameUrl: string | null | undefined): string {
  if (!gameUrl) return "unknown";
  try {
    const info = parseGameUrl(gameUrl);
    if (info.operator) return safeOc(info.operator);
    const hashOp = parseHashOperator(gameUrl);
    if (hashOp) return safeOc(hashOp);
    if (info.provider && info.provider !== "??") return safeOc(info.provider);
    return "unknown";
  } catch {
    const hashOp = parseHashOperator(gameUrl);
    return hashOp ? safeOc(hashOp) : "unknown";
  }
}

function fileForOc(oc: string): string {
  return path.join(ROOT, `${safeOc(oc)}.json`);
}

export async function loadOcNotes(oc: string): Promise<OcPromptNotes | null> {
  try {
    const raw = await readFile(fileForOc(oc), "utf8");
    return JSON.parse(raw) as OcPromptNotes;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveOcNotes(oc: string, data: Partial<OcPromptNotes>): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const clean: OcPromptNotes = {
    schemaVersion: 1,
    oc: safeOc(oc),
    action: data.action,
    assertion: data.assertion,
  };
  await writeFile(fileForOc(oc), JSON.stringify(clean, null, 2) + "\n", "utf8");
}

/** Concatenate the matching levels (OC-wide → category → case) of one channel. */
function resolveLevels(levels: OcNoteLevels | undefined, category: string, caseId: string): string {
  if (!levels) return "";
  const parts: string[] = [];
  if (levels.all?.trim()) parts.push(levels.all.trim());
  const cat = levels.byCategory?.[category]?.trim();
  if (cat) parts.push(cat);
  const cs = levels.byCase?.[caseId]?.trim();
  if (cs) parts.push(cs);
  return parts.join("\n");
}

/**
 * Resolve the combined ACTION note for a case (injected into translate prompt).
 * Returns "" when nothing applies (caller keeps default behavior).
 */
export async function resolveTranslateNote(
  oc: string | null | undefined,
  category: string,
  caseId: string,
): Promise<string> {
  if (!oc) return "";
  const notes = await loadOcNotes(oc);
  return resolveLevels(notes?.action, category, caseId);
}

/**
 * Resolve the combined ASSERTION note for a case (injected into the
 * assertion-revise prompt). Returns "" when nothing applies.
 */
export async function resolveAssertionNote(
  oc: string | null | undefined,
  category: string,
  caseId: string,
): Promise<string> {
  if (!oc) return "";
  const notes = await loadOcNotes(oc);
  return resolveLevels(notes?.assertion, category, caseId);
}
