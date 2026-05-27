// AI: called only post-FAIL — history popup OCR runs ONCE per test session
// (NOT per-spin). Reuses legacy `transcribeHistoryRows` from src/ai/vision.ts.
// Compares server's history popup against captured spins to detect:
//   - missing rows (server didn't persist a spin)
//   - wrong bet/win/balance (history shows different values than captured)
//   - extra rows (history has older session data leaking through)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import {
  transcribeHistoryRows,
  type TranscribedHistoryRow,
} from "../../ai/vision.js";
import { snapshot, waitUntilStable } from "../utils/pixel-diff/index.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { UiElement, UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";

export type HistoryMismatch = {
  kind: "missing" | "field_mismatch" | "extra" | "ordering";
  spinRoundId?: string;
  historyRowText?: string;
  detail: string;
};

export type HistoryVerifyResult = {
  ok: boolean;
  opened: boolean;
  rowsCount: number;
  spinsCount: number;
  matchedCount: number;
  mismatches: HistoryMismatch[];
  reason?: string;
  /** Repo-relative path to the popup screenshot saved during verification.
   *  Always populated when the popup opens. Points to the FIRST page when
   *  pagination is enabled — subsequent pages saved alongside with -p2,-p3 suffix. */
  screenshotPath?: string;
  /** Raw OCR rows transcribed from the popup (aggregated across all pages
   *  if pagination enabled). Used for dashboard rendering and evidence packaging. */
  rows?: TranscribedHistoryRow[];
  /** Ordering diagnostic — direction (newest-first vs oldest-first) + any
   *  monotonicity violations across captured spin order. */
  ordering?: OrderingInfo;
  /** Number of popup pages scanned. Default 1 when pagination disabled. */
  pagesScanned?: number;
};

const TOLERANCE = 0.01;

/** Optional evidence override — when set, the popup screenshot is saved to
 *  `<dir>/<baseName>.history.png` instead of the default fixtures/registry/<slug>/history/<ts>.png. */
export type VerifyHistoryOptions = {
  evidence?: { dir: string; baseName: string };
};

