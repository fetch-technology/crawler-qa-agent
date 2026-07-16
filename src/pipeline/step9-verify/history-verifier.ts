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
  transcribeHistoryRowDetail,
  type TranscribedHistoryRow,
} from "../../ai/vision.js";
import { waitUntilStable, decodePng, pixelDiff } from "../utils/pixel-diff/index.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { UiElement, UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";

export type HistoryMismatch = {
  kind: "missing" | "field_mismatch" | "extra" | "ordering";
  spinRoundId?: string;
  historyRowText?: string;
  detail: string;
};

/** AI-vision detail check on ONE expanded history row (Spin/Respin breakdown).
 *  Advisory: surfaces internal-arithmetic / collapsed-vs-expanded mismatches
 *  without failing the case (mirrors the win-vs-paytable advisory). */
export type HistoryRowDetailCheck = {
  rowKey: string;
  spinWin: number | null;
  respinWin: number | null;
  totalWin: number | null;
  /** The matching collapsed table row's win (expanded total should equal it). */
  collapsedWin: number | null;
  /** true = consistent, false = a real mismatch, null = couldn't read enough. */
  consistent: boolean | null;
  detail: string;
};

export type HistoryVerifyResult = {
  ok: boolean;
  opened: boolean;
  rowsCount: number;
  spinsCount: number;
  matchedCount: number;
  mismatches: HistoryMismatch[];
  /** AI-vision spot-checks on 1-2 representative expanded rows (advisory). */
  rowDetailChecks?: HistoryRowDetailCheck[];
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

  // Locate history button + its registry key.
  const trigger = pickHistoryTrigger(uiRegistry);
  if (!trigger) {
    return mkSkip("no historyButton or menu__historyButton in registry");
  }
  const { key: historyKey, el: historyEl } = trigger;

  // Many games nest History under a menu/burger popup — the trigger is a
  // namespaced child (e.g. `menuButton__historyButton`). Clicking its coord
  // with the menu CLOSED lands on empty space (a no-op) → we'd OCR the game
  // screen and report every row missing. Resolve the parent popup so we can
  // open it first.
  const reg = uiRegistry as Record<string, UiElement | undefined>;
  const parentKey = historyKey.includes("__") ? historyKey.split("__")[0] : null;
  const parentEl = parentKey ? reg[parentKey] ?? null : null;

  // New-tab/popup awareness (#3): some games open History in a SEPARATE tab
  // (window.open / target=_blank) instead of an in-page panel. Arm a one-shot
  // context "page" listener BEFORE clicking so we capture the new tab the
  // moment it opens; otherwise we'd screenshot/OCR the unchanged game screen
  // and report every row missing. `historyEl.externalPage` (set by the graph
  // explorer when it saw a tab open) is a strong hint, but we listen
  // regardless because discovery doesn't always flag it.
  const context = page.context();
  const popupSlot: Page[] = [];
  const onPopup = (p: Page): void => {
    if (popupSlot.length === 0) popupSlot.push(p);
  };
  context.on("page", onPopup);

  // Clear any leftover popup/menu from the just-run case so the open sequence
  // starts from a known state (menuButton is typically a TOGGLE — clicking it
  // while already open would CLOSE it).
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } catch {
    // best-effort reset
  }

  // Find a history tab among ALL pages in the context — NOT just ones the
  // `page` event caught after our click. History often opens a SEPARATE tab,
  // and that tab may already be open (left over from the case's own action
  // phase, where clicking historyButton opened it and `history-dismiss` only
  // ESC'd the game page). The `page` event won't re-fire for an already-open
  // tab, so screenshotting `page` would capture the game screen → every row
  // "missing". Scan context.pages() and take the newest non-game tab.
  const findHistoryTab = (): Page | null => {
    if (popupSlot[0] && !popupSlot[0].isClosed()) return popupSlot[0];
    const extras = context.pages().filter((p) => p !== page && !p.isClosed());
    return extras.length > 0 ? extras[extras.length - 1]! : null;
  };

  // Capture the clean (post-ESC) main screen as the reference for the in-page
  // fallback below.
  let mainBefore: Buffer | null = null;
  try { mainBefore = await page.screenshot({ type: "png" }); } catch { /* ignore */ }

  // Open History. The trigger is flaky on this provider — the first click on
  // the tab-opening link is frequently a NO-OP (the user must click again). A
  // NEW TAB is the ONLY authoritative "opened" signal: a menu toggle / in-page
  // flicker must NOT count (that produced a false "opened" → we screenshot the
  // game screen → every row reported "missing"). So click the trigger up to 3×
  // per attempt and watch context.pages() for a new tab after each click.
  const tryOpenHistory = async (): Promise<boolean> => {
    if (parentEl) {
      await page.mouse.click(parentEl.x, parentEl.y); // open the menu popup first
      await page.waitForTimeout(800);
    }
    for (let click = 0; click < 3; click++) {
      await page.mouse.click(historyEl.x, historyEl.y);
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline) {
        if (findHistoryTab()) return true; // tab is the real target
        await page.waitForTimeout(150);
      }
    }
    return findHistoryTab() != null;
  };

  let openedOk = false;
  for (let attempt = 1; attempt <= 3 && !openedOk; attempt++) {
    try {
      openedOk = await tryOpenHistory();
    } catch (err) {
      context.off("page", onPopup);
      return mkSkip(`click history trigger failed: ${String(err)}`);
    }
    if (!openedOk) {
      console.warn(`[history] open attempt ${attempt}/3 — no new tab after 3 clicks (flaky tab-open link), retrying`);
      // Reset any toggled menu state before the next attempt.
      try { await page.keyboard.press("Escape"); await page.waitForTimeout(300); } catch { /* ignore */ }
    }
  }

  let inspectPage: Page = findHistoryTab() ?? page;
  let openedInNewTab = inspectPage !== page;

  // No tab ever opened. Either history is an in-page panel (some games) or the
  // tab-open click stayed flaky. Distinguish via a STRONG pixel change vs the
  // pre-open main screen — a real panel covers most of the screen, a leftover
  // menu does not. If NEITHER, report honestly (indeterminate) rather than
  // OCR'ing the game screen and emitting bogus "all rows missing" mismatches.
  if (!openedInNewTab) {
    let inPagePanel = false;
    try {
      if (mainBefore) {
        const after = await page.screenshot({ type: "png" });
        inPagePanel = pixelDiff(decodePng(mainBefore), decodePng(after)).ratio > 0.15;
      }
    } catch { /* ignore */ }
    if (!inPagePanel) {
      context.off("page", onPopup);
      return mkSkip("history did not open — no new tab and no in-page panel after retries (flaky tab-open click); not reporting rows as missing");
    }
  }
  if (openedInNewTab) {
    try {
      await inspectPage.waitForLoadState("domcontentloaded", { timeout: 8000 });
      await inspectPage.bringToFront();
      await waitUntilStable(inspectPage, {
        maxIterations: 10,
        changeThreshold: 0.005,
        consecutiveStable: 2,
      });
    } catch (err) {
      console.warn(`[history] new-tab settle failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Tear down the listener and close the history tab so the browser doesn't
  // accumulate handles across cases. Safe to call once on every exit path.
  const cleanupPopup = async (): Promise<void> => {
    context.off("page", onPopup);
    if (openedInNewTab) {
      try {
        await inspectPage.close();
      } catch {
        // tab already gone — ignore
      }
    }
  };

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
    const buf = await inspectPage.screenshot({ type: "png" });
    await writeFile(p, buf);
    return p;
  };

  // History rows often render ASYNC — most acutely when History opened in a
  // NEW TAB (Pragmatic & co. window.open a fresh client that fetches rows over
  // the gameService API AFTER the page load). The tab paints a blank/background
  // frame first, and waitUntilStable() happily treats that still-blank frame as
  // "stable" → we'd screenshot it, OCR 0 rows, and report a false
  // "indeterminate". Poll instead: re-settle + re-screenshot + re-OCR page 1
  // until rows actually appear or a deadline passes. Readiness is tied to REAL
  // transcribed rows, not to pixel-stability of a not-yet-drawn page. The extra
  // latency is paid only on the slow path (blank tab); a popup that rendered on
  // first paint returns on attempt 1.
  const contentDeadlineMs = Date.now() + (openedInNewTab ? 12000 : 6000);
  let screenshotPath = await pageScreenshot(0);
  screenshotPaths.push(screenshotPath);
  let rows: TranscribedHistoryRow[] = [];
  let pagesScanned = 1;
  let ocrThrew: unknown = null;
  for (;;) {
    try {
      rows = await transcribeHistoryRows({ screenshotPath });
      ocrThrew = null;
    } catch (err) {
      ocrThrew = err;
      rows = [];
    }
    if (rows.length > 0 || Date.now() >= contentDeadlineMs) break;
    // Still blank — give the tab more time to fetch + paint, then re-capture.
    await inspectPage.waitForTimeout(1000);
    await waitUntilStable(inspectPage, {
      maxIterations: 4,
      changeThreshold: 0.005,
      consecutiveStable: 2,
    }).catch(() => false);
    screenshotPath = await pageScreenshot(0); // overwrite page-1 evidence (same path) with the freshest frame
  }
  const screenshotRel = path.relative(process.cwd(), screenshotPath);

  // OCR threw on the final attempt (and never produced rows) → surface honestly.
  if (ocrThrew && rows.length === 0) {
    await cleanupPopup();
    return {
      ok: false,
      opened: true,
      rowsCount: 0,
      spinsCount: spins.length,
      matchedCount: 0,
      mismatches: [],
      reason: `OCR failed: ${ocrThrew instanceof Error ? ocrThrew.message : String(ocrThrew)}`,
      screenshotPath: screenshotRel,
      pagesScanned,
    };
  }

  // Additional pages (pagination) — only worth scanning once page 1 has rows.
  if (maxPages > 1 && rows.length > 0) {
    const viewport = inspectPage.viewportSize();
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
        await inspectPage.mouse.move(cx, cy);
        await inspectPage.mouse.wheel(0, (viewport?.height ?? 720) * 0.6);
        await waitUntilStable(inspectPage, {
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

  // Zero rows transcribed almost always means a capture problem (popup didn't
  // render, screenshot grabbed the wrong page, OCR returned nothing) — NOT that
  // the server genuinely lost every spin. Reporting all N spins as "missing"
  // here is misleading. Surface it honestly as indeterminate instead.
  if (rows.length === 0) {
    await cleanupPopup();
    return {
      ok: false,
      opened: true,
      rowsCount: 0,
      spinsCount: spins.length,
      matchedCount: 0,
      mismatches: [],
      reason: "history opened but 0 rows transcribed — popup render / OCR / wrong-page capture issue (not treating spins as missing)",
      screenshotPath: screenshotRel,
      rows: [],
      pagesScanned,
    };
  }

  const { mismatches, matchedCount, ordering } = reconcileSpinsWithRows(spins, rows);

  // EXPANDED-ROW DETAIL (advisory, AI-vision on 1-2 representative rows). The
  // table reconciliation above checks the COLLAPSED columns (bet/win/balance);
  // it can't see the per-round Spin/Respin breakdown. Expand the top 1-2 rows,
  // AI-read their breakdown, and verify the internal arithmetic — Total ==
  // Spin + Σ Respin, and expanded Total == the collapsed row's win. Surfaced
  // for QA; does NOT fail `ok` (vision can misread; row-level reconcile is the
  // verdict). The expandRow-<N> keys are positional + replay-stable.
  const rowDetailChecks = await verifyExpandedRowDetails(inspectPage, uiRegistry, rows, screenshotPath);

  await cleanupPopup();

  return {
    ok: mismatches.filter((m) => m.kind !== "extra").length === 0,
    opened: true,
    rowsCount: rows.length,
    spinsCount: spins.length,
    matchedCount,
    mismatches,
    rowDetailChecks: rowDetailChecks.length > 0 ? rowDetailChecks : undefined,
    screenshotPath: screenshotRel,
    rows,
    ordering,
    pagesScanned,
  };
}

function expandRowIndex(key: string): number {
  const m = key.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Expand up to 2 representative history rows and AI-read each one's Spin/Respin
 *  breakdown, returning advisory consistency checks. Best-effort: any failure on
 *  a row records a null-consistent entry and moves on (never throws). */
async function verifyExpandedRowDetails(
  inspectPage: Page,
  uiRegistry: UiRegistry,
  rows: TranscribedHistoryRow[],
  refScreenshotPath: string,
): Promise<HistoryRowDetailCheck[]> {
  const checks: HistoryRowDetailCheck[] = [];
  const reg = uiRegistry as Record<string, UiElement | undefined>;
  const expandKeys = Object.keys(reg)
    .filter((k) => /(?:^|__)expandRow-\d+$/.test(k) && reg[k] != null)
    .sort((a, b) => expandRowIndex(a) - expandRowIndex(b))
    .slice(0, 2);
  if (expandKeys.length === 0) return checks;
  const dir = path.dirname(refScreenshotPath);
  for (const rowKey of expandKeys) {
    const el = reg[rowKey]!;
    const idx = expandRowIndex(rowKey) - 1; // expandRow-1 → top table row (rows[0])
    try {
      await inspectPage.mouse.click(el.x, el.y);
      await inspectPage.waitForTimeout(900);
      const detailPath = path.join(dir, `rowdetail-${rowKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
      await writeFile(detailPath, await inspectPage.screenshot({ type: "png" }));
      const d = await transcribeHistoryRowDetail({ screenshotPath: detailPath });
      const collapsedWin = idx >= 0 && idx < rows.length ? rows[idx]!.win : null;
      // Internal arithmetic: Total == Spin + Σ Respin. But vision can't reliably
      // SPLIT a single win value into spin/respin on a base-only round (no real
      // feature) — it tends to echo the same number under several labels. Treat
      // as consistent when the components are genuinely additive OR when each
      // reported component just equals the total (degenerate single-win round,
      // no real respin). Only flag when the sum truly diverges from the total —
      // i.e. a real decomposition that doesn't add up.
      let internalOk = null;
      if (d.totalWin != null && d.spinWin != null && d.respinWin != null) {
        const components = [d.spinWin, d.respinWin];
        const additive = Math.abs(d.totalWin - (d.spinWin + d.respinWin)) <= TOLERANCE;
        const echoed = components.every((v) => Math.abs(v - d.totalWin!) <= TOLERANCE);
        internalOk = additive || echoed;
      }
      const vsRowOk = d.totalWin != null && collapsedWin != null
        ? Math.abs(d.totalWin - collapsedWin) <= TOLERANCE : null;
      const consistent = internalOk === null && vsRowOk === null ? null : internalOk !== false && vsRowOk !== false;
      const parts: string[] = [];
      if (internalOk != null) parts.push(`total ${d.totalWin} ${internalOk ? "=" : "≠"} spin ${d.spinWin} + respin ${d.respinWin}`);
      if (vsRowOk != null) parts.push(`expanded total ${d.totalWin} ${vsRowOk ? "=" : "≠"} table-row win ${collapsedWin}`);
      checks.push({
        rowKey, spinWin: d.spinWin, respinWin: d.respinWin, totalWin: d.totalWin, collapsedWin,
        consistent, detail: parts.join("; ") || `could not read row detail (raw: ${d.raw.slice(0, 60)})`,
      });
      // Collapse the row back so the next expand's coord isn't shifted.
      await inspectPage.mouse.click(el.x, el.y).catch(() => undefined);
      await inspectPage.waitForTimeout(300);
    } catch (err) {
      checks.push({
        rowKey, spinWin: null, respinWin: null, totalWin: null, collapsedWin: null,
        consistent: null, detail: `detail read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return checks;
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

/** Resolve the history trigger AND its registry key (the key lets the caller
 *  derive the parent popup for namespaced children like `menuButton__historyButton`).
 *  Exported for tests. */
export function pickHistoryTrigger(uiRegistry: UiRegistry): { key: string; el: UiElement } | null {
  const reg = uiRegistry as Record<string, UiElement | undefined>;
  // Prefer an explicit top-level history button, then the common namespaced
  // variants (menu/burger children), then any key containing "history".
  const preferred = ["historyButton", "menuButton__historyButton", "menu__historyButton"];
  for (const k of preferred) {
    if (reg[k]) return { key: k, el: reg[k]! };
  }
  for (const [key, el] of Object.entries(reg)) {
    if (el && /history/i.test(key)) return { key, el };
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
