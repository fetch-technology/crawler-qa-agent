import { loadJson, saveJson, fileExists } from "./io.js";
import type { GameMechanics, RegistryStore } from "./types.js";

export const gameMechanics: RegistryStore<GameMechanics> = {
  load: (slug) => loadJson<GameMechanics>(slug, "gameMechanics"),
  save: (slug, data) => saveJson(slug, "gameMechanics", data),
  exists: (slug) => fileExists(slug, "gameMechanics"),
};

/**
 * Derive game mechanic + bet multiplier from one observed spin pair.
 *
 * The bet ACTUALLY deducted = balanceBefore - balanceAfter + win. With c
 * (coin) from the request, multiplier M = deducted / c. Then we classify:
 *   - M ≈ l   → "lines" game (paylines match multiplier)
 *   - M ≪ l   → "ways" game (l is ways count, M is the fixed mul like 20)
 *   - bl > 0 + M == bl → "lines" with bet-level mode (uncommon)
 *
 * Returns null if inputs invalid (zero coin, zero deduction, etc.).
 */
export function deriveGameMechanics(args: {
  parsedRequest: Record<string, unknown> | null;
  balanceBefore: number;
  balanceAfter: number;
  win: number;
  rawRequest?: string;
}): GameMechanics | null {
  if (!args.parsedRequest) return null;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const c = num(args.parsedRequest["c"]);
  const bl = num(args.parsedRequest["bl"]);
  const l = num(args.parsedRequest["l"]);
  if (c <= 0) return null;

  const deducted = args.balanceBefore - args.balanceAfter + args.win;
  if (!Number.isFinite(deducted) || deducted <= 0) return null;
  const multiplier = Math.round((deducted / c) * 1000) / 1000;
  if (multiplier <= 0) return null;

  let mechanic: GameMechanics["mechanic"] = "unknown";
  // Tolerance: round multiplier should be close to an integer in real games.
  const closeTo = (n: number, target: number): boolean => Math.abs(n - target) / Math.max(1, target) < 0.02;

  // Ante-during-calibration detection. PP slots commonly support an "Ante Bet"
  // / "Bonus Bet" toggle that scales total bet by a fixed factor (1.25, 1.5,
  // 1.9, 2.0, 2.5×) to boost free-spin frequency. If the calibration sample
  // happened to run with ante ON, `multiplier` captures the inflated cost
  // (e.g. coin × lines × 1.9). Storing that breaks parser for every normal
  // (no-ante) spin later. Detect the common ratios and store BASE multiplier
  // = l instead, noting the ante factor in evidence.
  const COMMON_ANTE_FACTORS = [1.25, 1.5, 1.75, 1.9, 2.0, 2.5, 3.0];
  if (l > 0 && !closeTo(multiplier, l) && !closeTo(multiplier, bl)) {
    const ratio = multiplier / l;
    for (const ante of COMMON_ANTE_FACTORS) {
      if (Math.abs(ratio - ante) / ante < 0.02) {
        console.warn(
          `[game-mechanics] ante x${ante} detected during calibration `
          + `(multiplier=${multiplier}, l=${l}, ratio=${ratio.toFixed(3)}). `
          + `Storing BASE multiplier=${l} so parser handles no-ante spins correctly.`,
        );
        return {
          mechanic: "lines",
          betMultiplier: l,
          waysOrLines: l,
          detectedAt: new Date().toISOString(),
          detectionMethod: "balance_derived",
          evidence: {
            coin: c,
            deductedFromBalance: deducted,
            requestSample: args.rawRequest?.slice(0, 200),
          },
        };
      }
    }
  }

  // Classify against the request's STRUCTURAL fields and snap betMultiplier to
  // the exact structural value. A multiplier that matches NONE of them is
  // almost certainly a polluted sample (e.g. a mid-tumble frame where `tw` is
  // counted before being credited → deducted = stake + uncredited-win →
  // multiplier 41 when l=20 / 47 when l=20). Persisting that mis-stamps bet on
  // EVERY future spin, so we REJECT (return null) and let the caller retry on a
  // cleaner spin instead of trusting garbage.
  let betMultiplier: number;
  // Clean ways multiplier: an integer-ish fixed stake (e.g. 20, 25) while `l`
  // is the large ways-count (1024, 32768, …). Require l >> M AND M near-integer
  // so a desynced non-integer (or M comparable to l) can't sneak in as "ways".
  const isCleanWaysMult = l > 0 && multiplier < l / 3 && Math.abs(multiplier - Math.round(multiplier)) < 0.05;
  if (bl > 0 && closeTo(multiplier, bl)) {
    mechanic = "lines"; // bet-level mode
    betMultiplier = bl;
  } else if (closeTo(multiplier, l)) {
    mechanic = "lines"; // c × paylines
    betMultiplier = l;
  } else if (isCleanWaysMult) {
    mechanic = "ways"; // l is ways count, M is the fixed stake mult
    betMultiplier = Math.round(multiplier);
  } else {
    console.warn(
      `[game-mechanics] REJECT sample: multiplier=${multiplier} fits neither lines `
      + `(l=${l}), bet-level (bl=${bl}), nor a clean ways multiplier — almost certainly a `
      + `mid-tumble win desync. Not persisting; will retry on the next clean (losing) spin.`,
    );
    return null;
  }

  return {
    mechanic,
    betMultiplier,
    waysOrLines: l,
    detectedAt: new Date().toISOString(),
    detectionMethod: "balance_derived",
    evidence: {
      coin: c,
      deductedFromBalance: deducted,
      requestSample: args.rawRequest?.slice(0, 200),
    },
  };
}
