import type { GameSpec, Invariant } from "./authoring.js";
import type { TestCase, TestCaseCatalog } from "./test-catalog.js";
import type { ValidationReport } from "./catalog-validator.js";

const CATEGORY_LABELS: Record<string, string> = {
  base_game: "Base Game",
  bet_variation: "Bet Variation",
  bet_level: "Bet Level",
  bet_boundary: "Bet Boundary (min/max guard)",
  autoplay: "Autoplay",
  buy_feature: "Buy Feature",
  special_bet: "Special Bet",
  turbo_spin: "Turbo Spin",
  free_spins: "Free Spins",
  respin: "Respin",
  history: "History",
  options: "Options",
  max_win_cap: "Max Win Cap",
  ui_consistency: "UI Consistency",
  rules_consistency: "Rules Consistency (symbol mapping)",
  payout_correctness: "Payout Correctness (paytable formula)",
  wild_substitution: "Wild Substitution",
  other: "Other",
};

const SEV_BADGE: Record<string, string> = {
  critical: "🔴 critical",
  major: "🟠 major",
  minor: "⚪ minor",
};

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * RFC 4180 CSV escape: wrap field in `"..."`, double inner `"`. Newlines OK
 * inside quoted fields — Excel/Sheets render them as line breaks.
 */
function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function joinSteps(setup: string): string {
  if (!setup || !setup.trim()) return "";
  const stepRegex = /Step\s*\d+\s*:\s*([^]*?)(?=Step\s*\d+\s*:|$)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = stepRegex.exec(setup)) !== null) {
    const body = (m[1] ?? "").trim().replace(/[.\s]+$/, "");
    if (body) out.push(`${++i}. ${body}.`);
  }
  if (out.length > 0) return out.join("\n");
  return setup
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s, idx) => `${idx + 1}. ${s.trim()}`)
    .join("\n");
}

function joinExpects(c: TestCase, invariants: Invariant[]): string {
  const invMap = new Map(invariants.map((i) => [i.id, i]));
  const ids = c.invariant_ids ?? [];
  const lines: string[] = [];
  let resolved: Invariant[];
  if (ids.length === 0) {
    resolved = invariants.filter(
      (i) => i.severity === "critical" || (i.severity as string) === "high" || i.severity === "major",
    );
  } else {
    resolved = ids.map((id) => invMap.get(id)).filter((x): x is Invariant => Boolean(x));
  }
  for (const inv of resolved) {
    lines.push(`[invariant:${inv.severity}] ${inv.id} — ${inv.description}`);
  }
  for (const a of c.custom_assertions ?? []) {
    lines.push(`[custom] ${a.id} — ${a.description || "(no description)"} | check: ${a.check_code}`);
  }
  return lines.join("\n");
}

function splitSteps(setup: string): string[] {
  if (!setup || !setup.trim()) return [];
  // Format mới: "Step 1: ... Step 2: ... Step N: ..."
  const stepRegex = /Step\s*\d+\s*:\s*([^]*?)(?=Step\s*\d+\s*:|$)/gi;
  const steps: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = stepRegex.exec(setup)) !== null) {
    const body = (m[1] ?? "").trim().replace(/[.\s]+$/, "");
    if (body) steps.push(body);
  }
  if (steps.length > 0) return steps;
  // Fallback: split câu (sentence)
  return setup
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function inputsBlock(c: TestCase): string {
  const rows: string[] = [];
  if (c.expected_bet != null) rows.push(`| expected_bet | \`${c.expected_bet}\` |`);
  if (c.expected_config && Object.keys(c.expected_config).length) {
    for (const [k, v] of Object.entries(c.expected_config)) {
      rows.push(`| config.${k} | \`${JSON.stringify(v)}\` |`);
    }
  }
  rows.push(`| spin_count | \`${c.spin_count}\` |`);
  if (c.expected_feature) rows.push(`| expected_feature | \`${c.expected_feature}\` |`);
  if (rows.length === 0) return "_(no specific inputs — runs at current UI state)_";
  return ["| Input | Value |", "|---|---|", ...rows].join("\n");
}

function expectsBlock(c: TestCase, invariants: Invariant[]): string {
  const lines: string[] = [];
  const invMap = new Map(invariants.map((i) => [i.id, i]));
  const ids = c.invariant_ids ?? [];
  let resolved: Invariant[];
  if (ids.length === 0) {
    resolved = invariants.filter(
      (i) => i.severity === "critical" || (i.severity as string) === "high" || i.severity === "major",
    );
  } else {
    resolved = ids.map((id) => invMap.get(id)).filter((x): x is Invariant => Boolean(x));
  }
  for (const inv of resolved) {
    lines.push(
      `- 🔒 **${inv.id}** _(${inv.severity})_ — ${inv.description}` +
        (inv.check ? `\n    - Check: \`${inv.check}\`` : "") +
        (inv.tolerance ? ` (tolerance ${inv.tolerance})` : ""),
    );
  }
  for (const a of c.custom_assertions ?? []) {
    lines.push(
      `- ✓ **${a.id}** _(custom)_ — ${a.description || "(no description)"}` +
        `\n    - Check: \`${a.check_code}\``,
    );
  }
  if (lines.length === 0) return "_(no expectations — observational only)_";
  return lines.join("\n");
}

