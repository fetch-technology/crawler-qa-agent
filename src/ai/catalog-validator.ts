import type { GameSpec } from "./authoring.js";
import type { TestCase, TestCaseCatalog } from "./test-catalog.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  rule: string;
  case_id: string | null;
  message: string;
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

const ALLOWED_TOP_LEVEL_IDENTIFIERS = new Set<string>([
  "spin",
  "collector",
  "screen",
  "balanceBefore",
  "spinIndex",
  "detectBuyFeatureDeduction",
  "getRoundEndSpins",
  "getCurrentBalance",
  "Math",
  "Number",
  "Array",
  "Object",
  "JSON",
  "String",
  "Boolean",
  "Set",
  "Map",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "NaN",
  "Infinity",
  "void",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
]);

// Provider-internal raw fields — cấm reference từ check_code.
// Note: \`multiplier\`, \`winFreeSpins\`, \`freeSpins\`, \`totalWinFreeSpin\`,
// \`isFreeSpin\`, \`isEndRound\`, \`bracket\`, \`isMaxWin\`, \`isMaxCap\` đều là
// normalized top-level fields — KHÔNG block.
const FORBIDDEN_PROPERTY_NAMES = new Set<string>([
  "_raw",
  "tw",
  "w",
  "c",
  "sa",
  "sb",
]);

const FORBIDDEN_TOP_LEVEL = new Set<string>([
  "eval",
  "Function",
  "require",
  "process",
  "global",
  "globalThis",
  "import",
  "module",
  "exports",
  "__dirname",
  "__filename",
]);

function stripStringsAndComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if ((ch === "'" || ch === '"' || ch === "`") ) {
      const quote = ch;
      out += " ";
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
        } else {
          out += " ";
          i++;
        }
      }
      out += " ";
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

type IdentifierUse = {
  name: string;
  index: number;
  isProperty: boolean;
};

function collectArrowBindings(stripped: string): Set<string> {
  const bindings = new Set<string>();
  for (const m of stripped.matchAll(/\b([a-zA-Z_$][\w$]*)\s*=>/g)) {
    bindings.add(m[1] as string);
  }
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) {
    const inside = m[1] as string;
    for (const part of inside.split(",")) {
      const trimmed = part.trim().split(/[\s=:]/)[0] ?? "";
      if (/^[a-zA-Z_$][\w$]*$/.test(trimmed)) bindings.add(trimmed);
    }
  }
  return bindings;
}

function extractIdentifiers(code: string): { ids: IdentifierUse[]; bindings: Set<string> } {
  const stripped = stripStringsAndComments(code);
  const bindings = collectArrowBindings(stripped);
  const out: IdentifierUse[] = [];
  const re = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const start = m.index;
    let prevIdx = start - 1;
    while (prevIdx >= 0 && /\s/.test(stripped[prevIdx] ?? "")) prevIdx--;
    const prevCh = prevIdx >= 0 ? stripped[prevIdx] ?? "" : "";
    if (/[\w$]/.test(prevCh)) continue;
    const isProperty = prevCh === ".";
    out.push({ name: m[0], index: start, isProperty });
  }
  return { ids: out, bindings };
}

function validateExpressionSyntax(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return "empty expression";
  // Wrap in parens to force expression context. Statement-only constructs
  // (if/for/while/var/let/const at top level, bare semicolons, etc.) will
  // fail to parse here. Regex literals like /^[A-Z]{26}$/, object literals
  // like {a:1}, IIFEs like (()=>{...})() are all valid expressions.
  try {
    const fn = new Function(`return (${trimmed});`);
    void fn;
    return null;
  } catch (err) {
    return `syntax error: ${(err as Error).message}`;
  }
}

