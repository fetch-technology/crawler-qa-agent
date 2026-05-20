/**
 * stat_reports repository — 1 row per TestRun.
 */

import { getDb } from "../client.js";

export type StatReportInput = {
  testRunId: string;
  totalSpins: number;
  totalBet: number;
  totalWin: number;
  rtp?: number | null;
  hitRate?: number | null;
  maxWin?: number | null;
  averageWin?: number | null;
  volatility?: number | null;
  volatilityBand?: string | null;
  rtpConfidence95?: number | null;
  /** Free-form JSON: featureFrequency, symbolDistribution, winDistribution. */
  metrics: Record<string, unknown>;
};

export async function upsertStatReport(args: StatReportInput): Promise<void> {
  const db = getDb();
  if (!db) return;
  const data = {
    totalSpins: args.totalSpins,
    totalBet: args.totalBet,
    totalWin: args.totalWin,
    rtp: args.rtp ?? null,
    hitRate: args.hitRate ?? null,
    maxWin: args.maxWin ?? null,
    averageWin: args.averageWin ?? null,
    volatility: args.volatility ?? null,
    volatilityBand: args.volatilityBand ?? null,
    rtpConfidence95: args.rtpConfidence95 ?? null,
    metricsJson: JSON.stringify(args.metrics),
  };
  await db.statReport.upsert({
    where: { testRunId: args.testRunId },
    update: data,
    create: { testRunId: args.testRunId, ...data },
  });
}

export async function getStatReport(testRunId: string) {
  const db = getDb();
  if (!db) return null;
  return db.statReport.findUnique({ where: { testRunId } });
}
