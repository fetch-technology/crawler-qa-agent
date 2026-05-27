// INVARIANT — Post-parser FS re-evaluation (2026-05-26 fourth pass)
//
// Real root cause discovered: PP spin responses have NO `bb` field — server
// only emits `balance` (=balanceAfter). Parser can't tell if balance
// decreased → conservatively marks fs>0 spins as NORMAL.
//
// case-executor patches balanceBefore from priorBalance AFTER parser
// returns. THEN re-evaluates isFreeSpin using full balance context:
//   - fs>0 + balance stable/up → promote to FREE_SPIN, bet=0
//   - fs>0 + balance dropped (BUY) → keep NORMAL, bet stays
//   - fs=0 → keep whatever parser said
//
// Critical: BUY transaction (fs=1 but drop=44) must STAY NORMAL with bet=0.5
// so buy-feature ratio detection works.

import { test, expect } from "@playwright/test";

// Replicate the post-patch FS re-eval logic from case-executor.ts.
function reEvaluateFsAfterPatch(spin: {
  freeSpinsRemaining: number | null;
  balanceBefore: number | null;
  balanceAfter: number;
  bet: number;
  isFreeSpin: boolean;
  state: string;
}): { isFreeSpin: boolean; bet: number; state: string } {
  const fsRemaining = spin.freeSpinsRemaining ?? 0;
  if (fsRemaining > 0
      && spin.balanceBefore != null
      && Number.isFinite(spin.balanceAfter)) {
    const drop = spin.balanceBefore - spin.balanceAfter;
    const balanceDidNotDecrease = drop <= 0.01;
    if (balanceDidNotDecrease && !spin.isFreeSpin) {
      return { isFreeSpin: true, bet: 0, state: "FREE_SPIN" };
    }
  }
  return { isFreeSpin: spin.isFreeSpin, bet: spin.bet, state: spin.state };
}

