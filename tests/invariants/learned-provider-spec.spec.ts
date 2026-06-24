// INVARIANT — learned provider spec (deep-path SpecDrivenParser + verifier)
//
// The AI provider-spec learner emits a ProviderSpec with DEEP field paths
// (context.spins.round_win, user.balance), an amountScale (cents→display), a
// response-side betAmount, deriveBalanceBefore, and a json_array board. The
// generic SpecDrivenParser must honor all of these so a learned spec parses a
// 3-Oaks-shaped provider WITHOUT any hardcoded parser. verifyLearnedSpec then
// gates acceptance on arithmetic, not the model's say-so.

import { test, expect } from "@playwright/test";
import { SpecDrivenParser } from "../../src/pipeline/step6-build-model/providers/spec-driven-parser.ts";
import { verifyLearnedSpec } from "../../src/ai/learn-provider-spec.ts";
import type { ProviderSpec } from "../../src/pipeline/step6-build-model/providers/spec-types.ts";

const THREEOAKS_SPEC: ProviderSpec = {
  name: "ThreeOaksLearned",
  wireFormat: "json",
  urlPatterns: ["3oaks"],
  response: {
    fields: {
      balanceAfter: "user.balance",
      betAmount: "context.spins.round_bet",
      totalWin: "context.spins.round_win",
      initialReels: "context.spins.board",
    },
    reelsDecoder: "json_array",
    defaultReelDimensions: { width: 5, height: 4 },
    amountScale: 0.01,
    deriveBalanceBefore: true,
    shapeScore: { requiredFields: ["context.spins.board", "user.balance"], bonusFields: [], minScore: 2 },
    winItemization: "none",
  },
  request: { fields: {}, betFormula: "explicit" },
  roundId: { source: "response", fields: ["request_id"], fallback: "response_hash" },
};

const RESP = JSON.stringify({
  command: "play",
  context: {
    round_finished: true,
    current: "spins",
    spins: {
      bet_per_line: 2, lines: 25, round_bet: 50, round_win: 20, total_win: 20,
      board: [[10, 3, 3, 3], [3, 7, 5, 5], [9, 9, 9, 2], [2, 2, 11, 11], [8, 8, 8, 3]],
    },
  },
  request_id: "028ef8ef",
  user: { balance: 100905650, currency: "BRL" },
});
const URL = "https://api.3oaks.sandbox.revenge-games.com/gs/black_wolf_2/desktop/x/3oaksdemo?gsc=play";

test("deep-path spec accepts the 3 Oaks response", () => {
  const p = new SpecDrivenParser(THREEOAKS_SPEC, "GenericParser");
  expect(p.canParseResponse(RESP, URL)).toBe(true);
});

test("deep-path + amountScale → display-unit bet/win/balance", () => {
  const p = new SpecDrivenParser(THREEOAKS_SPEC, "GenericParser");
  const s = p.parseSpinPair!(null, RESP, URL);
  expect(s.bet).toBeCloseTo(0.5, 5);       // round_bet 50 × 0.01
  expect(s.win).toBeCloseTo(0.2, 5);       // round_win 20 × 0.01
  expect(s.balanceAfter).toBeCloseTo(1009056.5, 2);
});

test("deriveBalanceBefore reconstructs the pre-bet balance", () => {
  const p = new SpecDrivenParser(THREEOAKS_SPEC, "GenericParser");
  const s = p.parseSpinPair!(null, RESP, URL);
  expect(s.balanceBefore).toBeCloseTo(1009056.8, 2); // after + bet − win
});

test("json_array board → 5×4 string reels", () => {
  const p = new SpecDrivenParser(THREEOAKS_SPEC, "GenericParser");
  const s = p.parseResponse(RESP);
  expect(s.reels.length).toBe(5);
  expect(s.reels[0]).toEqual(["10", "3", "3", "3"]);
});

test("verifyLearnedSpec accepts a sound spec", () => {
  const v = verifyLearnedSpec(THREEOAKS_SPEC, [{ url: URL, reqBody: "", respBody: RESP }]);
  expect(v.ok).toBe(true);
  expect(v.spins[0]!.bet).toBeCloseTo(0.5, 5);
});

test("verifyLearnedSpec REJECTS a spec that maps bet onto the balance", () => {
  const bad: ProviderSpec = {
    ...THREEOAKS_SPEC,
    response: { ...THREEOAKS_SPEC.response, fields: { ...THREEOAKS_SPEC.response.fields, betAmount: "user.balance" } },
  };
  const v = verifyLearnedSpec(bad, [{ url: URL, reqBody: "", respBody: RESP }]);
  expect(v.ok).toBe(false);
  expect(v.reasons.join(" ")).toContain("bet equals balance");
});

test("verifyLearnedSpec REJECTS when the spec doesn't accept the response", () => {
  const bad: ProviderSpec = { ...THREEOAKS_SPEC, urlPatterns: ["this-host-never-matches"] };
  const v = verifyLearnedSpec(bad, [{ url: URL, reqBody: "", respBody: RESP }]);
  expect(v.ok).toBe(false);
});

// Backward-compat: a flat PP-style spec (no dots, no scale) is unchanged.
test("flat top-level fields still resolve (no regression)", () => {
  const flat: ProviderSpec = {
    name: "FlatTest", wireFormat: "json", urlPatterns: ["x"],
    response: {
      fields: { balanceAfter: "ba", totalWin: "tw", betAmount: "bet" },
      shapeScore: { requiredFields: ["ba"], bonusFields: [], minScore: 1 },
      winItemization: "none",
    },
    request: { fields: {}, betFormula: "explicit" },
    roundId: { source: "response", fields: [], fallback: "response_hash" },
  };
  const p = new SpecDrivenParser(flat, "GenericParser");
  const s = p.parseResponse(JSON.stringify({ ba: 100, tw: 5, bet: 2 }));
  expect(s.balanceAfter).toBe(100);
  expect(s.win).toBe(5);
  expect(s.bet).toBe(2);
});
