/**
 * Verify preflight checker catches the fortune-pig wallet-snapshot bug.
 *
 * Mock 1 ExecutionStrategy "tử tế" + samples thực sự thu được từ
 * /api/v1/wallet/play (totalBet=0, totalWin=0) → preflight phải FAIL với
 * lý do rõ ràng.
 */
import { runExecutionPreflight, formatPreflightResult } from "./ai/execution-preflight.js";
import type { ExecutionStrategy } from "./ai/authoring.js";

console.log("============================================================");
console.log(" PREFLIGHT TEST 1: fortune-pig wallet-snapshot (should FAIL)");
console.log("============================================================");

// Đây là response THẬT từ /api/v1/wallet/play sau khi áp field_mapping
// (bet=totalBet, win=totalWin, balance=balance, ending_balance=balance)
const fortunePigSamples = [
  {
    playerId: "id_AtbpGnqs5ltJNbbgS1S5Yl8n_USD",
    brandCode: "rcdemo",
    gameCode: "fortune-pig",
    offerId: 0,
    walletType: "CASH",
    rolloverMode: "Cash",
    balance: 0,
    totalBet: 0,
    totalWin: 0,
    // Sau applyFieldMapping, các field normalized này sẽ được tạo:
    betAmount: 0,
    winAmount: 0,
    endingBalance: 0,
    // startingBalance KHÔNG có (mapping null) → undefined
  },
  // Repeat 2 lần (như recording thật — 2 wallet snapshots)
  {
    playerId: "id_AtbpGnqs5ltJNbbgS1S5Yl8n_USD",
    balance: 0,
    totalBet: 0,
    totalWin: 0,
    betAmount: 0,
    winAmount: 0,
    endingBalance: 0,
  },
];

const strategy: ExecutionStrategy = {
  channel: "http",
  spin_endpoint_evidence: {
    pattern: "/api/v1/wallet/play",
    evidence_in_samples: "(AI claimed this is spin endpoint)",
    rejected_candidates: [],
  },
  completion_signal: {
    method: "single_response",
    tumble_aware: false,
    free_spin_chains: false,
  },
  field_validation: [
    { field: "betAmount", required: true, type: "number", min: 0.01 },
    { field: "winAmount", required: true, type: "number", min: 0 },
    { field: "endingBalance", required: true, type: "number", min: 0 },
    { field: "startingBalance", required: true, type: "number", min: 0 },
  ],
  preflight_checks: [
    {
      id: "spin-not-wallet-snapshot",
      description: "At least one sample must have non-zero bet (rejects wallet snapshot)",
      rule: { kind: "all_samples_field_nonzero", args: { field: "betAmount" } },
    },
    {
      id: "win-field-numeric",
      description: "winAmount must be a number, not undefined/null",
      rule: { kind: "field_type", args: { field: "winAmount", expected: "number" } },
    },
    {
      id: "win-varies",
      description: "winAmount should vary across samples",
      rule: { kind: "samples_field_varies", args: { field: "winAmount" } },
    },
    {
      id: "matrix-present",
      description: "matrix field should exist in spin responses",
      rule: { kind: "any_sample_field_present", args: { field: "matrix" } },
    },
  ],
};

const r1 = runExecutionPreflight(strategy, fortunePigSamples);
console.log(formatPreflightResult(r1));
console.log(`\n→ Expected: FAIL (wallet snapshot all-zero)`);
console.log(`→ Actual: ${r1.ok ? "PASS (BUG: should have failed!)" : "FAIL ✓"}`);

console.log("\n============================================================");
console.log(" PREFLIGHT TEST 2: real spin samples (should PASS)");
console.log("============================================================");

// Mock real spin samples — varied bet/win, có matrix
const realSpinSamples = [
  {
    betAmount: 0.20, winAmount: 0.50, endingBalance: 100.30, startingBalance: 100.00,
    matrix: "1,2,3,4,5,6,7,8,9", isEndRound: true, status: "OK",
  },
  {
    betAmount: 0.20, winAmount: 0.00, endingBalance: 100.10, startingBalance: 100.30,
    matrix: "9,8,7,6,5,4,3,2,1", isEndRound: true, status: "OK",
  },
  {
    betAmount: 0.20, winAmount: 1.20, endingBalance: 101.10, startingBalance: 100.10,
    matrix: "5,5,5,1,2,3,4,5,6", isEndRound: true, status: "OK",
  },
];

