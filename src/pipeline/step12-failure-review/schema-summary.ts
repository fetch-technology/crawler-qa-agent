// Produces a compact, AI-friendly summary of every patchable registry file +
// the fields its schema accepts. Injected into the failure-review system
// prompt so the classifier can't hallucinate field names like
// `actionPlanHints.spinIdleMaxMs` (a real case seen 2026-05-22).
//
// Output format (one block per file):
//
//   FILE: timing-config.json
//   FIELDS:
//     spinResponseTimeoutMs   number  (min 0)
//     postActionSettleMs      number  (min 0)
//     actionTimeoutMs         number  (min 0)
//     ...
//
// Only includes object-typed schemas with declared properties. Recursive
// nested objects are flattened with dot-paths (e.g. "shapeScore.minScore").
// Arrays show item type. Enums/min/max constraints appended inline.
//
// Used by: classify.ts (system-prompt builder).

import { REGISTRY_FILES } from "../registry/paths.js";
import { SCHEMA_BY_KEY, type Schema } from "../registry/schemas/index.js";

type PropertyInfo = {
  path: string;
  type: string;
  constraints: string[];
};

function describeSchema(
  schema: Schema,
  prefix: string,
  out: PropertyInfo[],
  depth = 0,
): void {
  if (depth > 4) return; // safety cap
  if (schema.type !== "object") return;
  const objSchema = schema as {
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
  };
  const props = objSchema.properties ?? {};
  const required = new Set(objSchema.required ?? []);
  for (const [key, sub] of Object.entries(props)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const constraints: string[] = [];
    if (required.has(key)) constraints.push("required");
    if ((sub as { nullable?: boolean }).nullable) constraints.push("nullable");
    if (sub.type === "string") {
      const s = sub as { enum?: string[]; pattern?: string };
      if (s.enum) constraints.push(`enum: ${s.enum.join("|")}`);
      if (s.pattern) constraints.push(`pattern: ${s.pattern}`);
    }
    if (sub.type === "number") {
      const s = sub as { min?: number; max?: number };
      if (s.min !== undefined) constraints.push(`min: ${s.min}`);
      if (s.max !== undefined) constraints.push(`max: ${s.max}`);
    }
    if (sub.type === "object") {
      out.push({ path: fullPath, type: "object", constraints });
      describeSchema(sub, fullPath, out, depth + 1);
    } else if (sub.type === "array") {
      const arrSchema = sub as { items: Schema };
      const itemType = arrSchema.items.type;
      out.push({ path: fullPath, type: `array<${itemType}>`, constraints });
      if (itemType === "object") {
        describeSchema(arrSchema.items, `${fullPath}[]`, out, depth + 1);
      }
    } else {
      out.push({ path: fullPath, type: sub.type, constraints });
    }
  }
  // additionalProperties:Schema = map<string,SubSchema> shape — describe ONE
  // representative entry so AI knows what keys-as-values look like. Used by
  // ui-registry (map elementName → UiElement) and sub-state-hints.
  if (objSchema.additionalProperties && typeof objSchema.additionalProperties === "object") {
    const wildcardPath = prefix ? `${prefix}.<key>` : "<key>";
    out.push({ path: wildcardPath, type: "object  (map: <key> → entry below)", constraints: [] });
    describeSchema(objSchema.additionalProperties, wildcardPath, out, depth + 1);
  }
}

/**
 * Build a text summary of every patchable registry file. Returns a single
 * string ready to splice into a system prompt. Lists the file name and each
 * top-level/nested field name + type + constraints.
 *
 * Caller can pass a specific subset of keys (e.g., only files relevant to
 * the current failure). Default: all schemas in SCHEMA_BY_KEY.
 */
export function buildSchemaSummary(
  keys: string[] = Object.keys(SCHEMA_BY_KEY),
): string {
  const lines: string[] = [];
  lines.push("# Patchable Registry Files — Schema Reference");
  lines.push("");
  lines.push("Each file below is a JSON config under `fixtures/registry/<slug>/`.");
  lines.push("Patches MUST use fields exactly as listed here. Fields not listed");
  lines.push("are rejected by the Patch Validator's JSON Schema gate.");
  lines.push("");

  for (const key of keys) {
    const schema = SCHEMA_BY_KEY[key];
    if (!schema) continue;
    const fileName = (REGISTRY_FILES as Record<string, string>)[key];
    if (!fileName) continue;
    const props: PropertyInfo[] = [];
    describeSchema(schema, "", props);
    if (props.length === 0) continue;
    lines.push(`## ${fileName}`);
    lines.push("FIELDS:");
    for (const p of props) {
      const constraintStr = p.constraints.length > 0 ? `  [${p.constraints.join(", ")}]` : "";
      lines.push(`  ${p.path.padEnd(40)} ${p.type}${constraintStr}`);
    }
    lines.push("");
  }
  // List schema-less files (no patches accepted) — explicit so AI doesn't try.
  const noSchemaFiles = Object.entries(REGISTRY_FILES)
    .filter(([k]) => !SCHEMA_BY_KEY[k])
    .map(([, f]) => f);
  if (noSchemaFiles.length > 0) {
    lines.push("## Files WITHOUT schema (not patchable via review)");
    for (const f of noSchemaFiles) lines.push(`  ${f}`);
    lines.push("");
  }
  return lines.join("\n");
}
