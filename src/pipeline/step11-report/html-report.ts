import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaseReportInput } from "./types.js";

export async function writeHtmlReport(outDir: string, input: CaseReportInput): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "report.html");
  const aiExplanation = (input as { aiExplanation?: string }).aiExplanation;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>QA Report — ${escapeHtml(input.crawl.gameName)}</title>
<style>body{font-family:system-ui;margin:24px;}h2{margin-top:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:6px}</style>
</head><body>
<h1>QA Report — ${escapeHtml(input.crawl.gameName)}</h1>
<p><b>Slug:</b> ${escapeHtml(input.crawl.gameSlug)} · <b>Provider:</b> ${escapeHtml(input.crawl.provider)}</p>
<h2>Rules</h2>
<p>Spins: ${input.rules.totalSpins} · Passed: ${input.rules.passed} · Failed: ${input.rules.failed}</p>
${input.stats ? `<h2>Statistics</h2><p>RTP: ${(input.stats.rtp * 100).toFixed(2)}% · Hit rate: ${(input.stats.hitRate * 100).toFixed(2)}% · Volatility: ${input.stats.volatility}</p>` : ""}
${aiExplanation ? `<h2>AI root-cause explanation</h2><pre>${escapeHtml(aiExplanation)}</pre>` : ""}
</body></html>`;
  await writeFile(file, html, "utf8");
  return file;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
