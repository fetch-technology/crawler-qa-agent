/**
 * UI verifier — verify game canvas hiển thị đúng giá trị từ (mock) response.
 *
 * Game canvas render text bằng pixel → không có DOM để query. Cần LLM vision
 * OCR đọc số balance/bet/last_win → compare với mock response chúng ta vừa
 * trả.
 *
 * Wrap quanh `readScreenValues` + `assertScreenMatchesAPI` đã có trong
 * test-harness — tách thành module riêng để hybrid test import mà không kéo
 * theo phụ thuộc LLM-runtime của test-harness (doAutoSpin, openHistoryPanel).
 *
 * Cost: 1 LLM call (~$0.05) mỗi `assertUIMatchesResponse`. Cho hybrid test
 * 27-33 case = ~$1.50-$2 extra per full run.
 *
 * Caller có thể skip qua env QA_SKIP_UI_VERIFY=1 (vd CI muốn nhanh).
 */

import type { Page } from "playwright";
import {
  transcribePlayScreenValues,
  type TranscribedScreenValues,
} from "../ai/vision.js";
import { getScreenshotStore } from "./screenshot-store.js";
import { assertRegionMatches, baselinePath } from "./region-snapshot.js";
import { existsSync } from "node:fs";

export type UIVerifyOptions = {
  /** Tolerance khi so float. Default 0.01 (1 cent). */
  tolerance?: number;
  /** Bỏ check balance UI. Default false. */
  skipBalance?: boolean;
  /** Bỏ check bet UI. Default false. */
  skipBet?: boolean;
  /** Bỏ check last_win UI. Default false (cascade game UI khác). */
  skipLastWin?: boolean;
  /** Label cho screenshot debug. Default "ui-verify". */
  label?: string;
  /** Wait time trước OCR để UI render xong (animation). Default 1500ms. */
  preReadWaitMs?: number;
  /**
   * Game slug — dùng làm thư mục baseline region snapshot. Required cho
   * combo region + OCR. Nếu null → bypass region snapshot, dùng OCR always.
   */
  slug?: string;
  /**
   * Test case ID — dùng tên baseline (unique per case + override combo).
   * Nếu null → OCR always.
   */
  caseId?: string;
  /**
   * Vùng UI bar capture cho region snapshot. Default: bottom strip
   * { x: 0, y: 800, width: 1440, height: 100 } — cover hầu hết slot game's
   * balance/bet/win row.
   */
  uiRegion?: { x: number; y: number; width: number; height: number };
};

export type ExpectedUIValues = {
  /** Expected balance hiển thị trên UI (vd endingBalance). */
  balance?: number | null;
  /** Expected bet display (vd betAmount). */
  bet?: number | null;
  /** Expected last_win display (vd winAmount). */
  lastWin?: number | null;
};

export type UIMismatch = {
  field: "balance" | "bet" | "last_win";
  expected: number;
  actual: number | null;
  delta: number | null;
  explanation: string;
};

/**
 * Verify UI display khớp expected values từ mock response.
 *
 * Combo strategy (region snapshot + OCR fallback):
 *   1. Wait UI render settle
 *   2. Nếu có slug + caseId → check region snapshot baseline:
 *      - Baseline tồn tại + pixel match → PASS (no LLM, fast, $0)
 *      - Baseline tồn tại nhưng pixel diff → fall through OCR để diagnose
 *      - Baseline KHÔNG tồn tại → OCR verify trước → save region as new baseline
 *   3. OCR readScreenValues → compare từng field với expected
 *
 * Lần đầu chạy: dùng OCR ($0.05), save baseline.
 * Lần sau: pixel diff ($0, ~50ms) → 90%+ trường hợp không cần OCR.
 *
 * Override: QA_SKIP_UI_VERIFY=1 → skip toàn bộ.
 */
