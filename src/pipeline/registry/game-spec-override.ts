// QA-editable overrides for the auto-captured GameSpec. The base spec
// comes from `do_init` API capture (in-memory `this.gameSpec`); this
// store layers manual edits on top so values survive session restart
// + flow into AI catalog generation.
//
// Why a separate file (not editing _meta.json or game-mechanics.json
// directly): the captured spec changes whenever the game reloads
// do_init — if we wrote QA edits back into the same file the next
// re-capture would clobber them. Keeping overrides separate lets the
// captured base refresh while preserving QA's intent.

import { loadJson, saveJson, fileExists } from "./io.js";
import type { RegistryStore } from "./types.js";

/** All fields optional. QA only fills in what they want to override;
 *  unset fields fall through to the captured base. */
export type GameSpecOverride = {
  /** Lowest total bet (e.g. 0.20). Override if the auto-captured value
   *  is wrong (e.g. game-mechanics evidence captured under ante mode). */
  betMin?: number;
  /** Highest total bet (e.g. 200). */
  betMax?: number;
  /** Game's default-at-load total bet (coin × lines × betLevel). Drives
   *  "default-bet-equals-X" assertions in catalog. */
  defaultBet?: number;
  /** Full ladder of achievable bet values (sorted, deduped). Catalog AI
   *  uses this so generated test cases pick legal bet targets. */
  betLadder?: number[];
  /** Coin values list. Rarely overridden — usually the captured value
   *  is correct. */
  coinValues?: number[];
  /** Lines / ways count. */
  lines?: number;
  /** Default coin per spin (before lines + betLevel). */
  defaultCoin?: number;
  /** Bet levels (multipliers, e.g. [1, 1.5, 1.9]). */
  betLevels?: number[];
  /** Free-form note from QA explaining why the override was made. Shown
   *  on dashboard for context. */
  note?: string;
  /** ISO timestamp when last edited. */
  updatedAt?: string;
};

export const gameSpecOverride: RegistryStore<GameSpecOverride> = {
  load: (slug) => loadJson<GameSpecOverride>(slug, "gameSpecOverride"),
  save: (slug, data) => saveJson(slug, "gameSpecOverride", data),
  exists: (slug) => fileExists(slug, "gameSpecOverride"),
};

/** Apply override on top of captured base. Returns a NEW object — no
 *  mutation. Both inputs may be null/undefined. Unset override fields
 *  fall through to base; set fields win. */
export function applyOverride<T extends Partial<GameSpecOverride>>(
  base: T,
  override: GameSpecOverride | null | undefined,
): T {
  if (!override) return { ...base };
  const merged = { ...base } as T;
  for (const k of Object.keys(override) as Array<keyof GameSpecOverride>) {
    if (k === "note" || k === "updatedAt") continue;
    const v = override[k];
    if (v != null) (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}