const r2 = runExecutionPreflight(strategy, realSpinSamples);
console.log(formatPreflightResult(r2));
console.log(`\n→ Expected: PASS (real spin, varied data)`);
console.log(`→ Actual: ${r2.ok ? "PASS ✓" : "FAIL (false alarm)"}`);

console.log("\n============================================================");
console.log(" PREFLIGHT TEST 3: spins with undefined winAmount (should FAIL)");
console.log("============================================================");

// Mock samples khi field_mapping wrong → winAmount undefined
const undefinedWinSamples = [
  { betAmount: 0.20, winAmount: undefined, endingBalance: 100, startingBalance: 100 },
  { betAmount: 0.20, winAmount: undefined, endingBalance: 99.80, startingBalance: 100 },
];

const r3 = runExecutionPreflight(strategy, undefinedWinSamples);
console.log(formatPreflightResult(r3));
console.log(`\n→ Expected: FAIL (winAmount undefined)`);
console.log(`→ Actual: ${r3.ok ? "PASS (BUG)" : "FAIL ✓"}`);

console.log("\n============================================================");
console.log(" PREFLIGHT TEST 4: fortune-pig spin response shape (should PASS)");
console.log("============================================================");

// Real fortune-pig spin response shape (theo log từ user)
// betAmount=25, winAmount=125, endingBalance=996602.56, matrix=array of objects, NO updatedBalance NO isEndRound
const fortunePigRealSpins = [
  {
    id: "01KQRDCG4M6JYQS926BDW7RHFN",
    betAmount: 25, winAmount: 125, endingBalance: 996602.56,
    matrix: [[{ symbol: 99, value: 0, type: 2 }, { symbol: 6, value: 0, type: 0 }, { symbol: 3, value: 0 }]],
    status: "RESOLVED",
    // NO updatedBalance, NO isEndRound — fortune-pig schema khác
  },
  {
    id: "01KQRDCH22M6KYQS926BDW7XYZ",
    betAmount: 25, winAmount: 0, endingBalance: 996577.56,
    matrix: [[{ symbol: 99, value: 0, type: 2 }, { symbol: 4, value: 0, type: 0 }]],
    status: "RESOLVED",
  },
  {
    id: "01KQRDCJ55M6LYQS926BDW7ABC",
    betAmount: 25, winAmount: 12.50, endingBalance: 996590.06,
    matrix: [[{ symbol: 5, value: 0 }, { symbol: 6, value: 0 }]],
    status: "RESOLVED",
  },
];

// Strategy AI sinh từ log thực — giả lập over-specify như log đã thấy
const fortunePigStrategy: ExecutionStrategy = {
  channel: "http",
  spin_endpoint_evidence: { pattern: "/fortune-pig/spin", evidence_in_samples: "matrix array varies", rejected_candidates: [] },
  completion_signal: { method: "single_response", tumble_aware: false, free_spin_chains: false },
  field_validation: [
    { field: "betAmount", required: true, type: "number", min: 0.01 },
    { field: "winAmount", required: true, type: "number", min: 0 },
    { field: "endingBalance", required: true, type: "number", min: 0 },
    { field: "updatedBalance", required: true, type: "number", min: 0 },  // AI hallucinate
    { field: "isEndRound", required: true, type: "boolean" },              // AI hallucinate
    { field: "matrix", required: true, type: "array" },                    // CORRECT now (was bug before)
  ],
  preflight_checks: [
    { id: "spin-not-wallet", description: "betAmount nonzero", rule: { kind: "all_samples_field_nonzero", args: { field: "betAmount" } } },
    { id: "win-numeric", description: "winAmount is number", rule: { kind: "field_type", args: { field: "winAmount", expected: "number" } } },
    { id: "matrix-present", description: "matrix is non-empty array", rule: { kind: "field_array_nonempty", args: { field: "matrix" } } },
    { id: "status-resolved", description: "status RESOLVED", rule: { kind: "field_equals", args: { field: "status", value: "RESOLVED" } } },
    { id: "unknown-rule-test", description: "AI sinh rule lạ", rule: { kind: "field_matches_regex", args: { field: "id" } } }, // unknown → skip warn
  ],
};

const r4 = runExecutionPreflight(fortunePigStrategy, fortunePigRealSpins);
console.log(formatPreflightResult(r4));
console.log(`\n→ Expected: PASS (real spin samples; AI over-specify updatedBalance/isEndRound → warning chứ không error)`);
console.log(`→ Actual: ${r4.ok ? "PASS ✓" : "FAIL"}`);

