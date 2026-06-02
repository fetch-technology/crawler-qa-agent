// INVARIANT — parser determinism + numeric field guarantees
//
// For any well-formed (request, response) pair:
//   1. parseSpinPair returns the SAME NormalizedSpinResult on repeated calls
//   2. bet, win, balanceAfter are finite numbers (not NaN / undefined)
//   3. roundId is a non-empty string
//
// If broken: caching / replay / statistical aggregation all become unreliable.

import { test, expect } from "@playwright/test";
import { PragmaticParser } from "../../src/pipeline/step6-build-model/providers/pragmatic-parser.js";
import { ppRequestBody, ppResponseBody } from "./helpers.js";

// Minimal viable PP response body — needs enough fields for canParseResponse
// to score >= 4 (matches PragmaticProvider.scoreSpinShape).
// Required spin-shape fields: bb, ba, tw, sa, index, na (for state)
function ppFull(fields: Record<string, string | number>): string {
  return ppResponseBody({
    bb: 100, ba: 90, tw: 0, sa: "1,2,3,4,5", index: 1, na: "s",
    ...fields,
  });
}

const URL = "https://example.pragmatic.example/gs2c/v3/gameService";

test("same input → same output (lines game)", () => {
  const parser = new PragmaticParser();
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 90, tw: 0 });
  const r1 = parser.parseSpinPair(req, res, URL);
  const r2 = parser.parseSpinPair(req, res, URL);
  expect(r1).toEqual(r2);
});

test("same input → same output (ways game with betMultiplier hint)", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const req = ppRequestBody({ action: "doSpin", c: 0.45, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 91, tw: 0 });
  const r1 = parser.parseSpinPair(req, res, URL);
  const r2 = parser.parseSpinPair(req, res, URL);
  expect(r1).toEqual(r2);
  expect(r1.bet).toBe(9); // 0.45 * 20
});

test("numeric guarantees: bet, win, balanceAfter are finite numbers", () => {
  const parser = new PragmaticParser();
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 90, tw: 0 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(typeof r.bet).toBe("number");
  expect(Number.isFinite(r.bet)).toBe(true);
  expect(typeof r.win).toBe("number");
  expect(Number.isFinite(r.win)).toBe(true);
  expect(typeof r.balanceAfter).toBe("number");
  expect(Number.isFinite(r.balanceAfter)).toBe(true);
});

test("roundId is a non-empty string", () => {
  const parser = new PragmaticParser();
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 7, counter: 3 });
  const res = ppFull({ bb: 100, ba: 90 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(typeof r.roundId).toBe("string");
  expect(r.roundId.length).toBeGreaterThan(0);
});

test("different index/counter → different roundId (uniqueness across spins)", () => {
  const parser = new PragmaticParser();
  const r1 = parser.parseSpinPair(
    ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 }),
    ppFull({ bb: 100, ba: 90 }), URL,
  );
  const r2 = parser.parseSpinPair(
    ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 2, counter: 1 }),
    ppFull({ bb: 90, ba: 80 }), URL,
  );
  expect(r1.roundId).not.toBe(r2.roundId);
});

test("bet computed from request fields (lines: c × l when bl=0)", () => {
  const parser = new PragmaticParser();
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 90 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(10); // 0.5 * 20
});

test("bet computed from request fields (bet-level mode: c × bl when bl>0)", () => {
  const parser = new PragmaticParser();
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 10, bl: 5, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 97.5 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(2.5); // 0.5 * 5
});

test("setBetMultiplier override takes precedence over l", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const req = ppRequestBody({ action: "doSpin", c: 0.45, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 91 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(9); // 0.45 * 20, NOT 0.45 * 1024 = 460.8
});

test("setBetMultiplier(undefined) reverts to naive formula", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  parser.setBetMultiplier(undefined);
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 90 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(10); // 0.5 * 20 (naive c × l, NOT × 20 multiplier)
});

// === Mechanic-aware bet formula (2026-05-29 — fix path 2) ===
// REGRESSION: a stale `betMultiplier` from balance-derived game-mechanics.json
// (e.g. derived at bet level 2 → 40 for a 20-line game) made `c × M` overshoot.
// The fix: when mechanic === "lines", IGNORE betMultiplier and use the
// request `l`/`bl` directly. Other mechanics (ways/cluster) still use M.

test("mechanic=lines: uses c × l, IGNORES stale betMultiplier", () => {
  const parser = new PragmaticParser();
  parser.setMechanic("lines");
  parser.setBetMultiplier(40); // stale / wrong — must be bypassed for lines games
  const req = ppRequestBody({ action: "doSpin", c: 0.01, l: 20, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 99995529.55, ba: 99995529.35 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(0.2); // 0.01 × 20 (lines mode) — NOT 0.4 from stale M
});

test("mechanic=lines: bet-level mode uses c × bl when bl>0", () => {
  const parser = new PragmaticParser();
  parser.setMechanic("lines");
  parser.setBetMultiplier(99); // ignored
  const req = ppRequestBody({ action: "doSpin", c: 0.5, l: 10, bl: 5, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 97.5 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(2.5); // 0.5 × 5 (bl-as-multiplier)
});

test("mechanic=ways: still trusts betMultiplier (l is the ways count, not stake)", () => {
  const parser = new PragmaticParser();
  parser.setMechanic("ways");
  parser.setBetMultiplier(20);
  // Mahjong Ways-style: l=1024 ways, c=0.01, true bet = 0.20.
  const req = ppRequestBody({ action: "doSpin", c: 0.01, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 99.8 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(0.2); // 0.01 × 20 (M from game-mechanics), NOT 0.01 × 1024 = 10.24
});

test("setMechanic(undefined) falls back to legacy PP convention", () => {
  const parser = new PragmaticParser();
  parser.setMechanic("lines");
  parser.setMechanic(undefined);
  parser.setBetMultiplier(20);
  // No mechanic + M set → c × M path (legacy behaviour preserved).
  const req = ppRequestBody({ action: "doSpin", c: 0.45, l: 1024, bl: 0, index: 1, counter: 1 });
  const res = ppFull({ bb: 100, ba: 91 });
  const r = parser.parseSpinPair(req, res, URL);
  expect(r.bet).toBe(9);
});

test("canParseResponse rejects non-PP URL", () => {
  const parser = new PragmaticParser();
  const res = ppFull({});
  expect(parser.canParseResponse(res, "https://unrelated.example.com/api/foo")).toBe(false);
});

test("canParseResponse rejects body without spin-shape fields", () => {
  const parser = new PragmaticParser();
  // Wallet-only response, no spin fields → score too low
  expect(parser.canParseResponse("balance=100&currency=USD", URL)).toBe(false);
});

test("parseResponse fallback (no request) produces a result with bet=0 but stable roundId", () => {
  const parser = new PragmaticParser();
  const res = ppFull({ bb: 100, ba: 90, index: 5 });
  const r = parser.parseResponse(res);
  expect(r.bet).toBe(0); // No request → can't compute c × M
  expect(typeof r.roundId).toBe("string");
  expect(r.roundId.length).toBeGreaterThan(0);
});
