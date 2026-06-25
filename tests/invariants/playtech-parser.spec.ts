// INVARIANT — Playtech GPAS ("ryota:GameResponse") spin parser
//
// Playtech talks over a socket.io WebSocket and splits a spin across frames
// sharing a correlationId; the session WS capture strips the envelope + merges
// them. This parser reads the MERGED frame: bet=data.stakeAmount/100,
// win=data.winAmount/100, balance=data.balance[0].amount/100 — verified against
// the real captured sample (before = after + bet − win reconciles to the live
// balance R$1,000,089.50). gameData-only frames (no balance) are rejected so
// they wait for the merge.

import { test, expect } from "@playwright/test";
import { PlaytechParser } from "../../src/pipeline/step6-build-model/providers/playtech-parser.ts";

const URL = "wss://api.playtech.sandbox.revenge-games.com/socket.io/1/websocket/abc?client=x";

// A merged frame (gameData + balance), shaped like the real capture.
const MERGED = JSON.stringify({
  correlationId: "b5kml",
  data: {
    gameData: {
      _type: "ryota:GameResponse",
      stake: 100,
      totalWinAmount: 10,
      personalBalance: 0,
      playStack: [{
        round: "BaseGame", remainingPlayCount: 0,
        lastPlayInModeData: {
          playWinAmount: 10,
          slotsData: { actions: [{ ref: "spin", transforms: [{ ref: "spin", symbolUpdates: [
            { symbol: 4, reelIndex: 0, positionOnReel: 0 },
            { symbol: 6, reelIndex: 0, positionOnReel: 1 },
            { symbol: 9, reelIndex: 1, positionOnReel: 0 },
            { symbol: 2, reelIndex: 4, positionOnReel: 2 },
          ] }] }] },
        },
      }],
    },
    stakeAmount: 100,
    winAmount: 10,
    gameRoundClosed: true,
    balance: [{ amount: 100008860, _type: "com.pt.casino.platform.balance.MonetaryBalance" }],
  },
});

// A gameData-only frame (balance not yet merged) — must be rejected.
const GAMEDATA_ONLY = JSON.stringify({
  correlationId: "b5kml",
  data: { gameData: { _type: "ryota:GameResponse", stake: 100, totalWinAmount: 10 }, stakeAmount: 100 },
});

test("accepts a merged Playtech frame (game result + balance)", () => {
  expect(new PlaytechParser().canParseResponse(MERGED, URL)).toBe(true);
});

test("rejects a gameData-only frame (waits for the balance merge)", () => {
  expect(new PlaytechParser().canParseResponse(GAMEDATA_ONLY, URL)).toBe(false);
});

test("rejects a socket.io heartbeat / non-Playtech url", () => {
  const p = new PlaytechParser();
  expect(p.canParseResponse("2::", URL)).toBe(false);
  expect(p.canParseResponse(MERGED, "wss://gs2c.pragmatic.com/x")).toBe(false);
});

test("parses bet/win/balance in DISPLAY units (minor ÷ 100) and reconciles", () => {
  const s = new PlaytechParser().parseResponse(MERGED);
  expect(s.bet).toBeCloseTo(1.0, 5);          // stakeAmount 100
  expect(s.win).toBeCloseTo(0.1, 5);          // winAmount 10
  expect(s.balanceAfter).toBeCloseTo(1000088.6, 2);
  // before = after + bet − win = 1,000,089.50 (matches the live balance)
  expect(s.balanceBefore).toBeCloseTo(1000089.5, 2);
  expect(s.balanceAfter).toBeCloseTo(s.balanceBefore! - s.bet + s.win, 2);
  expect(s.roundId).toBe("b5kml");
});

test("decodes the symbolUpdates board into a reel grid", () => {
  const s = new PlaytechParser().parseResponse(MERGED);
  expect(s.reels.length).toBe(5);            // reelIndex 0..4
  expect(s.reels[0]![0]).toBe("4");
  expect(s.reels[0]![1]).toBe("6");
  expect(s.reels[1]![0]).toBe("9");
});

test("base spin is NORMAL, not a free spin", () => {
  const s = new PlaytechParser().parseResponse(MERGED);
  expect(s.state).toBe("NORMAL");
  expect(s.isFreeSpin).toBe(false);
});
