import type { TestcaseDocument } from "./types.js";

export function toYaml(doc: TestcaseDocument): string {
  const lines: string[] = [];
  lines.push(`game: ${escape(doc.game)}`);
  lines.push(`generatedAt: ${doc.generatedAt}`);
  lines.push("testcases:");
  for (const tc of doc.testcases) {
    lines.push(`  - id: ${tc.id}`);
    lines.push(`    title: ${escape(tc.title)}`);
    lines.push(`    category: ${tc.category}`);
    lines.push(`    priority: ${tc.priority}`);
    lines.push(`    steps:`);
    for (const s of tc.steps) lines.push(`      - ${escape(s)}`);
    lines.push(`    expected: ${escape(tc.expected)}`);
  }
  return lines.join("\n") + "\n";
}

function escape(s: string): string {
  if (/[:#&*!|>'"%@`]/.test(s) || s.includes("\n")) {
    return JSON.stringify(s);
  }
  return s;
}