function caseBlock(c: TestCase, invariants: Invariant[], idx: number): string {
  const steps = splitSteps(c.setup_instructions || "");
  const stepsBlock = steps.length
    ? steps.map((s, i) => `${i + 1}. ${s.endsWith(".") ? s : s + "."}`).join("\n")
    : "_(no setup — observational case, runs at default state)_";

  const lines: string[] = [];
  lines.push(`### ${idx}. \`${c.id}\` — ${c.name}`);
  lines.push("");
  lines.push(
    `**Category:** ${CATEGORY_LABELS[c.category] || c.category}  ` +
      `**Severity:** ${SEV_BADGE[c.severity] || c.severity}`,
  );
  lines.push("");
  if (c.description) {
    lines.push(`**Description:** ${c.description}`);
    lines.push("");
  }

  lines.push(`#### 🪜 Step`);
  lines.push("");
  lines.push(stepsBlock);
  lines.push("");

  lines.push(`#### 📥 Input`);
  lines.push("");
  lines.push(inputsBlock(c));
  lines.push("");

  lines.push(`#### ✅ Expect`);
  lines.push("");
  lines.push(expectsBlock(c, invariants));
  lines.push("");

  lines.push(`---`);
  lines.push("");
  return lines.join("\n");
}

function statsHeader(catalog: TestCaseCatalog): string {
  const byCat = new Map<string, number>();
  const bySev = new Map<string, number>();
  for (const c of catalog.cases) {
    byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
    bySev.set(c.severity, (bySev.get(c.severity) ?? 0) + 1);
  }
  const catRow = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${CATEGORY_LABELS[k] || k}: ${n}`)
    .join(" · ");
  const sevRow = ["critical", "major", "minor"]
    .map((s) => `${SEV_BADGE[s]?.split(" ")[1] || s}: ${bySev.get(s) ?? 0}`)
    .join(" · ");
  return [
    `**Total cases:** ${catalog.total_cases}`,
    `**By category:** ${catRow}`,
    `**By severity:** ${sevRow}`,
  ].join("  \n");
}

export function catalogToMarkdown(args: {
  catalog: TestCaseCatalog;
  spec: GameSpec;
  validationReport?: ValidationReport | null;
  bestPracticesVersion?: string | null;
}): string {
  const { catalog, spec, validationReport } = args;
  const out: string[] = [];

  out.push(`# QA Review — ${escapePipe(catalog.game_display_name)}`);
  out.push("");
  out.push(`**Game slug:** \`${catalog.game_slug}\`  `);
  out.push(`**Generated at:** ${new Date(catalog.generated_at).toLocaleString()}  `);
  out.push(`**Engine:** ${spec.engine ?? "n/a"}  `);
  out.push(`**Currency:** ${spec.currency ?? "n/a"}  `);
  out.push("");

  out.push(`## Summary`);
  out.push("");
  out.push(statsHeader(catalog));
  out.push("");

  if (validationReport) {
    out.push(`## Validation Status`);
    out.push("");
    if (validationReport.ok && validationReport.warnings.length === 0) {
      out.push(`✅ **Catalog passed validation cleanly** — 0 errors, 0 warnings.`);
    } else {
      if (validationReport.errors.length > 0) {
        out.push(`❌ **${validationReport.errors.length} error(s)**:`);
        for (const e of validationReport.errors) {
          out.push(`- \`${e.rule}\` (${e.case_id ?? "global"}): ${e.message}`);
        }
        out.push("");
      }
      if (validationReport.warnings.length > 0) {
        out.push(`⚠️ **${validationReport.warnings.length} warning(s)** — review below:`);
        for (const w of validationReport.warnings.slice(0, 20)) {
          out.push(`- \`${w.rule}\` (${w.case_id ?? "global"}): ${w.message}`);
        }
        if (validationReport.warnings.length > 20) {
          out.push(`- _(+${validationReport.warnings.length - 20} more — see catalog JSON)_`);
        }
        out.push("");
      }
    }
    out.push("");
  }

  if (catalog.coverage_notes && catalog.coverage_notes.length) {
    out.push(`## Coverage Notes`);
    out.push("");
    for (const n of catalog.coverage_notes) out.push(`- ${n}`);
    out.push("");
  }

  out.push(`## Game Spec — Key References`);
  out.push("");
  if (spec.bet_mechanics) {
    out.push(`**Bet mechanics:**  `);
    out.push(`- baseBet: \`${spec.bet_mechanics.base_bet}\``);
    out.push(`- bet_sizes: \`${JSON.stringify(spec.bet_mechanics.bet_sizes)}\``);
    out.push(`- bet_levels: \`${JSON.stringify(spec.bet_mechanics.bet_levels)}\``);
    out.push(`- formula: ${spec.bet_mechanics.bet_amount_formula}`);
    out.push("");
  }
  if (spec.invariants && spec.invariants.length) {
    out.push(`**Invariants used as defaults** (when case has \`invariant_ids: []\`):`);
    out.push("");
    out.push(`| ID | Severity | Description |`);
    out.push(`|---|---|---|`);
    for (const inv of spec.invariants) {
      out.push(
        `| \`${inv.id}\` | ${inv.severity} | ${escapePipe(inv.description)} |`,
      );
    }
    out.push("");
  }

  // Group by category
  const byCat = new Map<string, TestCase[]>();
  for (const c of catalog.cases) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category)!.push(c);
  }

  out.push(`## Test Cases`);
  out.push("");
  let idx = 0;
  for (const [cat, list] of byCat) {
    out.push(`## ${CATEGORY_LABELS[cat] || cat} (${list.length})`);
    out.push("");
    for (const c of list) {
      idx++;
      out.push(caseBlock(c, spec.invariants ?? [], idx));
    }
  }

  out.push(`## QA Reviewer Checklist`);
  out.push("");
  out.push(`Đánh dấu các mục sau khi review xong (open trong markdown editor có hỗ trợ checkbox):`);
  out.push("");
  out.push(`- [ ] Mọi case có Step rõ ràng, atomic, có verification cuối`);
  out.push(`- [ ] Mọi case có Input cụ thể (số bet, config, không vague)`);
  out.push(`- [ ] Mọi case có Expect đầy đủ — ít nhất 1 invariant + 1 custom check`);
  out.push(`- [ ] Severity phù hợp (xem Best Practices §9)`);
  out.push(`- [ ] Coverage đủ category bắt buộc cho variant này (xem Best Practices §10)`);
  out.push(`- [ ] Không có case mâu thuẫn (vd autoplay nhưng options.json không có button)`);
  out.push(`- [ ] Không có anti-pattern (xem Best Practices §15): config.code assert, paytable payouts, currency from UI...`);
  out.push(`- [ ] Validation report sạch hoặc warnings có lý do hợp lý`);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(`_Generated by crawler-qa-agent · catalog format v1 · ${new Date().toISOString()}_`);
  out.push("");

  return out.join("\n");
}