function validateCheckCodeIdentifiers(code: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { ids, bindings } = extractIdentifiers(code);
  const seenWarnings = new Set<string>();
  for (const u of ids) {
    if (u.isProperty) {
      if (FORBIDDEN_PROPERTY_NAMES.has(u.name)) {
        errors.push(
          `forbidden property access: .${u.name} (must not reference _raw or provider-specific normalized fields)`,
        );
      }
      continue;
    }
    if (FORBIDDEN_TOP_LEVEL.has(u.name)) {
      errors.push(`forbidden global identifier: ${u.name}`);
      continue;
    }
    if (/^\d/.test(u.name)) continue;
    if (ALLOWED_TOP_LEVEL_IDENTIFIERS.has(u.name)) continue;
    if (bindings.has(u.name)) continue;
    if (/^[A-Z][a-zA-Z]*Error$/.test(u.name)) continue;
    if (seenWarnings.has(u.name)) continue;
    seenWarnings.add(u.name);
    warnings.push(`unrecognized top-level identifier: ${u.name}`);
  }
  return { errors, warnings };
}

const CATEGORY_CONTRACTS: Array<{
  category: TestCase["category"];
  setupRequired: RegExp[];
  expectedFeatureRequired: boolean;
  assertionMustReferenceScreen?: boolean;
}> = [
  {
    category: "buy_feature",
    setupRequired: [/buy|purchase/i, /confirm|click|select/i],
    expectedFeatureRequired: true,
  },
  {
    category: "autoplay",
    setupRequired: [/autoplay|auto.?spin/i, /start|begin|press/i],
    expectedFeatureRequired: false,
  },
  {
    category: "ui_consistency",
    setupRequired: [],
    expectedFeatureRequired: false,
    assertionMustReferenceScreen: true,
  },
  {
    // Best Practices §18.7 — bet_boundary case phải mention "max" hoặc "min" + verify clamp
    category: "bet_boundary",
    setupRequired: [/max|min|above|below|overshoot|undershoot/i, /verify|assert|reject|clamp/i],
    expectedFeatureRequired: false,
  },
];

function validateCategoryContract(c: TestCase): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const contract = CATEGORY_CONTRACTS.find((x) => x.category === c.category);
  if (!contract) return issues;
  const setup = c.setup_instructions ?? "";
  for (const re of contract.setupRequired) {
    if (!re.test(setup)) {
      issues.push({
        severity: "error",
        rule: "category-contract-setup",
        case_id: c.id,
        message: `category="${c.category}" but setup_instructions missing required pattern ${re}`,
      });
    }
  }
  if (contract.expectedFeatureRequired && (c.expected_feature == null || c.expected_feature === "")) {
    issues.push({
      severity: "error",
      rule: "category-contract-expected-feature",
      case_id: c.id,
      message: `category="${c.category}" requires expected_feature to be set (got null/empty)`,
    });
  }
  if (contract.assertionMustReferenceScreen) {
    const refsScreen = (c.custom_assertions ?? []).some((a) => /\bscreen\b/.test(a.check_code));
    if (!refsScreen) {
      issues.push({
        severity: "warning",
        rule: "ui-consistency-needs-screen",
        case_id: c.id,
        message: `category="ui_consistency" but no custom_assertions reference \`screen\``,
      });
    }
  }
  return issues;
}

function validateInvariantIds(c: TestCase, knownIds: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const id of c.invariant_ids ?? []) {
    if (!knownIds.has(id)) {
      issues.push({
        severity: "error",
        rule: "unknown-invariant-id",
        case_id: c.id,
        message: `invariant_id "${id}" not found in gameSpec.invariants`,
      });
    }
  }
  return issues;
}

function validateUniqueIds(cases: TestCase[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  for (const c of cases) {
    seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push({
        severity: "error",
        rule: "duplicate-case-id",
        case_id: id,
        message: `case id "${id}" appears ${count} times — ids must be unique`,
      });
    }
  }
  return issues;
}

