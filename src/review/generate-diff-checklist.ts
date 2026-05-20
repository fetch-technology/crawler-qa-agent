import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ChangedFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  hunks: Array<{ start: number; added: number; removed: number }>;
};

type Zone = {
  id: string;
  title: string;
  matcher: (p: string) => boolean;
  checks: string[];
};

const ZONES: Zone[] = [
  {
    id: "runtime",
    title: "Runtime And Spin Flow",
    matcher: (p) => p.startsWith("src/runner/") || p === "src/auto-play.ts",
    checks: [
      "Pre-game reaches ready state consistently (no false mask failure loops)",
      "Spin request is fired and parsed at least once per relevant test case",
      "No page/context closed errors during retry/probe paths",
    ],
  },
  {
    id: "ai-catalog",
    title: "AI Catalog And Mapping",
    matcher: (p) => p.startsWith("src/ai/") || p.startsWith("src/extract") || p.startsWith("src/generate-and-run"),
    checks: [
      "Generated assertions remain deterministic and not RNG-event dependent",
      "Case strategy mapping matches intended category behavior per slug",
      "Catalog validation errors are actionable and do not block valid catalogs",
    ],
  },
  {
    id: "tests-generated",
    title: "Generated Test Specs",
    matcher: (p) => p.startsWith("tests/generated/"),
    checks: [
      "Assertions use normalized fields and stable tolerances",
      "No brittle exact-value checks unless deterministic setup enforces them",
      "Critical smoke cases pass for target slugs",
    ],
  },
  {
    id: "visual-regression",
    title: "Visual Regression",
    matcher: (p) => p.includes("visual") || p.includes("region-snapshot") || p.includes("ui-verifier"),
    checks: [
      "Snapshot regions stay within viewport and avoid volatile animated zones",
      "Baseline naming/versioning avoids stale baseline collisions",
      "Visual suite runs in PR lane without unexpected flakes",
    ],
  },
  {
    id: "lanes-ci",
    title: "Lanes And Automation",
    matcher: (p) => p.startsWith("src/lanes/") || p === "package.json",
    checks: [
      "PR lane remains fast and deterministic",
      "Nightly lane includes real-network plus stats steps",
      "Dry-run output reflects expected execution order",
    ],
  },
  {
    id: "docs",
    title: "Docs And Checklist",
    matcher: (p) => p.startsWith("docs/") || p.endsWith(".md"),
    checks: [
      "Checklist status matches actual verified command results",
      "Progress log includes exact metrics and scope disclaimers",
      "User-facing instructions remain consistent with current scripts",
    ],
  },
];

function sh(command: string): string {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function trySh(command: string): string {
  try {
    return sh(command);
  } catch {
    return "";
  }
}

function parseNameStatus(line: string): ChangedFile | null {
  if (!line) return null;
  const statusCode = line.slice(0, 1);
  const rest = line.slice(1).trim();
  if (!rest) return null;

  if (statusCode === "R") {
    const parts = rest.split(/\s+/);
    const toPath = parts[parts.length - 1] ?? "";
    if (!toPath) return null;
    return { path: toPath, status: "renamed", hunks: [] };
  }

  const statusMap: Record<string, ChangedFile["status"]> = {
    M: "modified",
    A: "added",
    D: "deleted",
  };
  const status = statusMap[statusCode] ?? "modified";
  return { path: rest, status, hunks: [] };
}

function isReviewablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const excludedPrefixes = [
    "node_modules/",
    "fixtures/",
    "test-results/",
    "reports/",
    ".git/",
    "dist/",
    "build/",
  ];
  if (excludedPrefixes.some((p) => normalized.startsWith(p))) return false;

  const includedExact = new Set([
    "package.json",
    "playwright.config.ts",
    "tsconfig.json",
    "docker-compose.yml",
  ]);
  if (includedExact.has(normalized)) return true;

  return (
    normalized.startsWith("src/") ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("prisma/")
  );
}