/**
 * Flat CSV export — 1 row per test case. Multi-line content (steps,
 * expects) escaped per RFC 4180 → mở trực tiếp trong Excel/Sheets,
 * QA filter/sort theo column.
 *
 * Columns (ổn định cho external tooling):
 *   #, id, name, category, severity, description, steps, spin_count,
 *   expected_bet, expected_config_json, expected_feature, invariant_count,
 *   custom_assertion_count, expects
 */
export function catalogToCsv(args: {
  catalog: TestCaseCatalog;
  spec: GameSpec;
}): string {
  const { catalog, spec } = args;
  const invariants = spec.invariants ?? [];

  const headers = [
    "#",
    "id",
    "name",
    "category",
    "severity",
    "description",
    "steps",
    "spin_count",
    "expected_bet",
    "expected_config_json",
    "expected_feature",
    "invariant_count",
    "custom_assertion_count",
    "expects",
  ];
  const rows: string[] = [headers.map(csvEscape).join(",")];

  let i = 0;
  for (const c of catalog.cases) {
    i++;
    const expectedInvariants =
      (c.invariant_ids?.length ?? 0) === 0
        ? invariants.filter(
            (inv) =>
              inv.severity === "critical" ||
              (inv.severity as string) === "high" ||
              inv.severity === "major",
          ).length
        : c.invariant_ids?.length ?? 0;

    rows.push(
      [
        csvEscape(i),
        csvEscape(c.id),
        csvEscape(c.name),
        csvEscape(c.category),
        csvEscape(c.severity),
        csvEscape(c.description ?? ""),
        csvEscape(joinSteps(c.setup_instructions ?? "")),
        csvEscape(c.spin_count ?? 0),
        csvEscape(c.expected_bet ?? ""),
        csvEscape(c.expected_config ?? ""),
        csvEscape(c.expected_feature ?? ""),
        csvEscape(expectedInvariants),
        csvEscape(c.custom_assertions?.length ?? 0),
        csvEscape(joinExpects(c, invariants)),
      ].join(","),
    );
  }

  // BOM cho Excel decode UTF-8 đúng (không có BOM thì tiếng Việt + emoji bị lỗi)
  return "﻿" + rows.join("\r\n") + "\r\n";
}