test("BUY transaction (fs>0, balance DROPPED) → stays NORMAL with bet=0.5", () => {
  // Spin #1 of buy-feature flow. PP server emits fs=1 (forward counter)
  // but balance drops by buy cost. Parser said NORMAL conservatively.
  // After balanceBefore patched from priorBalance, drop=44 confirmed.
  // Re-eval keeps NORMAL since balance decreased.
  const spinAfterParser = {
    freeSpinsRemaining: 1,
    balanceBefore: 99996573.86,  // post-patch from priorBalance
    balanceAfter: 99996529.86,
    bet: 0.5,                     // parser stamped from c * M (NORMAL)
    isFreeSpin: false,             // parser conservatively defaulted
    state: "NORMAL",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(false);     // ← still NORMAL
  expect(result.bet).toBe(0.5);              // bet preserved
  expect(result.state).toBe("NORMAL");
});

test("FS frame mid-chain (fs>0, balance STABLE) → promoted to FREE_SPIN with bet=0", () => {
  // After BUY, FS chain starts. Each frame has fs>0 + no balance change.
  // Parser said NORMAL (no bb field → balanceUnknown → conservative).
  // Re-eval promotes to FS since balance didn't decrease.
  const spinAfterParser = {
    freeSpinsRemaining: 8,
    balanceBefore: 99996529.86,
    balanceAfter: 99996529.86,
    bet: 0.5,                     // parser stamped (didn't know it was FS)
    isFreeSpin: false,
    state: "NORMAL",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(true);      // ← promoted to FS
  expect(result.bet).toBe(0);                 // ← bet zeroed
  expect(result.state).toBe("FREE_SPIN");
});

test("FS chain ending frame (fs>0, balance INCREASED with chain credit) → FREE_SPIN, bet=0", () => {
  // Last FS frame credits chain win → balance goes UP, not down.
  const spinAfterParser = {
    freeSpinsRemaining: 1,
    balanceBefore: 99996529.86,
    balanceAfter: 99996594.71,    // chain win credited
    bet: 0.5,
    isFreeSpin: false,
    state: "NORMAL",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(true);
  expect(result.bet).toBe(0);
});

test("Normal spin (fs=0) → unchanged regardless of balance", () => {
  const spinAfterParser = {
    freeSpinsRemaining: 0,
    balanceBefore: 100,
    balanceAfter: 99.5,
    bet: 0.5,
    isFreeSpin: false,
    state: "NORMAL",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(false);
  expect(result.bet).toBe(0.5);
  expect(result.state).toBe("NORMAL");
});

test("balanceBefore unknown (priorBalance patch failed) → unchanged from parser", () => {
  const spinAfterParser = {
    freeSpinsRemaining: 5,
    balanceBefore: null,
    balanceAfter: 1000,
    bet: 0.5,
    isFreeSpin: false,             // parser conservatively defaulted
    state: "NORMAL",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(false);     // still NORMAL — can't promote
  expect(result.bet).toBe(0.5);
});

test("Parser already flagged FS (e.g., explicit isfreespin field) → not re-eval-ed", () => {
  const spinAfterParser = {
    freeSpinsRemaining: 3,
    balanceBefore: 1000,
    balanceAfter: 1005,
    bet: 0,
    isFreeSpin: true,              // parser already correctly flagged
    state: "FREE_SPIN",
  };
  const result = reEvaluateFsAfterPatch(spinAfterParser);
  expect(result.isFreeSpin).toBe(true);     // preserved
  expect(result.bet).toBe(0);
});

// === Synthesis trigger gate (uses isFreeSpin OR freeSpinsRemaining > 0) ===

test("synthesis triggers on isFreeSpin=true (primary signal)", () => {
  const collectedSpins = [
    { isFreeSpin: false, freeSpinsRemaining: 0 },
    { isFreeSpin: true, freeSpinsRemaining: 5 },
  ];
  const hasFsSpins = collectedSpins.some((s) =>
    s.isFreeSpin === true || (s.freeSpinsRemaining ?? 0) > 0,
  );
  expect(hasFsSpins).toBe(true);
});

test("synthesis triggers on freeSpinsRemaining > 0 even if isFreeSpin=false (fallback)", () => {
  // Regression: previously only checked isFreeSpin. If parser/re-eval missed
  // a spin (e.g., bug or version drift) but spin has fs > 0 raw, synthesis
  // should still fire so buy-state-transition assertion can pass.
  const collectedSpins = [
    { isFreeSpin: false, freeSpinsRemaining: 0 },
    { isFreeSpin: false, freeSpinsRemaining: 3 }, // fs > 0 but missed promotion
  ];
  const hasFsSpins = collectedSpins.some((s) =>
    s.isFreeSpin === true || (s.freeSpinsRemaining ?? 0) > 0,
  );
  expect(hasFsSpins).toBe(true);
});

test("synthesis NOT triggered when no spin has any FS signal", () => {
  const collectedSpins = [
    { isFreeSpin: false, freeSpinsRemaining: 0 },
    { isFreeSpin: false, freeSpinsRemaining: 0 },
  ];
  const hasFsSpins = collectedSpins.some((s) =>
    s.isFreeSpin === true || (s.freeSpinsRemaining ?? 0) > 0,
  );
  expect(hasFsSpins).toBe(false);
});

test("synthesis NOT triggered when freeSpinsRemaining is null", () => {
  const collectedSpins = [
    { isFreeSpin: false, freeSpinsRemaining: null },
  ];
  const hasFsSpins = collectedSpins.some((s) =>
    s.isFreeSpin === true || ((s.freeSpinsRemaining as number | null) ?? 0) > 0,
  );
  expect(hasFsSpins).toBe(false);
});

test("user's full case: BUY + 15 FS frames → after re-eval", () => {
  const spins = [
    // BUY (drop 44)
    { freeSpinsRemaining: 1, balanceBefore: 99996573.86, balanceAfter: 99996529.86, bet: 0.5, isFreeSpin: false, state: "NORMAL" },
    // 14 mid-chain FS (no balance change)
    ...Array.from({ length: 14 }, () => ({
      freeSpinsRemaining: 5,
      balanceBefore: 99996529.86,
      balanceAfter: 99996529.86,
      bet: 0.5,
      isFreeSpin: false,
      state: "NORMAL",
    })),
    // Final FS (chain credit)
    { freeSpinsRemaining: 0, balanceBefore: 99996529.86, balanceAfter: 99996594.71, bet: 0.5, isFreeSpin: false, state: "NORMAL" },
  ];
  const out = spins.map(reEvaluateFsAfterPatch);

  // BUY: stays NORMAL with bet=0.5
  expect(out[0]!.isFreeSpin).toBe(false);
  expect(out[0]!.bet).toBe(0.5);

  // Mid-chain FS: promoted to FREE_SPIN with bet=0
  for (let i = 1; i <= 14; i++) {
    expect(out[i]!.isFreeSpin).toBe(true);
    expect(out[i]!.bet).toBe(0);
  }

  // Last spin (fs=0): unchanged from parser (NORMAL)
  expect(out[15]!.isFreeSpin).toBe(false);
  expect(out[15]!.bet).toBe(0.5);
});
