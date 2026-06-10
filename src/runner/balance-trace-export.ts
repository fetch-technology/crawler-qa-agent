/**
 * Balance trace export — generate the spreadsheet-style table common in QA
 * sign-off documents:
 *
 *   Opening Balance | Bet Amount | Win Amount | Closing Balance | Observed | Status
 *
 * Output formats:
 *   - CSV (Excel/Google Sheets compatible)
 *   - Markdown table (PR review)
 *   - JSON (programmatic)
 *
 * Source: SpinResult rows from DB (TestRun) or filesystem spin_results.
 *
 * Status column logic:
 *   - Compute expected closing = opening - bet + win
 *   - Compare with server's reported closing (balanceAfter)
 *   - Status = TRUE if match (within 0.01), FALSE otherwise
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TraceRow = {
  spin: number;
  openingBalance: number;
  bet: number;
  win: number;
  closingBalance: number;
  observedClosing: number;
  status: "TRUE" | "FALSE";
  /** True when this round was part of a free-spin / bonus feature. Surfaces in
   *  the breakdown so QA can tell base-game vs feature rounds at a glance. */
  isFreeSpin?: boolean;
  currency?: string;
  env?: string;
  gameUrl?: string;
};

export type TraceInput = {
  spins: Array<{
    roundIndex?: number;
    balanceBefore: number | null;
    totalBet: number;
    totalWin: number;
    balanceAfter: number;
    isFreeSpin?: boolean;
  }>;
  env?: string;
  currency?: string;
  gameUrl?: string;
  tolerance?: number;
};

export function buildTrace(input: TraceInput): TraceRow[] {
  const tol = input.tolerance ?? 0.01;
  const rows: TraceRow[] = [];
  for (let i = 0; i < input.spins.length; i++) {
    const s = input.spins[i]!;
    const opening = s.balanceBefore ?? (rows[i - 1]?.closingBalance ?? 0);
    const expectedClosing = opening - s.totalBet + s.totalWin;
    const observed = s.balanceAfter;
    const status: "TRUE" | "FALSE" =
      Math.abs(expectedClosing - observed) <= tol ? "TRUE" : "FALSE";
    rows.push({
      spin: s.roundIndex ?? i + 1,
      openingBalance: opening,
      bet: s.totalBet,
      win: s.totalWin,
      closingBalance: expectedClosing,
      observedClosing: observed,
      status,
      isFreeSpin: s.isFreeSpin,
      env: input.env,
      currency: input.currency,
      gameUrl: input.gameUrl,
    });
  }
  return rows;
}

/** CSV format — matches QA spreadsheet column order. */
export function traceToCsv(rows: TraceRow[]): string {
  const lines: string[] = [];
  lines.push("Opening Balance,Bet Amount,Win Amount,Closing Balance,Observed Balance,Status,ENV,Currency,Game URL");
  for (const r of rows) {
    lines.push(
      [
        r.openingBalance,
        r.bet,
        r.win,
        r.closingBalance,
        r.observedClosing,
        r.status,
        r.env ?? "",
        r.currency ?? "",
        // Quote URL because may contain commas
        r.gameUrl ? `"${r.gameUrl.replace(/"/g, '""')}"` : "",
      ].join(","),
    );
  }
  return lines.join("\n");
}

/** Markdown table. */
export function traceToMarkdown(rows: TraceRow[]): string {
  const headers = [
    "Spin",
    "Type",
    "Opening",
    "Bet",
    "Win",
    "Expected Closing",
    "Observed",
    "Status",
  ];
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const r of rows) {
    const status = r.status === "TRUE" ? "✓" : "❌";
    const type = r.isFreeSpin ? "FS" : "base";
    lines.push(
      `| ${r.spin} | ${type} | ${r.openingBalance.toFixed(2)} | ${r.bet.toFixed(2)} | ${r.win.toFixed(2)} | ${r.closingBalance.toFixed(2)} | ${r.observedClosing.toFixed(2)} | ${status} |`,
    );
  }
  const failures = rows.filter((r) => r.status === "FALSE").length;
  lines.push("");
  lines.push(`**Total: ${rows.length} spins, ${rows.length - failures} pass, ${failures} fail**`);
  return lines.join("\n");
}

export function saveTrace(
  rows: TraceRow[],
  path: string,
  format: "csv" | "md" | "json" = "csv",
): void {
  mkdirSync(dirname(path), { recursive: true });
  if (format === "csv") writeFileSync(path, traceToCsv(rows));
  else if (format === "md") writeFileSync(path, traceToMarkdown(rows));
  else writeFileSync(path, JSON.stringify(rows, null, 2));
}
