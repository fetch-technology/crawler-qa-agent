// INVARIANT — 3 Oaks (Booongo) spin parser
//
// 3 Oaks games (api.3oaks.sandbox.revenge-games.com) returned a JSON spin shape
// GenericParser rejected → "Không capture được spin". ThreeOaksParser maps the
// nested `context.spins` shape and converts MINOR units (cents) → display units.
// The `?gsc=sync` / command:"sync" echoes must be rejected (not spins).

import { test, expect } from "@playwright/test";
import { ThreeOaksParser } from "../../src/pipeline/step6-build-model/providers/threeoaks-parser.ts";

const PLAY_URL = "https://api.3oaks.sandbox.revenge-games.com/gs/black_wolf_2/desktop/fabb4dbd/3oaksdemo?gsc=play";
const SYNC_URL = "https://api.3oaks.sandbox.revenge-games.com/gs/black_wolf_2/desktop/fabb4dbd/3oaksdemo?gsc=sync";

// The exact response the user captured (bet 0.50, win 0.20, balance 1,009,056.50).
const PLAY_RESPONSE = JSON.stringify({
  command: "play",
  context: {
    round_finished: true,
    last_win: 20,
    current: "spins",
    spins: {
      bet_per_line: 2, lines: 25,
      round_bet: 50, round_win: 20, total_win: 20,
      board: [[10, 3, 3, 3], [3, 7, 5, 5], [9, 9, 9, 2], [2, 2, 11, 11], [8, 8, 8, 3]],
      bs_count: 2, is_boost: false, reelset_number: 4,
      winlines: [{ amount: 10, line: 12, symbol: 3, occurrences: 3 }],
    },
  },
  request_id: "028ef8ef1ade17b35e29fbe4cee3cb57",
  user: { balance: 100905650, currency: "BRL", balance_version: 3 },
  status: { code: "OK" },
});

const SYNC_RESPONSE = JSON.stringify({
  command: "sync",
  modes: ["auto", "play"],
  request_id: "c22364d36aeb43ad8c96e16d927da028",
});

test("accepts a 3 Oaks play response", () => {
  const p = new ThreeOaksParser();
  expect(p.canParseResponse(PLAY_RESPONSE, PLAY_URL)).toBe(true);
});

test("rejects the sync state-echo (command:sync)", () => {
  const p = new ThreeOaksParser();
  expect(p.canParseResponse(SYNC_RESPONSE, SYNC_URL)).toBe(false);
});

test("rejects a non-3Oaks URL", () => {
  const p = new ThreeOaksParser();
  expect(p.canParseResponse(PLAY_RESPONSE, "https://gs2c.pragmatic.com/gameservice")).toBe(false);
});

test("rejects unparseable / non-play JSON", () => {
  const p = new ThreeOaksParser();
  expect(p.canParseResponse("not json", PLAY_URL)).toBe(false);
  expect(p.canParseResponse(JSON.stringify({ command: "init" }), PLAY_URL)).toBe(false);
});

test("parses bet/win/balance in DISPLAY units (minor ÷ 100)", () => {
  const p = new ThreeOaksParser();
  const s = p.parseResponse(PLAY_RESPONSE);
  expect(s.bet).toBeCloseTo(0.5, 5);     // round_bet 50 → 0.50
  expect(s.win).toBeCloseTo(0.2, 5);     // round_win 20 → 0.20
  expect(s.balanceAfter).toBeCloseTo(1009056.5, 2); // balance 100905650 → 1,009,056.50
});

test("derives balanceBefore deterministically (after + bet − win)", () => {
  const p = new ThreeOaksParser();
  const s = p.parseResponse(PLAY_RESPONSE);
  // before = 1009056.50 + 0.50 − 0.20 = 1009056.80
  expect(s.balanceBefore).toBeCloseTo(1009056.8, 2);
  // balance reconciles: after = before − bet + win
  expect(s.balanceAfter).toBeCloseTo(s.balanceBefore! - s.bet + s.win, 2);
});

test("maps the board to a 5×4 string reel grid (column-major)", () => {
  const p = new ThreeOaksParser();
  const s = p.parseResponse(PLAY_RESPONSE);
  expect(s.reels.length).toBe(5);
  expect(s.reels[0]).toEqual(["10", "3", "3", "3"]);
  expect(s.reels[3]).toEqual(["2", "2", "11", "11"]);
});

test("base play is NORMAL, not a free spin, roundId from request_id", () => {
  const p = new ThreeOaksParser();
  const s = p.parseResponse(PLAY_RESPONSE);
  expect(s.state).toBe("NORMAL");
  expect(s.isFreeSpin).toBe(false);
  expect(s.roundId).toBe("028ef8ef1ade17b35e29fbe4cee3cb57");
  expect(s.serverTotalWin).toBeCloseTo(0.2, 5);
});

test("falls back to bet_per_line × lines when round_bet absent", () => {
  const p = new ThreeOaksParser();
  const noBet = JSON.parse(PLAY_RESPONSE);
  delete noBet.context.spins.round_bet;
  const s = p.parseResponse(JSON.stringify(noBet));
  expect(s.bet).toBeCloseTo(0.5, 5); // 2 × 25 = 50 minor → 0.50
});
