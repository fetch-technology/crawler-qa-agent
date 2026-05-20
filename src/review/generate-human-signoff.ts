import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_SLUGS = [
  "fiesta-magenta",
  "vs20olympgate",
  "vs5triple8gold",
  "vswayscyhecity",
];

function parseArgs(): { outPath: string; slugs: string[] } {
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const slugsArg = process.argv.find((a) => a.startsWith("--slugs="));

  const outPath = outArg
    ? outArg.slice("--out=".length)
    : join("docs", "qa-human-signoff.md");

  const slugs = slugsArg
    ? slugsArg
        .slice("--slugs=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_SLUGS;

  return { outPath, slugs };
}

function slugRows(slugs: string[]): string {
  return slugs
    .map((slug) => `| ${slug} | [ ] | [ ] | [ ] | [ ] | [ ] |`)
    .join("\n");
}

function slugChecklist(slugs: string[]): string {
  return slugs.map((slug) => `- [ ] ${slug}`).join("\n");
}

function buildMarkdown(slugs: string[]): string {
  const now = new Date().toISOString();
  const reviewer = process.env.QA_REVIEWER ?? process.env.USER ?? "";

  return `# QA Human Sign-off (Exploratory And Polish)\n\nGenerated at: ${now}\nReviewer: ${reviewer}\nRelease/PR: \n\n## Inputs\n- Diff checklist: docs/qa-diff-review-checklist.md\n- Visual suite reference: tests/visual-regression.spec.ts\n\n## Scope Slugs\n${slugChecklist(slugs)}\n\n## Exploratory Matrix\n| Slug | Base spin flow | Buy/special flow | History/options/turbo | Visual sanity (idle + post-spin) | Notes |\n|---|---|---|---|---|---|\n${slugRows(slugs)}\n\n## Polish Checklist\n- [ ] Text/label readability is correct on desktop and mobile\n- [ ] No obvious animation jitter or layout shift in critical UI\n- [ ] No blocking UX bug in spin/bet/startup flows\n- [ ] Error states and reconnect behavior are acceptable\n\n## Sign-off Decision\n- [ ] APPROVED for merge/release\n- [ ] BLOCKED (document blockers below)\n\n## Blocking Issues\n- [ ] None\n- [ ] Issue 1:\n- [ ] Issue 2:\n\n## Evidence\n- Commands executed:\n- Related artifacts/files:\n`;}

function main(): void {
  const { outPath, slugs } = parseArgs();
  const md = buildMarkdown(slugs);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);

  console.log(`[review-signoff] wrote ${outPath} (${slugs.length} slugs)`);
}

main();
