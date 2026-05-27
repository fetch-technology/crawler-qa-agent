// Persist a learned signature into game-mechanics adjacent state-signatures.json
// (Phase 8.5). Goes through Patch Validator gates from Phase 7.6.

import { stateSignatures } from "../registry/state-signatures.js";
import type { StateSignatures } from "../registry/types.js";
import type { LearnedSignature } from "./learner.js";

/** Result of attempting to persist a learned signature. */
export type PersistOutcome = {
  ok: boolean;
  reason?: string;
  /** Final merged signatures map after save (or current if failed). */
  signatures?: StateSignatures;
};

/**
 * Save a learned signature into state-signatures.json. Refuses to overwrite
 * existing entries with high confidence — caller must explicitly pass
 * `overwrite: true` to replace.
 */
export async function persistSignature(
  gameSlug: string,
  learned: LearnedSignature,
  opts: { overwrite?: boolean; minConfidence?: number; confidence: number } = { confidence: 0 },
): Promise<PersistOutcome> {
  const minConf = opts.minConfidence ?? 0.7;
  if (opts.confidence < minConf) {
    return {
      ok: false,
      reason: `confidence ${opts.confidence} below threshold ${minConf}; not persisting`,
    };
  }

  const existing = (await stateSignatures.load(gameSlug)) ?? {};
  const key = learned.state as keyof StateSignatures;
  if ((existing as Record<string, unknown>)[key] && !opts.overwrite) {
    return {
      ok: false,
      reason: `signature for state "${learned.state}" already exists; pass overwrite=true to replace`,
      signatures: existing,
    };
  }

  // Schema requires StateSignature = ocr|template form. Map learned to OCR variant.
  const newSignature = {
    kind: "ocr" as const,
    text: learned.ocrAll?.[0] ?? learned.ocrAny[0] ?? "",
    region: { x: 0, y: 0, w: 0, h: 0 },
  };
  const merged = { ...existing, [key]: newSignature };
  await stateSignatures.save(gameSlug, merged as StateSignatures);
  return { ok: true, signatures: merged as StateSignatures };
}
