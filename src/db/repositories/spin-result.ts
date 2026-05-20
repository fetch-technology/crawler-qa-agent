/**
 * spin_results repository — bulk insert + paged read.
 */

import { getDb } from "../client.js";

export type SpinResultInput = {
  testRunId: string;
  roundIndex: number;
  counter?: number | null;
  gameCode: string;
  betPerLine?: number | null;
  lines?: number | null;
  totalBet: number;
  serverWin?: number | null;
  totalWin: number;
  balanceBefore?: number | null;
  balanceAfter: number;
  symbols?: string | null;
  reelsJson?: string | null;
  rawRequest?: string | null;
  rawResponse?: string | null;
  isFreeSpin?: boolean;
  hasBonus?: boolean;
};

export async function insertSpinResults(rows: SpinResultInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  if (!db) return 0;
  const r = await db.spinResult.createMany({
    data: rows.map((s) => ({
      testRunId: s.testRunId,
      roundIndex: s.roundIndex,
      counter: s.counter ?? null,
      gameCode: s.gameCode,
      betPerLine: s.betPerLine ?? null,
      lines: s.lines ?? null,
      totalBet: s.totalBet,
      serverWin: s.serverWin ?? null,
      totalWin: s.totalWin,
      balanceBefore: s.balanceBefore ?? null,
      balanceAfter: s.balanceAfter,
      symbols: s.symbols ?? null,
      reelsJson: s.reelsJson ?? null,
      rawRequest: s.rawRequest ?? null,
      rawResponse: s.rawResponse ?? null,
      isFreeSpin: s.isFreeSpin ?? false,
      hasBonus: s.hasBonus ?? false,
    })),
  });
  return r.count;
}

export async function listSpinResults(
  testRunId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const db = getDb();
  if (!db) return [];
  return db.spinResult.findMany({
    where: { testRunId },
    orderBy: { roundIndex: "asc" },
    take: opts.limit ?? 200,
    skip: opts.offset ?? 0,
  });
}
