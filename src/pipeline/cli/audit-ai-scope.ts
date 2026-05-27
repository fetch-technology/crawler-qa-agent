// AI: audit script — lists allowed AI files for cold-start/recovery/post-FAIL.
// This file itself does NOT call AI; the strings "claude"/"anthropic" appear only
// as grep needles for the policy check below.
// Exit code 0 = clean, 1 = violation.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const PIPELINE_ROOT = "src/pipeline";

// AI may be referenced ONLY in these files (or under these dirs).
const ALLOWED_AI_FILES = [
  "src/pipeline/step2-detect-ui/ai-vision-strategy.ts",
  "src/pipeline/step2-detect-ui/ai-vision-batch.ts",
  "src/pipeline/step2-detect-ui/ai-vision-verify.ts",
  "src/pipeline/step2-detect-ui/ai-recover-locator.ts",
  "src/pipeline/step2-detect-ui/sub-screen-discover.ts",
  "src/pipeline/step2-detect-ui/graph-explorer.ts",
  "src/pipeline/step4-feature-discovery/ai-detector.ts",
  "src/pipeline/step4-feature-discovery/paytable-detector.ts",
  "src/pipeline/step4-feature-discovery/extract-rules.ts",
  "src/pipeline/step4-feature-discovery/deep-extract.ts",
  "src/pipeline/step12-failure-review/classify.ts",
  "src/pipeline/step12-failure-review/analyzer.ts",
  "src/pipeline/step14-unknown-state-learn/learner.ts",
  "src/pipeline/step5-spin-api-detect/ai-rank.ts",
  "src/pipeline/step7-testcase-gen/ai-augment.ts",
  "src/pipeline/step7-testcase-gen/ai-catalog.ts",
  "src/pipeline/step7-testcase-gen/case-action-translator.ts",
  "src/pipeline/step9-verify/history-verifier.ts",
  "src/pipeline/step9-verify/ui-verifier.ts",
  "src/pipeline/step11-report/ai-explainer.ts",
  "src/pipeline/cli/audit-ai-scope.ts",
];

// Runtime path: MUST NOT contain AI references.
const RUNTIME_DIRS = [
  "src/pipeline/step8-run-scenarios",
  "src/pipeline/step9-verify",
  "src/pipeline/step10-statistical",
  "src/pipeline/utils/pixel-diff",
];

// Required header in AI files (substring search).
const HEADER_RULES = [/AI:/, /(cold-start|discovery|recovery|post-FAIL|opt-in)/];

function listFiles(dir: string): string[] {
  try {
    return execSync(`find "${dir}" -name "*.ts" -type f`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function grepAi(file: string): boolean {
  try {
    const out = execSync(`grep -l "claude\\|anthropic\\|messages\\.create\\|@anthropic-ai" "${file}"`, {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function checkHeader(file: string): Promise<boolean> {
  const content = await readFile(file, "utf8");
  const head = content.split("\n").slice(0, 5).join("\n");
  return HEADER_RULES.every((r) => r.test(head));
}

async function main(): Promise<void> {
  const violations: string[] = [];

  // Rule 1: runtime dirs have ZERO AI references.
  for (const dir of RUNTIME_DIRS) {
    const files = listFiles(dir);
    for (const f of files) {
      if (grepAi(f)) {
        violations.push(`RUNTIME_AI: ${f} references AI in deterministic path`);
      }
    }
  }

  // Rule 2: AI references in pipeline ONLY in allowed files.
  const allFiles = listFiles(PIPELINE_ROOT);
  for (const f of allFiles) {
    const normalized = path.relative(process.cwd(), path.resolve(f));
    if (!grepAi(f)) continue;
    if (!ALLOWED_AI_FILES.includes(normalized)) {
      violations.push(`UNAUTHORIZED_AI: ${normalized} references AI but is not in allow-list`);
    }
  }

  // Rule 3: every allowed AI file has the policy header.
  for (const f of ALLOWED_AI_FILES) {
    try {
      const ok = await checkHeader(f);
      if (!ok) violations.push(`MISSING_HEADER: ${f} lacks "// AI: ..." policy header`);
    } catch {
      // file may be stub-only; OK if it doesn't exist yet
    }
  }

  if (violations.length === 0) {
    console.log("[ok] AI scope policy clean");
    console.log(`     allowed AI files: ${ALLOWED_AI_FILES.length}`);
    console.log(`     runtime dirs verified: ${RUNTIME_DIRS.length}`);
    process.exit(0);
  } else {
    console.error("[fail] AI scope policy violations:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[err] audit-ai-scope:", e);
  process.exit(2);
});
