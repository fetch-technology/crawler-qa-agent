// 3 Oaks (Booongo / 3oaks.sandbox.revenge-games.com) spin parser.
//
// Wire format: JSON. The spin endpoint is `…/gs/<game>/desktop/<id>/<brand>?gsc=play`
// with request body `{"command":"play", action:{name:"spin", params:{bet_per_line,lines}}}`.
// The RESPONSE (the authoritative source) nests everything under `context.spins`:
//
//   { "command":"play",
//     "context": { "round_finished":true, "last_win":20,
//       "spins": { "bet_per_line":2, "lines":25, "round_bet":50, "round_win":20,
//                  "total_win":20, "board":[[10,3,3,3],…], "winlines":[…] },
//       "current":"spins" },
//     "user": { "balance":100905650, "currency":"BRL" },
//     "request_id":"…", "status":{"code":"OK"} }
//
// AMOUNTS ARE IN MINOR UNITS (cents): round_bet 50 = 0.50, balance 100905650 =
// 1,009,056.50. The bet chip we clicked ("betButton__bet-0.50") confirms the
// ×100 factor. We divide by MINOR_PER_MAJOR so bet/win/balance come out in the
// same display units the assertions + bet ladder use.
//
// `gsc=sync` / `command:"sync"` responses (state echoes) are NOT spins → rejected.

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

/** Map 3 Oaks `context.current` to our SpinState. Base play = "spins"; the
 *  Hold-and-Win respin feature reports a bonus/respin/hold state. */
function deriveState(current: string, betMinor: number): SpinState {
  const c = current.toLowerCase();
  if (/free.?spin/.test(c)) return "FREE_SPIN";
  if (/bonus|respin|hold/.test(c)) return "BONUS";
  // A zero-bet step that isn't plain "spins" is a feature continuation.
  if (betMinor === 0 && c && c !== "spins") return "BONUS";
  return "NORMAL";
}

export class ThreeOaksParser implements BaseParser {
  readonly kind: ParserKind = "ThreeOaksParser";
  readonly providerCode = "3OAKS";

  canParseResponse(raw: string, url?: string): boolean {
    // URL gate: 3 Oaks game-service host/path. Tolerant — only rejects when a
    // URL is given AND clearly isn't 3 Oaks. Auth/lobby endpoints lack the
    // `command:"play"` body so the shape check below also filters them.
    if (url && !/3oaks|\/gs\/.*\/desktop\//i.test(url)) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return false;
    }
    // Only "play" carries a spin result. "sync"/"init"/etc. are state echoes.
    if (String(parsed["command"] ?? "") !== "play") return false;
    const spins = asRecord(asRecord(parsed["context"])["spins"]);
    // A real spin response has a board + a round bet/win under context.spins.
    return Array.isArray(spins["board"]) || "round_bet" in spins || "round_win" in spins;
  }

  parseResponse(raw: string): NormalizedSpinResult {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const context = asRecord(parsed["context"]);
    const spins = asRecord(context["spins"]);
    const user = asRecord(parsed["user"]);

    const betMinor = "round_bet" in spins
      ? num(spins["round_bet"])
      : num(spins["bet_per_line"]) * num(spins["lines"]);
    const winMinor = "round_win" in spins
      ? num(spins["round_win"])
      : "total_win" in spins
      ? num(spins["total_win"])
      : num(context["last_win"]);
    const balMinor = num(user["balance"]);

    const bet = betMinor / MINOR_PER_MAJOR;
    const win = winMinor / MINOR_PER_MAJOR;
    const balanceAfter = balMinor / MINOR_PER_MAJOR;
    // 3 Oaks reports only the CURRENT (post-bet, post-win) balance. Derive the
    // pre-bet balance deterministically: after = before − bet + win.
    const balanceBefore = Math.round((balanceAfter + bet - win) * 100) / 100;

    const state = deriveState(String(context["current"] ?? ""), betMinor);
    const isFreeSpin = state !== "NORMAL" && betMinor === 0;

    // board is column-major already: board[reel][row] of symbol ids. Stringify.
    const board = Array.isArray(spins["board"]) ? (spins["board"] as unknown[]) : [];
    const reels: string[][] = board.map((col) =>
      Array.isArray(col) ? (col as unknown[]).map((s) => String(s)) : [],
    );

    const roundId = String(parsed["request_id"] ?? "")
      || `3oaks-${num(spins["reelset_number"])}-${balMinor}`;

    return {
      roundId,
      bet,
      win,
      balanceBefore,
      balanceAfter,
      reels,
      cascadeFrames: [],
      state,
      freeSpinsRemaining: null,
      isFreeSpin,
      hasBonus: state !== "NORMAL",
      raw: parsed,
      serverTotalWin: win,
    };
  }

  parseSpinPair(_request: string | null, response: string): NormalizedSpinResult {
    // The response carries the authoritative bet (context.spins.round_bet), so
    // we don't need the request body to compute it.
    return this.parseResponse(response);
  }
}
