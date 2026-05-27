// AI: called only during post-FAIL review (Phase 7.5). 1 Claude call per
// review. Cost ~$0.02-0.05. Output validated against a strict JSON schema
// before returning; AI-side hallucinations rejected at this gate.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { validate as validateSchema, type Schema } from "../registry/schemas/index.js";
import { heuristicClassify } from "./analyzer.js";
import { buildSchemaSummary } from "./schema-summary.js";
import type { Evidence, ReviewResult, RootCauseClassification } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLASSIFICATION_VALUES: RootCauseClassification[] = [
  "real_game_bug", "wrong_registry", "wrong_api_mapping", "wrong_field_mapping",
  "wrong_bet_formula", "wrong_popup_keywords", "wrong_cascade_rule",
  "wrong_assertion", "wrong_test_pacing", "core_logic_bug", "transient",
];

const REVIEW_OUTPUT_SCHEMA: Schema = {
  type: "object",
  required: ["classification", "confidence", "reason"],
  properties: {
    classification: { type: "string", enum: CLASSIFICATION_VALUES },
    confidence: { type: "number", min: 0, max: 1 },
    reason: { type: "string" },
    suggestedPatch: {
      type: "object",
      required: ["file", "operation", "diff"],
      properties: {
        file: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_./-]+\\.(json|yaml)$" },
        operation: { type: "string", enum: ["merge", "replace", "add_alias", "set_field"] },
        diff: { type: "object" },
      },
      nullable: true,
    },
    devNotification: {
      type: "object",
      required: ["severity", "title", "body"],
      properties: {
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        body: { type: "string" },
      },
      nullable: true,
    },
  },
};

let cachedSystemPrompt: string | null = null;

async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const file = path.join(__dirname, "prompts", "classify.md");
  const raw = await readFile(file, "utf8");
  // Splice the live schema reference into the prompt so the AI sees only
  // fields that the Patch Validator actually accepts. Without this the AI
  // hallucinates fields (e.g. `actionPlanHints.spinIdleMaxMs`) → schema
  // validation rejects every suggested patch.
  const schemaSummary = buildSchemaSummary();
  cachedSystemPrompt = `${raw}\n\n---\n\n${schemaSummary}`;
  return cachedSystemPrompt;
}

/**
 * Classify a failure. Strategy:
 *   1. Try heuristic — fast/cheap. If confidence ≥ 0.85, return without AI.
 *   2. Otherwise invoke AI classifier with strict JSON output validation.
 *   3. If AI output fails schema, fall back to transient (low confidence).
 *
 * `opts.skipHeuristic`: bypass step 1 (for testing / forcing full AI review).
 * `opts.dryRun`: return heuristic only, NEVER call AI. Returns null if
 * heuristic can't decide.
 */
export async function classifyFailure(
  evidence: Evidence,
  opts: { skipHeuristic?: boolean; dryRun?: boolean } = {},
): Promise<ReviewResult | null> {
  const start = Date.now();

  // Heuristic fast-path
  if (!opts.skipHeuristic) {
    const h = heuristicClassify(evidence);
    if (h && h.confidence >= 0.85) {
      return {
        classification: h.classification,
        confidence: h.confidence,
        reason: h.reason,
        meta: { durationMs: Date.now() - start },
      };
    }
    if (opts.dryRun) {
      // Heuristic didn't decide and we're not allowed to call AI
      return h ? {
        classification: h.classification,
        confidence: h.confidence,
        reason: h.reason,
        meta: { durationMs: Date.now() - start },
      } : null;
    }
  } else if (opts.dryRun) {
    return null;
  }

  // Full AI classifier
  const system = await loadSystemPrompt();
  const evidenceJson = JSON.stringify(evidence, null, 2);
  let raw: string;
  try {
    raw = await askClaude({
      label: `failure-review/${evidence.caseId.slice(0, 30)}`,
      system,
      content: `Evidence:\n\n${evidenceJson}\n\nReturn JSON classification.`,
      maxTurns: 1,
      timeoutMs: 60_000,
    });
  } catch (err) {
    return {
      classification: "transient",
      confidence: 0.1,
      reason: `AI classifier failed: ${err instanceof Error ? err.message : String(err)}. Rerun the case to confirm whether this is transient.`,
      meta: { durationMs: Date.now() - start },
    };
  }

  const parsed = extractJsonFromText<Record<string, unknown>>(raw);
  if (!parsed) {
    return {
      classification: "transient",
      confidence: 0.1,
      reason: `AI returned non-JSON output. Raw: ${raw.slice(0, 200)}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  const errors = validateSchema(parsed, REVIEW_OUTPUT_SCHEMA);
  if (errors.length > 0) {
    return {
      classification: "transient",
      confidence: 0.1,
      reason: `AI output failed schema validation: ${errors.slice(0, 2).map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      meta: { durationMs: Date.now() - start },
    };
  }

  return {
    classification: parsed.classification as RootCauseClassification,
    confidence: parsed.confidence as number,
    reason: parsed.reason as string,
    suggestedPatch: parsed.suggestedPatch as ReviewResult["suggestedPatch"],
    devNotification: parsed.devNotification as ReviewResult["devNotification"],
    meta: { durationMs: Date.now() - start },
  };
}