console.log("\n============================================================");
console.log(" PREFLIGHT TEST 5: Pragmatic cascade — backward compat (should PASS)");
console.log(" — Spec cũ có thể đã sinh field_type:'object' cho matrix array");
console.log("============================================================");

// Pragmatic Sweet Bonanza style cascade — multi-response per UI spin
// Sample is intermediate tumble (winAmount=0) hoặc end-of-cascade (winAmount=large)
const ppCascadeSamples = [
  {
    id: "round-1-tumble-0", betAmount: 2, winAmount: 0, endingBalance: 100, startingBalance: 100,
    matrix: [["P1","P2","P3"],["P4","P5","P6"],["P7","P8","P9"]],  // 2D array
    isEndRound: false, isFreeSpin: false, status: "OK",
  },
  {
    id: "round-1-tumble-1", betAmount: 2, winAmount: 5, endingBalance: 105, startingBalance: 100,
    matrix: [["P1","P2","P3"],["P4","P5","P6"],["P7","P8","P9"]],
    isEndRound: true, isFreeSpin: false, status: "OK",
  },
  {
    id: "round-2-tumble-0", betAmount: 2, winAmount: 0, endingBalance: 103, startingBalance: 105,
    matrix: [["P1","P2","P3"],["P4","P5","P6"],["P7","P8","P9"]],
    isEndRound: false, isFreeSpin: false, status: "OK",
  },
];

// Strategy giả lập SPEC CŨ: AI đã sinh field_type:"object" cho matrix (vì prompt cũ chưa nói "array")
const ppOldStrategy: ExecutionStrategy = {
  channel: "http",
  spin_endpoint_evidence: { pattern: "/sweet-bonanza/spin", evidence_in_samples: "cascade", rejected_candidates: [] },
  completion_signal: { method: "isEndRound_true", tumble_aware: true, free_spin_chains: true },
  field_validation: [
    { field: "betAmount", required: true, type: "number", min: 0.01 },
    { field: "winAmount", required: true, type: "number", min: 0 },
    { field: "endingBalance", required: true, type: "number", min: 0 },
    { field: "isEndRound", required: true, type: "boolean" },
    { field: "matrix", required: true, type: "object" },  // ← SPEC CŨ dùng "object" — phải vẫn pass (lenient)
  ],
  preflight_checks: [
    { id: "spin-not-wallet", description: "betAmount nonzero", rule: { kind: "all_samples_field_nonzero", args: { field: "betAmount" } } },
    { id: "win-numeric", description: "winAmount is number", rule: { kind: "field_type", args: { field: "winAmount", expected: "number" } } },
    { id: "matrix-object-or-array", description: "matrix should be object/array (legacy)", rule: { kind: "field_type", args: { field: "matrix", expected: "object" } } },
  ],
};

const r5 = runExecutionPreflight(ppOldStrategy, ppCascadeSamples);
console.log(formatPreflightResult(r5));
console.log(`\n→ Expected: PASS (matrix expected="object" lenient match với array — backward compat)`);
console.log(`→ Actual: ${r5.ok ? "PASS ✓" : "FAIL (regression!)"}`);

console.log("\n============================================================");
console.log(" PREFLIGHT TEST 6: spec cũ KHÔNG có execution_strategy (skip preflight)");
console.log("============================================================");

// Mô phỏng trường hợp load spec.json cũ → spec.execution_strategy = undefined
// Code phải handle gracefully (không crash). Ta test bằng cách gọi với strategy rỗng.
const emptyStrategy: ExecutionStrategy = {
  channel: "http",
  spin_endpoint_evidence: { pattern: null, evidence_in_samples: "", rejected_candidates: [] },
  completion_signal: { method: "single_response", tumble_aware: false, free_spin_chains: false },
  field_validation: [],
  preflight_checks: [],
};
const r6 = runExecutionPreflight(emptyStrategy, ppCascadeSamples);
console.log(formatPreflightResult(r6));
console.log(`\n→ Expected: PASS (no rules → vacuously true)`);
console.log(`→ Actual: ${r6.ok ? "PASS ✓" : "FAIL"}`);

console.log("\n=========== SUMMARY ===========");
const allCorrect = !r1.ok && r2.ok && !r3.ok && r4.ok && r5.ok && r6.ok;
console.log(allCorrect ? "✔ All 6 tests behaved correctly (3 should-fail + 3 should-pass)" : "✗ At least 1 test misbehaved");
process.exit(allCorrect ? 0 : 1);
