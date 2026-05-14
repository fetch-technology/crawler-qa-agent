import type { ExecutionStrategy } from "./authoring.js";

export type PreflightResult = {
  ok: boolean;
  errors: PreflightFailure[];
  warnings: PreflightFailure[];
};

export type PreflightFailure = {
  id: string;
  description: string;
  rule: string;
  observed: string;
  severity: "error" | "warning";
};

/**
 * Chạy preflight rules từ execution_strategy.field_validation + preflight_checks
 * trên samples đã normalize. Trả về danh sách failure với evidence cụ thể.
 *
 * Dùng ở cuối Phase A (sau understandGameRules trả spec) để fail-fast nếu
 * network-detect chọn sai endpoint (vd fortune-pig: wallet snapshot all-zero).
 */
export function runExecutionPreflight(
  strategy: ExecutionStrategy,
  normalizedSamples: unknown[],
): PreflightResult {
  const errors: PreflightFailure[] = [];
  const warnings: PreflightFailure[] = [];

  if (!Array.isArray(normalizedSamples) || normalizedSamples.length === 0) {
    errors.push({
      id: "no_samples",
      description: "Không có spin samples nào để preflight",
      rule: "sample_count_min",
      observed: "0 samples",
      severity: "error",
    });
    return { ok: false, errors, warnings };
  }

  const samples = normalizedSamples as Record<string, unknown>[];

  // Fields được coi là CRITICAL — required missing trên field này sẽ là ERROR.
  // Các field khác AI có thể over-specify → downgrade thành warning.
  const CRITICAL_FIELDS = new Set([
    "betAmount", "winAmount", "endingBalance", "startingBalance",
    "balance", "totalBet", "totalWin",
  ]);

  // 1. field_validation — required + type + min/max
  for (const fv of strategy.field_validation ?? []) {
    let missingCount = 0;
    let typeMismatchCount = 0;
    let minViolations = 0;
    const observed: unknown[] = [];
    for (const s of samples) {
      const v = s?.[fv.field];
      observed.push(v);
      if (v === undefined || v === null) {
        if (fv.required && !fv.nullable) missingCount++;
        continue;
      }
      // typeof [] === "object" → tách "array" và "object" riêng để check chính xác.
      // LENIENT: AI có thể đã sinh expected="object" cho field thực sự là array
      // (do prompt cũ chưa document "array" — vẫn coi là pass để backward-compat
      // với spec cũ của các game Pragmatic).
      const actualType = Array.isArray(v) ? "array" : typeof v;
      const matches = actualType === fv.type || (fv.type === "object" && actualType === "array");
      if (!matches) typeMismatchCount++;
      if (fv.type === "number" && typeof v === "number") {
        if (fv.min != null && v < fv.min) minViolations++;
        if (fv.max != null && v > fv.max) minViolations++;
      }
    }
    if (missingCount > 0) {
      // CRITICAL field missing in 100% samples → có khả năng cao endpoint sai (hard error).
      // Non-critical missing 100% → AI có thể đã over-specify → downgrade warning.
      // Partial missing (1<n<all) → ERROR (genuine inconsistency).
      const isCritical = CRITICAL_FIELDS.has(fv.field);
      const allMissing = missingCount === samples.length;
      const target = !isCritical && allMissing ? warnings : errors;
      const severity: "error" | "warning" = !isCritical && allMissing ? "warning" : "error";
      target.push({
        id: `field_required:${fv.field}`,
        description: allMissing && !isCritical
          ? `Field "${fv.field}" missing in ALL ${samples.length} samples — AI có thể over-specify required (field này không có trong response shape thực tế của game).`
          : `Required field "${fv.field}" missing in ${missingCount}/${samples.length} samples`,
        rule: `field_validation.required`,
        observed: `values: ${JSON.stringify(observed.slice(0, 5))}`,
        severity,
      });
    }
    if (typeMismatchCount > 0) {
      errors.push({
        id: `field_type:${fv.field}`,
        description: `Field "${fv.field}" wrong type (expected ${fv.type}) in ${typeMismatchCount}/${samples.length} samples`,
        rule: `field_validation.type`,
        observed: `values: ${truncateJson(observed.slice(0, 3), 300)}`,
        severity: "error",
      });
    }
    if (minViolations > 0) {
      warnings.push({
        id: `field_range:${fv.field}`,
        description: `Field "${fv.field}" out of [${fv.min ?? "-∞"}, ${fv.max ?? "+∞"}] in ${minViolations}/${samples.length} samples`,
        rule: `field_validation.min/max`,
        observed: `values: ${JSON.stringify(observed.slice(0, 5))}`,
        severity: "warning",
      });
    }
  }

  // 2. preflight_checks — AI-defined rules
  for (const check of strategy.preflight_checks ?? []) {
    const result = evaluateRule(check.rule, samples);
    if (!result.ok) {
      const failure: PreflightFailure = {
        id: check.id,
        description: check.description,
        rule: `${check.rule.kind}(${JSON.stringify(check.rule.args)})`,
        observed: result.observed,
        severity: result.severity,
      };
      if (result.severity === "error") errors.push(failure);
      else warnings.push(failure);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

type RuleResult = { ok: boolean; observed: string; severity: "error" | "warning" };

function evaluateRule(
  rule: { kind: string; args: Record<string, unknown> },
  samples: Record<string, unknown>[],
): RuleResult {
  const args = rule.args ?? {};

  switch (rule.kind) {
    case "all_samples_field_nonzero": {
      const field = String(args.field);
      const values = samples.map((s) => s?.[field]);
      // OK nếu CÓ ÍT NHẤT 1 sample có field !== 0 (có nghĩa là endpoint thực sự là spin, không phải wallet snapshot luôn 0)
      const anyNonZero = values.some((v) => typeof v === "number" && v !== 0);
      if (anyNonZero) return { ok: true, observed: "", severity: "error" };
      return {
        ok: false,
        observed: `field "${field}" === 0 in ALL ${samples.length} samples → endpoint có thể là wallet snapshot, không phải spin response. Values: ${JSON.stringify(values)}`,
        severity: "error",
      };
    }

    case "any_sample_field_present": {
      const field = String(args.field);
      const present = samples.some((s) => s?.[field] !== undefined && s?.[field] !== null);
      if (present) return { ok: true, observed: "", severity: "error" };
      return {
        ok: false,
        observed: `field "${field}" missing in ALL ${samples.length} samples`,
        severity: "warning",
      };
    }

    case "samples_field_varies": {
      const field = String(args.field);
      const values = samples.map((s) => s?.[field]).filter((v) => v !== undefined && v !== null);
      if (values.length < 2) {
        return {
          ok: false,
          observed: `field "${field}" has < 2 non-null values; cannot check variance`,
          severity: "warning",
        };
      }
      const unique = new Set(values.map((v) => JSON.stringify(v)));
      if (unique.size > 1) return { ok: true, observed: "", severity: "warning" };
      return {
        ok: false,
        observed: `field "${field}" identical in all ${samples.length} samples (${JSON.stringify([...unique][0])}) → maybe snapshot, not spin result`,
        severity: "warning",
      };
    }

    case "field_type": {
      const field = String(args.field);
      const expected = String(args.expected);
      const wrong: unknown[] = [];
      for (const s of samples) {
        const v = s?.[field];
        if (v === undefined || v === null) wrong.push(v);
        else {
          const actualType = Array.isArray(v) ? "array" : typeof v;
          // Lenient: expected="object" cũng accept array (typeof [] cũ === "object")
          const matches = actualType === expected || (expected === "object" && actualType === "array");
          if (!matches) wrong.push(v);
        }
      }
      if (wrong.length === 0) return { ok: true, observed: "", severity: "error" };
      return {
        ok: false,
        observed: `field "${field}" wrong type (expected ${expected}) in ${wrong.length}/${samples.length} samples. Values: ${truncateJson(wrong.slice(0, 3), 300)}`,
        severity: "error",
      };
    }

    case "sample_count_min": {
      const min = Number(args.count ?? 1);
      if (samples.length >= min) return { ok: true, observed: "", severity: "error" };
      return {
        ok: false,
        observed: `Only ${samples.length} samples, need ≥${min}`,
        severity: "error",
      };
    }

    // AI thường sinh kind này — equals/in (giá trị enum như status="RESOLVED")
    case "field_equals": {
      const field = String(args.field);
      const expected = args.value ?? args.expected;
      const wrong: unknown[] = [];
      for (const s of samples) {
        const v = s?.[field];
        if (v !== expected) wrong.push(v);
      }
      if (wrong.length === 0) return { ok: true, observed: "", severity: "warning" };
      return {
        ok: false,
        observed: `field "${field}" !== ${JSON.stringify(expected)} in ${wrong.length}/${samples.length} samples. Values: ${JSON.stringify(wrong.slice(0, 5))}`,
        severity: "warning", // hay-thay-đổi field như status — chỉ warn
      };
    }

    case "field_in": {
      const field = String(args.field);
      const allowed = (args.values ?? args.in ?? []) as unknown[];
      const allowedSet = new Set(allowed.map((v) => JSON.stringify(v)));
      const wrong: unknown[] = [];
      for (const s of samples) {
        const v = s?.[field];
        if (!allowedSet.has(JSON.stringify(v))) wrong.push(v);
      }
      if (wrong.length === 0) return { ok: true, observed: "", severity: "warning" };
      return {
        ok: false,
        observed: `field "${field}" not in ${JSON.stringify(allowed)} for ${wrong.length}/${samples.length} samples. Values: ${JSON.stringify(wrong.slice(0, 5))}`,
        severity: "warning",
      };
    }

    case "field_array_nonempty": {
      const field = String(args.field);
      const empty: unknown[] = [];
      for (const s of samples) {
        const v = s?.[field];
        if (!Array.isArray(v) || v.length === 0) empty.push(v);
      }
      if (empty.length === 0) return { ok: true, observed: "", severity: "error" };
      return {
        ok: false,
        observed: `field "${field}" not a non-empty array in ${empty.length}/${samples.length} samples`,
        severity: "error",
      };
    }

    default:
      return {
        ok: false,
        observed: `Unknown rule kind "${rule.kind}" — skipped (not implemented in preflight)`,
        severity: "warning",
      };
  }
}

/** Truncate deep JSON for log display — tránh dump 5KB matrix data. */
function truncateJson(value: unknown, maxLen: number): string {
  const str = JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "…[truncated]";
}

/** Format human-readable summary cho stdout/log. */
export function formatPreflightResult(result: PreflightResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(`[preflight] ✔ all checks passed (${result.warnings.length} warnings)`);
  } else {
    lines.push(`[preflight] ✗ ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  }
  for (const e of result.errors) {
    lines.push(`  ✗ ERROR  ${e.id} — ${e.description}`);
    lines.push(`           rule: ${e.rule}`);
    lines.push(`           observed: ${e.observed}`);
  }
  for (const w of result.warnings) {
    lines.push(`  ⚠ WARN   ${w.id} — ${w.description}`);
    lines.push(`           observed: ${w.observed}`);
  }
  return lines.join("\n");
}
