// Playtech GPAS ("ryota:GameResponse") spin parser.
//
// Playtech games talk over a socket.io WebSocket (api.playtech…/socket.io/…),
// NOT HTTP. The session-level WS capture (manual-session.attachWsCapture) strips
// the socket.io envelope and MERGES the frames that share a `correlationId` into
// one object, so this parser sees a complete merged spin:
//
//   { "correlationId":"b5kml",
//     "data": {
//       "gameData": { "_type":"ryota:GameResponse", "stake":100,
//                     "totalWinAmount":10, "playStack":[{ … board … }] },
//       "stakeAmount":100, "winAmount":10, "gameRoundClosed":true,
//       "balance":[{ "amount":100008860, "_type":"…MonetaryBalance" }] } }
//
// AMOUNTS ARE MINOR UNITS (cents): stakeAmount 100 = 1.00, winAmount 10 = 0.10,
// balance 100008860 = 1,000,088.60 — verified by reconciliation against the
// live balance (before = after + bet − win = 1,000,089.50). The wallet balance
// lives in a SEPARATE frame, so only the MERGED frame (with data.balance) is a
// complete spin; gameData-only frames are rejected (they wait for the merge).

import type { BaseParser, ParserKind } from "../base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../normalized.js";

const MINOR_PER_MAJOR = 100;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Reshape Playtech `symbolUpdates` ({symbol,reelIndex,positionOnReel}) into a
 *  reels[reel][row] string grid. Best-effort — returns [] when the structure
 *  isn't present (board isn't needed for balance-conservation cases). */
function decodeBoard(gameData: Record<string, unknown>): string[][] {
  try {
    const play = (gameData["playStack"] as unknown[])?.[0] as Record<string, unknown> | undefined;
    const slots = asRecord(asRecord(play?.["lastPlayInModeData"])["slotsData"]);
    const actions = slots["actions"] as unknown[] | undefined;
    // Use the FIRST action's first transform's symbolUpdates (the initial drop).
    const updates = (() => {
      for (const a of actions ?? []) {
        const transforms = (a as Record<string, unknown>)["transforms"] as unknown[] | undefined;
        for (const t of transforms ?? []) {
          const su = (t as Record<string, unknown>)["symbolUpdates"] as unknown[] | undefined;
          if (Array.isArray(su) && su.length > 0) return su;
        }
      }
      return undefined;
    })();
    if (!updates) return [];
    const reels: string[][] = [];
    for (const u of updates) {
      const cell = asRecord(u);
      const r = num(cell["reelIndex"]);
      const p = num(cell["positionOnReel"]);
      if (!reels[r]) reels[r] = [];
      reels[r]![p] = String(cell["symbol"] ?? "");
    }
    return reels.map((reel) => Array.from(reel, (s) => s ?? ""));
  } catch {
    return [];
  }
}

export class PlaytechParser implements BaseParser {
  readonly kind: ParserKind = "PlaytechParser";
  readonly providerCode = "PT";

  canParseResponse(raw: string, url?: string): boolean {
    if (url && !/playtech|\/socket\.io\//i.test(url)) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return false;
    }
    const data = asRecord(parsed["data"]);
    const gd = asRecord(data["gameData"]);
    const isGameResponse = String(gd["_type"] ?? "").includes("GameResponse")
      || gd["stake"] !== undefined || data["stakeAmount"] !== undefined;
    // COMPLETE spin = game result + a wallet balance (the merged frame). A
    // gameData-only frame (balance not yet merged) is rejected → it waits.
    const bal = data["balance"];
    const hasBalance = Array.isArray(bal) && bal.length > 0 && asRecord(bal[0])["amount"] !== undefined;
    return isGameResponse && hasBalance;
  }

  parseResponse(raw: string): NormalizedSpinResult {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = asRecord(parsed["data"]);
    const gd = asRecord(data["gameData"]);

    const betMinor = data["stakeAmount"] !== undefined ? num(data["stakeAmount"])
      : gd["stake"] !== undefined ? num(gd["stake"]) : num(data["betCost"]);
    const winMinor = data["winAmount"] !== undefined ? num(data["winAmount"]) : num(gd["totalWinAmount"]);
    const balArr = Array.isArray(data["balance"]) ? (data["balance"] as unknown[]) : [];
    const balMinor = num(asRecord(balArr[0])["amount"]);

    const bet = betMinor / MINOR_PER_MAJOR;
    const win = winMinor / MINOR_PER_MAJOR;
    const balanceAfter = balMinor / MINOR_PER_MAJOR;
    // Playtech reports only the CURRENT (post-spin) balance → derive the pre-bet
    // balance deterministically: after = before − bet + win.
    const balanceBefore = Math.round((balanceAfter + bet - win) * 100) / 100;

    const roundId = String(parsed["correlationId"] ?? gd["stakeCostUuid"] ?? "")
      || `pt-${balMinor}-${betMinor}`;

    // Feature/free-spin signal: a remainingPlayCount on the play stack OR a
    // featureType indicates a bonus round (refined later if needed).
    const play0 = asRecord((gd["playStack"] as unknown[])?.[0]);
    const remaining = num(play0["remainingPlayCount"]);
    const featureActive = data["featureType"] != null && String(data["featureType"]) !== "" && String(data["featureType"]) !== "None";
    const state: SpinState = featureActive ? "BONUS" : "NORMAL";
    const isFreeSpin = state !== "NORMAL" && betMinor === 0;

    return {
      roundId,
      bet: isFreeSpin ? 0 : bet,
      win,
      balanceBefore,
      balanceAfter,
      reels: decodeBoard(gd),
      cascadeFrames: [],
      state,
      freeSpinsRemaining: remaining > 0 ? remaining : null,
      isFreeSpin,
      hasBonus: state !== "NORMAL",
      raw: parsed,
      serverTotalWin: win,
    };
  }

  parseSpinPair(_request: string | null, response: string): NormalizedSpinResult {
    return this.parseResponse(response);
  }
}
