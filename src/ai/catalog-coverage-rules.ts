import type { GameSpec } from "./authoring.js";
import type { TestCase, TestCaseCatalog } from "./test-catalog.js";
import type { ValidationIssue } from "./catalog-validator.js";

type OptionEntry = { name: string; category?: string; type?: string };

type CoverageContext = {
  spec: GameSpec;
  options: OptionEntry[];
  catalog: TestCaseCatalog;
};

type CoverageRule = {
  id: string;
  description: string;
  severity: "error" | "warning";
  when: (ctx: CoverageContext) => boolean;
  expect: (ctx: CoverageContext) => boolean;
};

function hasFeature(spec: GameSpec, pattern: RegExp): boolean {
  return (spec.features ?? []).some((f) => pattern.test(f.name ?? ""));
}

function hasInvariant(spec: GameSpec, id: string): boolean {
  return (spec.invariants ?? []).some((i) => i.id === id);
}

function hasOption(options: OptionEntry[], pattern: RegExp): boolean {
  return options.some((o) => pattern.test(o.name ?? ""));
}

function casesByCategory(catalog: TestCaseCatalog, category: TestCase["category"]): TestCase[] {
  return catalog.cases.filter((c) => c.category === category);
}

function hasWildSymbol(spec: GameSpec): boolean {
  return (spec.symbols ?? []).some((s) => s.type === "WILD");
}

const RULES: CoverageRule[] = [
  {
    id: "base-game-required",
    description: "Every catalog must have base_game cases",
    severity: "error",
    when: () => true,
    expect: (ctx) => casesByCategory(ctx.catalog, "base_game").length >= 1,
  },
  {
    id: "ui-consistency-required",
    description: "Every catalog must have at least 2 ui_consistency cases (balance + bet display checks)",
    severity: "warning",
    when: () => true,
    expect: (ctx) => casesByCategory(ctx.catalog, "ui_consistency").length >= 2,
  },
  // ---- Advanced patterns (Best Practices §18) ----
  {
    id: "rules-consistency-required",
    description: "Every catalog must have ≥1 rules_consistency case (symbol mapping check spec ↔ paytable ↔ config — Best Practices §18.1)",
    severity: "warning",
    when: () => true,
    expect: (ctx) => casesByCategory(ctx.catalog, "rules_consistency").length >= 1,
  },
  {
    id: "payout-correctness-required",
    description: "Every catalog must have ≥1 payout_correctness case (verify winAmount = paytable formula per winline — Best Practices §18.2). CRITICAL gap if missing.",
    severity: "warning",
    when: () => true,
    expect: (ctx) => casesByCategory(ctx.catalog, "payout_correctness").length >= 1,
  },
  {
    id: "wild-substitution-when-wild-exists",
    description: "Spec has WILD symbol → expect ≥1 wild_substitution case (Best Practices §18.3)",
    severity: "warning",
    when: (ctx) => hasWildSymbol(ctx.spec),
    expect: (ctx) => casesByCategory(ctx.catalog, "wild_substitution").length >= 1,
  },
  {
    id: "free-spins-split-when-feature",
    description: "Spec mentions Free Spins → expect ≥2 free_spins cases (trigger watch + result shape — Best Practices §18.4)",
    severity: "warning",
    when: (ctx) => hasFeature(ctx.spec, /free.?spin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "free_spins").length >= 2,
  },
  {
    id: "respin-split-when-feature",
    description: "Spec mentions Respin → expect ≥2 respin cases (trigger watch + result multiplier — Best Practices §18.5)",
    severity: "warning",
    when: (ctx) => hasFeature(ctx.spec, /respin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "respin").length >= 2,
  },
  {
    id: "history-split-when-option-and-freespin",
    description: "Options has History AND spec has free_spins → expect ≥2 history cases (normal + freespin row — Best Practices §18.6)",
    severity: "warning",
    when: (ctx) =>
      hasOption(ctx.options, /history|rounds/i) && hasFeature(ctx.spec, /free.?spin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "history").length >= 2,
  },
  {
    id: "bet-boundary-required",
    description: "Every catalog must have ≥2 bet_boundary cases (above max + below min — Best Practices §18.7)",
    severity: "warning",
    when: () => true,
    expect: (ctx) => casesByCategory(ctx.catalog, "bet_boundary").length >= 2,
  },
  {
    id: "bet-variation-when-multiple-sizes",
    description: "When bet_sizes has >1 entry, expect ≥3 bet_variation cases (min/mid/max coverage)",
    severity: "warning",
    when: (ctx) => (ctx.spec.bet_mechanics?.bet_sizes?.length ?? 0) > 1,
    expect: (ctx) => casesByCategory(ctx.catalog, "bet_variation").length >= 3,
  },
  {
    id: "free-spins-when-feature",
    description: "Spec mentions Free Spins → expect ≥1 free_spins case (organic watch is fine)",
    severity: "warning",
    when: (ctx) => hasFeature(ctx.spec, /free.?spin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "free_spins").length >= 1,
  },
  {
    id: "max-win-cap-when-invariant",
    description: "Spec has max_win_cap invariant → expect a max_win_cap case",
    severity: "warning",
    when: (ctx) => hasInvariant(ctx.spec, "max_win_cap"),
    expect: (ctx) => casesByCategory(ctx.catalog, "max_win_cap").length >= 1,
  },
  {
    id: "autoplay-when-option",
    description: "Options catalog has Autoplay control → expect ≥1 autoplay case",
    severity: "warning",
    when: (ctx) => hasOption(ctx.options, /auto.?play|auto.?spin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "autoplay").length >= 1,
  },
  {
    id: "turbo-when-option",
    description: "Options catalog has Turbo/Quick Spin → expect ≥1 turbo_spin case",
    severity: "warning",
    when: (ctx) => hasOption(ctx.options, /turbo|quick.?spin/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "turbo_spin").length >= 1,
  },
  {
    id: "history-when-option",
    description: "Options catalog has History panel → expect ≥1 history case",
    severity: "warning",
    when: (ctx) => hasOption(ctx.options, /history|rounds/i),
    expect: (ctx) => casesByCategory(ctx.catalog, "history").length >= 1,
  },
  {
    id: "options-when-toggles-exist",
    description: "Options catalog has audio/display toggles → expect ≥1 options case",
    severity: "warning",
    when: (ctx) => ctx.options.some((o) => o.category === "audio" || o.category === "display"),
    expect: (ctx) => casesByCategory(ctx.catalog, "options").length >= 1,
  },
];

export function evaluateCoverage(args: {
  catalog: TestCaseCatalog;
  spec: GameSpec;
  optionsJson: string | null;
}): ValidationIssue[] {
  const options = parseOptions(args.optionsJson);
  const ctx: CoverageContext = { spec: args.spec, options, catalog: args.catalog };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) {
    if (!rule.when(ctx)) continue;
    if (rule.expect(ctx)) continue;
    issues.push({
      severity: rule.severity,
      rule: `coverage:${rule.id}`,
      case_id: null,
      message: rule.description,
    });
  }
  return issues;
}

function parseOptions(optionsJson: string | null): OptionEntry[] {
  if (!optionsJson) return [];
  try {
    const parsed = JSON.parse(optionsJson) as { options?: OptionEntry[] };
    if (Array.isArray(parsed?.options)) return parsed.options;
    return [];
  } catch {
    return [];
  }
}