export async function assertUIMatchesResponse(
  page: Page,
  expected: ExpectedUIValues,
  options: UIVerifyOptions = {},
): Promise<{ ok: true; uiValues: TranscribedScreenValues; method: "snapshot" | "ocr" }> {
  // Bypass toàn bộ via env
  if (process.env.QA_SKIP_UI_VERIFY === "1") {
    return {
      ok: true,
      uiValues: { balance: null, bet: null, last_win: null, currency: null } as TranscribedScreenValues,
      method: "snapshot",
    };
  }

  const tolerance = options.tolerance ?? 0.01;
  const label = options.label ?? "ui-verify";
  const waitMs = options.preReadWaitMs ?? 1500;
  const uiRegion = options.uiRegion ?? { x: 0, y: 800, width: 1440, height: 100 };

  // Wait cho UI animation settle
  await page.waitForTimeout(waitMs);

  // ===== Phase 1: Try region snapshot baseline =====
  if (options.slug && options.caseId) {
    const baselineName = `${options.caseId}-ui`;
    const baselineExists = existsSync(baselinePath(options.slug, baselineName));

    if (baselineExists) {
      try {
        await assertRegionMatches(page, {
          slug: options.slug,
          name: baselineName,
          region: uiRegion,
          maxDiffRatio: 0.02,
        });
        // Pixel match → UI hasn't drifted → PASS without LLM
        return {
          ok: true,
          uiValues: { balance: null, bet: null, last_win: null, currency: null } as TranscribedScreenValues,
          method: "snapshot",
        };
      } catch (snapshotErr) {
        // Pixel mismatch → fall through OCR để diagnose chính xác field nào sai
        console.warn(
          `[ui-verifier] Snapshot mismatch for ${options.caseId} — falling back to OCR. ` +
            `(${(snapshotErr as Error).message.split("\n")[0]})`,
        );
      }
    }
    // Nếu baseline chưa tồn tại → fall through OCR + sẽ save baseline ở cuối
  }

  // ===== Phase 2: OCR fallback (lần đầu hoặc snapshot mismatch) =====
  const store = getScreenshotStore();
  const shotPath = await store.take(page, label);
  const ui = await transcribePlayScreenValues({ screenshotPath: shotPath });

  // So sánh từng field
  const mismatches: UIMismatch[] = [];

  const checkField = (
    field: "balance" | "bet" | "last_win",
    expectedVal: number | null | undefined,
    uiVal: number | null | undefined,
    skip: boolean | undefined,
  ) => {
    if (skip) return;
    if (expectedVal == null) return; // không có expected → skip
    if (uiVal == null) return; // UI không hiển thị → skip (vd game không có win display)
    const delta = Math.abs(uiVal - expectedVal);
    if (delta > tolerance) {
      mismatches.push({
        field,
        expected: expectedVal,
        actual: uiVal,
        delta,
        explanation: `UI ${field} = ${uiVal} ≠ expected ${expectedVal} (delta=${delta.toFixed(4)} > tol=${tolerance})`,
      });
    }
  };

  checkField("balance", expected.balance, ui.balance, options.skipBalance);
  checkField("bet", expected.bet, ui.bet, options.skipBet);
  checkField("last_win", expected.lastWin, ui.last_win, options.skipLastWin);

  if (mismatches.length > 0) {
    const detail = mismatches.map((m) => `  - ${m.explanation}`).join("\n");
    const uiDump = `UI read: balance=${ui.balance}, bet=${ui.bet}, last_win=${ui.last_win}, currency=${ui.currency}`;
    const expectedDump = `Expected: balance=${expected.balance}, bet=${expected.bet}, last_win=${expected.lastWin}`;
    throw new Error(
      `UI display mismatch (${mismatches.length} field(s) lệch):\n${detail}\n\n${expectedDump}\n${uiDump}\n\nDebug screenshot: ${shotPath}`,
    );
  }

  // OCR PASS → save current region as new baseline cho lần sau (free fast path)
  if (options.slug && options.caseId) {
    const baselineName = `${options.caseId}-ui`;
    if (!existsSync(baselinePath(options.slug, baselineName))) {
      // First-time capture: assertRegionMatches sẽ tự save khi baseline chưa có
      try {
        await assertRegionMatches(page, {
          slug: options.slug,
          name: baselineName,
          region: uiRegion,
          maxDiffRatio: 0.02,
        });
      } catch {
        // Ignore — baseline save failure không phải fatal
      }
    }
  }

  return { ok: true, uiValues: ui, method: "ocr" };
}

/**
 * Convenience: extract expected từ parsed spin response (mock-driven).
 *
 * Đọc các field thông dụng cross-provider:
 *   - balance / endingBalance / updatedBalance
 *   - betAmount / c (PP coin × level)
 *   - winAmount / tw
 */
export function extractExpectedFromResponse(
  parsed: Record<string, unknown> | null,
): ExpectedUIValues {
  if (!parsed) return {};
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  // Balance: endingBalance > updatedBalance > balance
  const balance =
    num(parsed.endingBalance) ??
    num((parsed as any).updatedBalance) ??
    num((parsed as any).balance);

  // Bet: betAmount > totalBet > computed from c × l (PP)
  let bet = num(parsed.betAmount) ?? num((parsed as any).totalBet);
  if (bet == null) {
    const c = num((parsed as any).c);
    const l = num((parsed as any).l) ?? num((parsed as any).bl);
    if (c != null && l != null) bet = c * l;
  }

  // Win: winAmount > tw (PP total win)
  const lastWin = num(parsed.winAmount) ?? num((parsed as any).tw);

  return { balance, bet, lastWin };
}
