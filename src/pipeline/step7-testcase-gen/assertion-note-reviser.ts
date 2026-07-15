// AI: revise a single case's custom_assertions according to an admin OC-note.
//
// Sibling of case-action-translator.ts. Where that step regenerates ACTIONS
// from setup_instructions, this step regenerates ASSERTIONS from the case's
// current assertions + an admin-authored note (resolved per-OC). Called at
// Re-translate time BEFORE action translation, so the translator sees the
// updated assertions as context.
//
// The AI is free to add, remove, or rewrite check_code to satisfy the note —
// but it must keep every check_code a valid RNG-independent JS expression that
// runs against the same runtime vocab the executor binds (ASSERTION_VARS_DOC).

import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { ASSERTION_VARS_DOC } from "../../ai/test-catalog.js";

export type AssertionItem = { id: string; description: string; check_code: string };

const SYSTEM_PROMPT =
  "You are a QA test automation engineer. You revise the assertion list of ONE "
  + "slot-game test case to satisfy an admin instruction. Output ONLY valid JSON "
  + "(no prose, no markdown fences).";

function buildPrompt(input: {
  caseId: string;
  caseName: string;
  category: string;
  note: string;
  currentAssertions: AssertionItem[];
  gameSpecBlock?: string;
}): string {
  const current = input.currentAssertions.length
    ? JSON.stringify(input.currentAssertions, null, 2)
    : "[] (this case currently has no assertions)";
  return [
    `Case: ${input.caseId}`,
    `Name: ${input.caseName}`,
    `Category: ${input.category}`,
    "",
    "CURRENT custom_assertions:",
    current,
    "",
    input.gameSpecBlock ? "GAME SPEC:\n" + input.gameSpecBlock + "\n" : "",
    "ADMIN INSTRUCTION (apply this exactly to the assertion list):",
    '"""',
    input.note.trim(),
    '"""',
    "",
    ASSERTION_VARS_DOC,
    "",
    "RULES for the revised assertions:",
    "- Return the FULL updated list (keep the ones that should stay, edit/add/remove per the instruction).",
    "- Each check_code is a SINGLE JS expression (no semicolons, no statements) — wrap multi-step logic in an IIFE.",
    "- Keep them RNG-INDEPENDENT: never require a rare/organic event (a win, a free spin) to MUST occur. Use shape/implication invariants.",
    "- Guard numerics against undefined/NaN first (e.g. `typeof spin.betAmount === 'number' && …`).",
    "- For per-spin balance checks, skip when startingBalance is null (`spin.startingBalance == null || …`).",
    "- Keep ids kebab-case and unique within the case.",
    "",
    'Output strict JSON: { "custom_assertions": [ { "id": "...", "description": "...", "check_code": "..." } ] }',
  ].filter(Boolean).join("\n");
}

/**
 * Revise a case's assertions per an admin note. When `note` is empty, returns
 * the current assertions unchanged with aiCalled=false (no AI cost).
 */
export async function reviseAssertionsWithNote(input: {
  caseId: string;
  caseName: string;
  category: string;
  note: string;
  currentAssertions: AssertionItem[];
  gameSpecBlock?: string;
}): Promise<{ assertions: AssertionItem[]; aiCalled: boolean; error?: string }> {
  if (!input.note || input.note.trim().length === 0) {
    return { assertions: input.currentAssertions, aiCalled: false };
  }
  let raw: string;
  try {
    raw = await askClaude({
      content: buildPrompt(input),
      system: SYSTEM_PROMPT,
      label: `assertion-reviser/${input.caseId.slice(0, 30)}`,
      maxTurns: 1,
    });
  } catch (err) {
    return { assertions: input.currentAssertions, aiCalled: true, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = extractJsonFromText<{ custom_assertions?: AssertionItem[] }>(raw);
  if (!parsed || !Array.isArray(parsed.custom_assertions)) {
    return { assertions: input.currentAssertions, aiCalled: true, error: "AI output not parseable / missing custom_assertions" };
  }
  // Keep only well-formed entries; fall back to current list if AI returned nothing usable.
  const revised = parsed.custom_assertions.filter(
    (a) => a && typeof a.id === "string" && a.id.trim() && typeof a.check_code === "string" && a.check_code.trim(),
  ).map((a) => ({
    id: a.id.trim(),
    description: (a.description ?? "").trim(),
    check_code: a.check_code.trim(),
  }));
  if (revised.length === 0) {
    return { assertions: input.currentAssertions, aiCalled: true, error: "AI returned an empty/invalid assertion list — kept current" };
  }
  return { assertions: revised, aiCalled: true };
}