function validateAssertions(c: TestCase): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  for (const a of c.custom_assertions ?? []) {
    if (seenIds.has(a.id)) {
      issues.push({
        severity: "error",
        rule: "duplicate-assertion-id",
        case_id: c.id,
        message: `assertion id "${a.id}" duplicated within case`,
      });
    }
    seenIds.add(a.id);
    const syntaxError = validateExpressionSyntax(a.check_code);
    if (syntaxError) {
      issues.push({
        severity: "error",
        rule: "assertion-syntax",
        case_id: c.id,
        message: `assertion "${a.id}": ${syntaxError}`,
      });
      continue;
    }
    const idCheck = validateCheckCodeIdentifiers(a.check_code);
    for (const e of idCheck.errors) {
      issues.push({
        severity: "error",
        rule: "assertion-identifier",
        case_id: c.id,
        message: `assertion "${a.id}": ${e}`,
      });
    }
    for (const w of idCheck.warnings) {
      issues.push({
        severity: "warning",
        rule: "assertion-identifier",
        case_id: c.id,
        message: `assertion "${a.id}": ${w}`,
      });
    }

    // RNG-independence guard: assertion must not require a rare event to occur
    // inside finite spins (except deterministic buy_feature flows).
    if (c.category !== "buy_feature") {
      const code = a.check_code;
      const requireFsObserved =
        /collector\.spins\.some\(\s*s\s*=>\s*s\.isFreeSpin\s*===\s*true\s*\)/.test(code) ||
        /collector\.spins\.filter\([^)]*isFreeSpin[^)]*\)\.length\s*>\s*0/.test(code);
      if (requireFsObserved) {
        issues.push({
          severity: "error",
          rule: "assertion-rng-dependent",
          case_id: c.id,
          message:
            `assertion "${a.id}": requires free-spin event to occur. Use implication/shape invariant instead (e.g. filter(...).every(...)).`,
        });
      }

      const requireWinObserved =
        /collector\.spins\.some\([^)]*winAmount[^)]*>\s*0/.test(code) ||
        /collector\.spins\.filter\([^)]*winAmount[^)]*>\s*0[^)]*\)\.length\s*>\s*0/.test(code);
      if (requireWinObserved) {
        issues.push({
          severity: "error",
          rule: "assertion-rng-dependent",
          case_id: c.id,
          message:
            `assertion "${a.id}": requires winning event to occur. Replace with non-RNG invariant (types/ranges/conservation/implication).`,
        });
      }
    }
  }
  return issues;
}

export function validateCatalog(catalog: TestCaseCatalog, gameSpec: GameSpec): ValidationReport {
  const knownIds = new Set(gameSpec.invariants.map((i) => i.id));
  const issues: ValidationIssue[] = [];
  issues.push(...validateUniqueIds(catalog.cases));
  for (const c of catalog.cases) {
    issues.push(...validateInvariantIds(c, knownIds));
    issues.push(...validateCategoryContract(c));
    issues.push(...validateAssertions(c));
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  if (report.errors.length > 0) {
    lines.push(`✘ ${report.errors.length} error(s):`);
    for (const e of report.errors) {
      lines.push(`  - [${e.rule}] ${e.case_id ?? "<global>"}: ${e.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push(`⚠ ${report.warnings.length} warning(s):`);
    for (const w of report.warnings) {
      lines.push(`  - [${w.rule}] ${w.case_id ?? "<global>"}: ${w.message}`);
    }
  }
  if (report.ok && report.warnings.length === 0) lines.push("✔ catalog passed validation cleanly");
  return lines.join("\n");
}

export function buildValidationFeedback(report: ValidationReport): string {
  if (report.ok && report.warnings.length === 0) return "";
  const items: string[] = [];
  for (const e of report.errors) {
    items.push(`- ERROR [${e.rule}] case=${e.case_id ?? "n/a"}: ${e.message}`);
  }
  for (const w of report.warnings.slice(0, 5)) {
    items.push(`- WARN [${w.rule}] case=${w.case_id ?? "n/a"}: ${w.message}`);
  }
  return items.join("\n");
}
