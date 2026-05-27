// INVARIANT — UiBalanceMatchesApiRule
//
// Cross-checks UI-displayed balance (OCR'd by upstream and stamped into
// spin.raw._ocrBalance) against API-settled balance. Critical for catching
// UI lag / desync bugs that FinancialRule (server-only) can't see.

import { test, expect } from "@playwright/test";
import { UiBalanceMatchesApiRule } from "../../src/pipeline/step9-verify/ui-rule.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

function spin(opts: { balanceAfter: number; ocrBalance?: number | null; balanceFinite?: boolean }): NormalizedSpinResult {
  const raw: Record<string, unknown> = {};
  if (opts.ocrBalance !== undefined && opts.ocrBalance !== null) {
    raw._ocrBalance = opts.ocrBalance;
  }
  return {
    roundId: "r1",
    bet: 0.5,
    win: 0,
    balanceBefore: 100,
    balanceAfter: opts.balanceAfter,
    reels: [],
    cascadeFrames: [],
    state: "NORMAL",
    freeSpinsRemaining: null,
    isFreeSpin: false,
    hasBonus: false,
    raw,
  };
}

const rule = new UiBalanceMatchesApiRule();
const ctx = { previousBalance: null, previousState: null, roundIndex: 0 };

test("no _ocrBalance in raw → pass with no-ocr-data", () => {
  const r = rule.check(spin({ balanceAfter: 99.5 }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toBe("no-ocr-data");
  expect(r.severity).toBe("info");
});

test("OCR matches API exactly → pass", () => {
  const r = rule.check(spin({ balanceAfter: 99.5, ocrBalance: 99.5 }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toBeUndefined();
});

test("OCR within tolerance (4¢ drift) → pass", () => {
  const r = rule.check(spin({ balanceAfter: 100.0, ocrBalance: 99.96 }), ctx);
  expect(r.pass).toBe(true);
});

test("OCR outside tolerance (10¢ drift) → fail with diff in detail", () => {
  const r = rule.check(spin({ balanceAfter: 100.0, ocrBalance: 99.9 }), ctx);
  expect(r.pass).toBe(false);
  expect(r.severity).toBe("error");
  expect(r.detail).toContain("99.90");
  expect(r.detail).toContain("100.00");
  expect(r.actual).toBe(99.9);
  expect(r.expected).toBe(100.0);
});

test("OCR far above API balance → fail (UI lag forward)", () => {
  const r = rule.check(spin({ balanceAfter: 50.0, ocrBalance: 100.0 }), ctx);
  expect(r.pass).toBe(false);
  expect(r.detail).toMatch(/diff 50/);
});

test("OCR=0 + API positive → fail (UI didn't update)", () => {
  const r = rule.check(spin({ balanceAfter: 99.5, ocrBalance: 0 }), ctx);
  expect(r.pass).toBe(false);
});

test("non-finite OCR value treated as missing", () => {
  const s = spin({ balanceAfter: 100 });
  s.raw._ocrBalance = NaN;
  expect(rule.check(s, ctx).detail).toBe("no-ocr-data");
});

test("non-number OCR value treated as missing", () => {
  const s = spin({ balanceAfter: 100 });
  s.raw._ocrBalance = "99.50" as unknown as number;
  expect(rule.check(s, ctx).detail).toBe("no-ocr-data");
});

test("massive-spin api-mode regression: no raw OCR → silent pass, no false negative", () => {
  // Massive-spin samples loaded from dumped responses have no _ocrBalance
  // populated. Rule must not fail them en masse just because there's no UI
  // signal — that would flood reports with spurious "ui mismatch" errors
  // for non-UI samples.
  const r = rule.check(spin({ balanceAfter: 99.5 }), ctx);
  expect(r.pass).toBe(true);
});

test("infinite API balance → pass with no-api-balance", () => {
  const r = rule.check(spin({ balanceAfter: Infinity, ocrBalance: 100 }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toBe("no-api-balance");
});
