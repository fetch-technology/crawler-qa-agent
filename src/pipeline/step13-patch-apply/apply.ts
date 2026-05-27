// Patch apply pipeline (Phase 7.6) — given a validated patch, write changes
// to disk + append audit log entry.
//
// Audit log lives at fixtures/registry/<slug>/patches/<ts>-<caseId>.json
// and contains the FULL patch metadata + previous content (for rollback).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "../registry/paths.js";
import type { SuggestedPatch, ReviewResult } from "../step12-failure-review/types.js";
import type { ApplyOutcome, PatchAuditEntry } from "./types.js";

export type ApplyInput = {
  gameSlug: string;
  caseId: string;
  review: ReviewResult;
  patch: SuggestedPatch;
  validation: import("./types.js").ValidationOutcome;
  dryRun: import("./types.js").DryRunOutcome | null;
};

/**
 * Apply a validated patch + write audit log. Assumes validatePatch already
 * passed (caller must check). Returns the audit log path on success.
 */
export async function applyPatch(input: ApplyInput): Promise<ApplyOutcome> {
  const { gameSlug, patch } = input;
  const targetPath = path.join(dirForGame(gameSlug), patch.file);

  // Load existing content for rollback record
  let prevContent: Record<string, unknown> = {};
  try {
    const raw = await readFile(targetPath, "utf8");
    prevContent = JSON.parse(raw);
  } catch {
    // Missing file — first write
  }

  // Compute new content (logic mirrors validator's preview)
  let newContent: Record<string, unknown>;
  switch (patch.operation) {
    case "merge":
      newContent = { ...prevContent, ...patch.diff };
      break;
    case "replace":
      newContent = patch.diff;
      break;
    case "set_field":
      newContent = { ...prevContent };
      for (const [key, val] of Object.entries(patch.diff)) {
        applyDotPath(newContent, key, val);
      }
      break;
    case "add_alias":
      newContent = {
        ...prevContent,
        aliases: { ...(prevContent.aliases as object ?? {}), ...patch.diff },
      };
      break;
    default:
      return { ok: false, patchedFile: targetPath, errors: [`unsupported operation: ${patch.operation}`] };
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify(newContent, null, 2));
  } catch (err) {
    return {
      ok: false,
      patchedFile: targetPath,
      errors: [`write failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Write audit log
  const auditDir = path.join(dirForGame(gameSlug), "patches");
  await mkdir(auditDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeCaseId = input.caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const auditPath = path.join(auditDir, `${timestamp}-${safeCaseId}.json`);

  const entry: PatchAuditEntry = {
    timestamp: new Date().toISOString(),
    caseId: input.caseId,
    classification: input.review.classification,
    confidence: input.review.confidence,
    reason: input.review.reason,
    patch: input.patch,
    validation: input.validation,
    dryRun: input.dryRun,
    applied: true,
    appliedAt: new Date().toISOString(),
    prevContent,
    newContent,
  };
  await writeFile(auditPath, JSON.stringify(entry, null, 2));

  return { ok: true, patchedFile: targetPath, auditLogPath: auditPath, errors: [] };
}

/**
 * Revert a previously-applied patch using its audit log entry. Writes
 * `prevContent` back to the target file. Returns ok=false if audit log
 * missing or rollback fails.
 */
export async function revertPatch(auditLogPath: string): Promise<ApplyOutcome> {
  let entry: PatchAuditEntry;
  try {
    const raw = await readFile(auditLogPath, "utf8");
    entry = JSON.parse(raw);
  } catch (err) {
    return { ok: false, patchedFile: "", errors: [`audit log unreadable: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!entry.applied) return { ok: false, patchedFile: "", errors: ["audit entry not applied — nothing to revert"] };

  // Reverse-resolve: we know the original applied to <slug>/<patch.file>.
  // Audit dir is fixtures/registry/<slug>/patches/, so file lives at:
  const slugDir = path.dirname(path.dirname(auditLogPath));
  const targetPath = path.join(slugDir, entry.patch.file);
  try {
    await writeFile(targetPath, JSON.stringify(entry.prevContent ?? {}, null, 2));
  } catch (err) {
    return { ok: false, patchedFile: targetPath, errors: [`revert write failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return { ok: true, patchedFile: targetPath, errors: [] };
}

function applyDotPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let obj: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};
    obj = obj[key] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]!] = value;
}