function collectChangedFiles(): ChangedFile[] {
  const unstagedRaw = trySh("git diff --name-status");
  const stagedRaw = trySh("git diff --name-status --cached");
  const untrackedRaw = trySh("git ls-files --others --exclude-standard");

  const map = new Map<string, ChangedFile>();

  for (const raw of [unstagedRaw, stagedRaw]) {
    for (const line of raw.split("\n")) {
      const parsed = parseNameStatus(line.trim());
      if (!parsed) continue;
      map.set(parsed.path, parsed);
    }
  }

  for (const p of untrackedRaw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    map.set(p, { path: p, status: "untracked", hunks: [] });
  }

  const files = Array.from(map.values())
    .filter((f) => isReviewablePath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const f of files) {
    if (f.status === "deleted") continue;
    const patch = trySh(`git diff -U0 -- "${f.path}"`);
    const lines = patch.split("\n");
    for (const l of lines) {
      const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1] ?? "0");
      const added = Number(m[2] ?? "1");
      // Removed count is not always present in right hunk header; use plus/minus scan below if needed.
      f.hunks.push({ start, added, removed: 0 });
    }
  }

  return files;
}

function zoneForPath(path: string): Zone {
  return ZONES.find((z) => z.matcher(path)) ?? {
    id: "other",
    title: "Other",
    matcher: () => true,
    checks: ["Review behavior and risks for this area manually"],
  };
}

function buildMarkdown(files: ChangedFile[]): string {
  const now = new Date().toISOString();
  const byZone = new Map<string, { zone: Zone; files: ChangedFile[] }>();

  for (const f of files) {
    const z = zoneForPath(f.path);
    const cur = byZone.get(z.id);
    if (cur) cur.files.push(f);
    else byZone.set(z.id, { zone: z, files: [f] });
  }

  const lines: string[] = [];
  lines.push("# QA Diff Review Checklist");
  lines.push("");
  lines.push(`Generated at: ${now}`);
  lines.push(`Changed files: ${files.length}`);
  lines.push("");

  lines.push("## File Delta");
  lines.push("");
  if (files.length === 0) {
    lines.push("No working-tree changes detected.");
  } else {
    lines.push("| File | Status | Hunk Starts | Zone |");
    lines.push("|---|---|---|---|");
    for (const f of files) {
      const z = zoneForPath(f.path);
      const h = f.hunks.length > 0 ? f.hunks.map((x) => String(x.start)).join(", ") : "-";
      lines.push(`| ${f.path} | ${f.status} | ${h} | ${z.title} |`);
    }
  }
  lines.push("");

  lines.push("## Reviewer Checklist By Zone");
  lines.push("");
  for (const { zone, files: zf } of Array.from(byZone.values()).sort((a, b) => a.zone.title.localeCompare(b.zone.title))) {
    lines.push(`### ${zone.title}`);
    lines.push("");
    lines.push("Changed files:");
    for (const f of zf) {
      lines.push(`- [ ] ${f.path}`);
    }
    lines.push("");
    lines.push("Checks:");
    for (const c of zone.checks) {
      lines.push(`- [ ] ${c}`);
    }
    lines.push("");
  }

  lines.push("## Sign-off");
  lines.push("");
  lines.push("- [ ] QA reviewed all changed zones");
  lines.push("- [ ] Blocking issues documented with file references");
  lines.push("- [ ] Ready for merge / run");
  lines.push("");

  return lines.join("\n");
}

function main(): void {
  const outPathArg = process.argv.find((a) => a.startsWith("--out="));
  const outPath = outPathArg
    ? outPathArg.slice("--out=".length)
    : join("docs", "qa-diff-review-checklist.md");

  const files = collectChangedFiles();
  const md = buildMarkdown(files);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);
  console.log(`[diff-review] wrote ${outPath} (${files.length} files)`);
}

main();