export async function verifyHistory(
  page: Page,
  gameSlug: string,
  uiRegistry: UiRegistry,
  spins: NormalizedSpinResult[],
  options: VerifyHistoryOptions = {},
): Promise<HistoryVerifyResult> {
  if (spins.length === 0) {
    return mkSkip("no spins to verify against");
  }

  // Locate history button. Prefer top-level "historyButton", fallback to menu__historyButton
  // (which would require opening menu first — caller should ensure menu opened).
  const historyEl = pickHistoryTrigger(uiRegistry);
  if (!historyEl) {
    return mkSkip("no historyButton or menu__historyButton in registry");
  }

  // Open history popup.
  try {
    await page.mouse.click(historyEl.x, historyEl.y);
  } catch (err) {
    return mkSkip(`click history trigger failed: ${String(err)}`);
  }
  await waitUntilStable(page, {
    maxIterations: 10,
    changeThreshold: 0.005,
    consecutiveStable: 2,
  });

  // Save screenshot for OCR. Default location: per-game folder. Caller may
  // override via options.evidence for per-case evidence co-location.
  // Resolve pagination: env QA_HISTORY_PAGES caps scanned pages.
  const maxPages = Math.max(1, Number(process.env.QA_HISTORY_PAGES ?? "1") || 1);
  const screenshotPaths: string[] = [];
  const pageScreenshot = async (pageIdx: number): Promise<string> => {
    let p: string;
    if (options.evidence) {
      await mkdir(options.evidence.dir, { recursive: true });
      const suffix = pageIdx === 0 ? "" : `-p${pageIdx + 1}`;
      p = path.join(options.evidence.dir, `${options.evidence.baseName}.history${suffix}.png`);
    } else {
      const dir = path.join(dirForGame(gameSlug), "history");
      await mkdir(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = pageIdx === 0 ? "" : `-p${pageIdx + 1}`;
      p = path.join(dir, `${ts}${suffix}.png`);
    }
    const buf = await page.screenshot({ type: "png" });
    await writeFile(p, buf);
    return p;
  };

  const firstScreenshot = await pageScreenshot(0);
  screenshotPaths.push(firstScreenshot);
  const screenshotPath = firstScreenshot;
  const screenshotRel = path.relative(process.cwd(), screenshotPath);

  // Verify popup actually opened (sanity).
  const after = await snapshot(page);
  void after;

  // OCR rows (aggregating across pages when pagination enabled).
  let rows: TranscribedHistoryRow[];
  let pagesScanned = 1;
  try {
    rows = await transcribeHistoryRows({ screenshotPath });
    if (maxPages > 1) {
      const viewport = page.viewportSize();
      // Scroll the popup region (approx center of viewport) and OCR each
      // additional page. Dedupe rows by round_id when present; otherwise by
      // raw_text exact match. Stop early if a page returns no new rows.
      const seenRoundIds = new Set<string>(
        rows.map((r) => r.round_id).filter((id): id is string => id != null),
      );
      const seenRawText = new Set<string>(rows.map((r) => r.raw_text));
      for (let p = 1; p < maxPages; p++) {
        try {
          const cx = (viewport?.width ?? 1280) / 2;
          const cy = (viewport?.height ?? 720) / 2;
          await page.mouse.move(cx, cy);
          await page.mouse.wheel(0, (viewport?.height ?? 720) * 0.6);
          await waitUntilStable(page, {
            maxIterations: 6,
            changeThreshold: 0.005,
            consecutiveStable: 2,
          });
          const pPath = await pageScreenshot(p);
          screenshotPaths.push(pPath);
          const pageRows = await transcribeHistoryRows({ screenshotPath: pPath });
          let added = 0;
          for (const r of pageRows) {
            const id = r.round_id;
            if (id != null && seenRoundIds.has(id)) continue;
            if (id == null && seenRawText.has(r.raw_text)) continue;
            if (id != null) seenRoundIds.add(id);
            seenRawText.add(r.raw_text);
            rows.push(r);
            added++;
          }
          pagesScanned = p + 1;
          if (added === 0) break; // pagination reached end / no scroll movement
        } catch (err) {
          console.warn(`[history] pagination page ${p + 1} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      opened: true,
      rowsCount: 0,
      spinsCount: spins.length,
      matchedCount: 0,
      mismatches: [],
      reason: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      screenshotPath: screenshotRel,
      pagesScanned,
    };
  }

  const { mismatches, matchedCount, ordering } = reconcileSpinsWithRows(spins, rows);

  return {
    ok: mismatches.filter((m) => m.kind !== "extra").length === 0,
    opened: true,
    rowsCount: rows.length,
    spinsCount: spins.length,
    matchedCount,
    mismatches,
    screenshotPath: screenshotRel,
    rows,
    ordering,
    pagesScanned,
  };
}

/** Pure reconciliation — match captured spins against OCR'd history rows,
 *  classify mismatches, return matchedCount. Exported for invariant tests.
 *
 *  Ordering: spins are passed in capture order (oldest first). The function
 *  also checks that matched row indices are monotonic (newest-first OR
 *  oldest-first across the full list). Emits `ordering` mismatch when the
 *  detected direction reverses partway through. */
export function reconcileSpinsWithRows(
  spins: NormalizedSpinResult[],
  rows: TranscribedHistoryRow[],
): {
  mismatches: HistoryMismatch[];
  matchedCount: number;
  matchedRowIdx: Set<number>;
  ordering: OrderingInfo;
} {
  const mismatches: HistoryMismatch[] = [];
  let matchedCount = 0;
  const matchedRowIdx = new Set<number>();
  /** Spin capture index → row index in OCR'd rows. Order preserved. */
  const matchedPairs: Array<{ spinIdx: number; rowIdx: number }> = [];

  for (let spinIdx = 0; spinIdx < spins.length; spinIdx++) {
    const spin = spins[spinIdx]!;
    const idx = findMatchingRow(rows, spin);
    if (idx === -1) {
      mismatches.push({
        kind: "missing",
        spinRoundId: spin.roundId,
        detail: `spin ${spin.roundId} (bet=${spin.bet}, win=${spin.win}) not found in history`,
      });
      continue;
    }
    const row = rows[idx]!;
    matchedRowIdx.add(idx);
    matchedCount++;
    matchedPairs.push({ spinIdx, rowIdx: idx });
    if (row.bet != null && Math.abs(row.bet - spin.bet) > TOLERANCE) {
      mismatches.push({
        kind: "field_mismatch",
        spinRoundId: spin.roundId,
        historyRowText: row.raw_text,
        detail: `bet mismatch: spin=${spin.bet} history=${row.bet}`,
      });
    }
    if (row.win != null && Math.abs(row.win - spin.win) > TOLERANCE) {
      mismatches.push({
        kind: "field_mismatch",
        spinRoundId: spin.roundId,
        historyRowText: row.raw_text,
        detail: `win mismatch: spin=${spin.win} history=${row.win}`,
      });
    }
    if (
      row.balance_after != null &&
      Math.abs(row.balance_after - spin.balanceAfter) > TOLERANCE
    ) {
      mismatches.push({
        kind: "field_mismatch",
        spinRoundId: spin.roundId,
        historyRowText: row.raw_text,
        detail: `balance mismatch: spin=${spin.balanceAfter} history=${row.balance_after}`,
      });
    }
  }

  for (let i = 0; i < rows.length; i++) {
    if (matchedRowIdx.has(i)) continue;
    const row = rows[i]!;
    if (row.bet != null && row.win != null) {
      mismatches.push({
        kind: "extra",
        historyRowText: row.raw_text,
        detail: `history row not from current run (likely older session): bet=${row.bet} win=${row.win}`,
      });
    }
  }

  const ordering = checkOrdering(matchedPairs);
  for (const v of ordering.violations) {
    mismatches.push({
      kind: "ordering",
      spinRoundId: spins[v.spinIdx]?.roundId,
      detail:
        `ordering violation at capture spin #${v.spinIdx}: expected ${ordering.direction} `
        + `but row idx ${v.rowIdx} broke monotonic sequence (prev row idx=${v.prevRowIdx})`,
    });
  }

  return { mismatches, matchedCount, matchedRowIdx, ordering };
}

export type OrderingInfo = {
  /** Detected direction from first 2 matched pairs. Undetermined when <2 matches. */
  direction: "newest_first" | "oldest_first" | "indeterminate";
  /** Capture indices where row index breaks monotonic sequence. */
  violations: Array<{ spinIdx: number; rowIdx: number; prevRowIdx: number }>;
};

/** Verify matched row indices are monotonic across spins-in-capture-order.
 *  Direction inferred from first 2 matches (newest-first = descending row
 *  index as capture index grows; oldest-first = ascending). */
export function checkOrdering(
  pairs: Array<{ spinIdx: number; rowIdx: number }>,
): OrderingInfo {
  if (pairs.length < 2) {
    return { direction: "indeterminate", violations: [] };
  }
  // Pairs are already in capture order (we push them in spinIdx ascending).
  const [a, b] = pairs;
  if (a!.rowIdx === b!.rowIdx) {
    return { direction: "indeterminate", violations: [] };
  }
  const direction: "newest_first" | "oldest_first" =
    b!.rowIdx < a!.rowIdx ? "newest_first" : "oldest_first";
  const violations: OrderingInfo["violations"] = [];
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1]!;
    const cur = pairs[i]!;
    const monotonic =
      direction === "newest_first"
        ? cur.rowIdx < prev.rowIdx
        : cur.rowIdx > prev.rowIdx;
    if (!monotonic) {
      violations.push({ spinIdx: cur.spinIdx, rowIdx: cur.rowIdx, prevRowIdx: prev.rowIdx });
    }
  }
  return { direction, violations };
}

export const HISTORY_TOLERANCE = TOLERANCE;

function pickHistoryTrigger(uiRegistry: UiRegistry): UiElement | null {
  const reg = uiRegistry as Record<string, UiElement | undefined>;
  // Prefer main-screen history button.
  if (reg["historyButton"]) return reg["historyButton"]!;
  if (reg["menu__historyButton"]) return reg["menu__historyButton"]!;
  // Search any element key containing "history".
  for (const [key, el] of Object.entries(reg)) {
    if (el && /history/i.test(key)) return el;
  }
  return null;
}

export function findMatchingRow(rows: TranscribedHistoryRow[], spin: NormalizedSpinResult): number {
  // Pass 1: exact round_id match (strong signal — wins over tuple even if a
  // different row happens to have the same numeric tuple by coincidence).
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.round_id != null && row.round_id === spin.roundId) return i;
  }
  // Pass 2: fallback tuple match (bet + win + balance_after within tolerance).
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (
      row.bet != null &&
      row.win != null &&
      row.balance_after != null &&
      Math.abs(row.bet - spin.bet) < TOLERANCE &&
      Math.abs(row.win - spin.win) < TOLERANCE &&
      Math.abs(row.balance_after - spin.balanceAfter) < TOLERANCE
    ) {
      return i;
    }
  }
  return -1;
}

function mkSkip(reason: string): HistoryVerifyResult {
  return {
    ok: true,
    opened: false,
    rowsCount: 0,
    spinsCount: 0,
    matchedCount: 0,
    mismatches: [],
    reason,
  };
}
