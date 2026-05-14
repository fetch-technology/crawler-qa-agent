import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import type { ApiSnapshot } from "./types.js";

/**
 * Đọc paytable text (đã transcribe từ vision in-session capture) và rút ra
 * mechanics rules → ApiSnapshot.features. API thuần không bao giờ expose những
 * thứ này — chúng nằm trong rules/info modal của game.
 */

const SYSTEM_PROMPT = `You are a slot-game rules analyst. Given the transcribed text of a slot machine's RULES / PAYTABLE / INFO screen, you extract the canonical FEATURE MECHANICS and AUTOPLAY OPTIONS as structured JSON. You handle any provider — Pragmatic Play, PG Soft, NetEnt, Revenge Games, etc. Never invent values; only fill what is explicitly stated. Output ONLY a JSON object.`;

const SCHEMA_PROMPT = `Return ONLY a JSON object with this exact shape (TWO top-level blocks):

{
  "features": {
    "free_spins": {
      "available": boolean,
      "trigger": string|null,             // exact rule, e.g. "4 or more SCATTER symbols anywhere"
      "spins_awarded": number|null,       // initial amount granted
      "retrigger": string|null,           // e.g. "3+ scatters during FS award +5 spins"
      "multiplier_during": string|null,   // e.g. "Multiplier symbol values 2x..500x added to total"
      "buy_in_available": boolean|null    // Buy Feature explicitly available?
    } | null,
    "tumble": {                           // also called cascade, avalanche, chain reaction
      "available": boolean,
      "max_multiplier": (number|string)|null,
      "description": string|null
    } | null,
    "wild": {
      "available": boolean,
      "substitutes": string|null,         // "all symbols except scatter"
      "multiplier_values": (number[])|null, // for multiplier-wild: [2,3,4,...,500]
      "sticky": boolean|null,
      "expanding": boolean|null
    } | null,
    "scatter": {
      "available": boolean,
      "min_count_to_pay": number|null,
      "pays": string|null                  // e.g. "x3 to x100 of total bet"
    } | null,
    "bonus_round": {
      "available": boolean,
      "type": string|null,                 // "free_spins" | "pick" | "wheel" | "hold_and_win" | "respin" | …
      "description": string|null
    } | null,
    "multipliers": {
      "base_game": string|null,
      "free_game": string|null,
      "values": (number[])|null
    } | null,
    "other_features": (string[])|null      // free-form: "Megaways", "Cluster pays", "Hold & Spin", "Mystery symbol", …
  },
  "autoplay": {
    "available": boolean,
    "presets": (number[])|null,            // e.g. [10, 25, 50, 100, 1000] — preset round counts
    "max_rounds": number|null,             // upper limit (e.g. "up to 1000 spins")
    "stop_on_any_win": boolean|null,
    "stop_on_feature": boolean|null,       // stop on Free Spins / Bonus trigger
    "stop_on_balance_increase": boolean|null,
    "stop_on_balance_decrease": boolean|null,
    "stop_on_single_win_gt": number|null,  // e.g. 100 (stop if single win > $100)
    "loss_limit": number|null,             // total loss limit if shown
    "notes": string|null
  } | null
}

EXAMPLES of trigger phrasing to look for:
- "4 or more SCATTER symbols pay anywhere on the screen"
- "Free Spins are triggered by 3 or more BONUS symbols"
- "Landing 3 SC anywhere awards 10 free spins"
- "During Free Spins, additional 3+ Scatter symbols award +5 spins"
- "Multiplier symbols (2x to 500x) appear only during Tumble feature"
- "Wilds substitute for all symbols except Scatter"

EXAMPLES of autoplay phrasing to look for:
- "AUTOPLAY plays the game automatically for the chosen number of rounds"
- "Player can choose 10, 25, 50, 100 or 1000 autospins"
- "Autoplay stops if: any single win exceeds X, balance increases by Y, free spins are triggered"
- "STOP ON ANY WIN" / "STOP IF SINGLE WIN EXCEEDS [amount]" / "STOP ON FEATURE TRIGGER"

If a rule isn't stated, set the field null. Output ONLY the JSON object — no prose, no fences.`;

export type PaytableExtractionResult = {
  features: NonNullable<ApiSnapshot["features"]> | null;
  autoplay: NonNullable<NonNullable<ApiSnapshot["ui_options"]>["autoplay"]> | null;
};

export async function extractFeaturesFromPaytable(paytableMarkdown: string): Promise<PaytableExtractionResult | null> {
  if (!paytableMarkdown || paytableMarkdown.trim().length < 50) return null;

  const userText = `PAYTABLE / RULES TEXT:\n\n${paytableMarkdown.slice(0, 18_000)}\n\n${SCHEMA_PROMPT}`;

  let raw: string;
  try {
    raw = await askClaude({
      content: [{ type: "text", text: userText }],
      system: SYSTEM_PROMPT,
    });
  } catch (err) {
    console.warn(`[paytable-features] Claude request failed: ${(err as Error).message}`);
    return null;
  }

  const parsed = extractJsonFromText<{
    features: NonNullable<ApiSnapshot["features"]>;
    autoplay: NonNullable<NonNullable<ApiSnapshot["ui_options"]>["autoplay"]> | null;
  }>(raw);
  if (!parsed) {
    console.warn(`[paytable-features] Could not parse JSON from AI (${raw.length} chars)`);
    return null;
  }

  return {
    features: parsed.features ?? null,
    autoplay: parsed.autoplay ?? null,
  };
}

/**
 * Merge autoplay từ paytable AI vào ui_options.autoplay đã có (vision derive).
 * Field nào đang null → fill, field nào đã set → giữ nguyên.
 */
export function mergeAutoplayIntoUiOptions(
  ui: ApiSnapshot["ui_options"],
  fromPaytable: NonNullable<NonNullable<ApiSnapshot["ui_options"]>["autoplay"]> | null,
): ApiSnapshot["ui_options"] {
  if (!fromPaytable) return ui;
  const base = ui ?? {
    autoplay: null,
    sound: null,
    turbo_spin: null,
    quick_spin: null,
    languages: null,
    fullscreen: null,
    other_controls: null,
  };
  const existing = base.autoplay;
  if (!existing) return { ...base, autoplay: fromPaytable };
  return {
    ...base,
    autoplay: {
      available: existing.available || fromPaytable.available,
      presets: existing.presets ?? fromPaytable.presets,
      max_rounds: existing.max_rounds ?? fromPaytable.max_rounds,
      stop_on_any_win: existing.stop_on_any_win ?? fromPaytable.stop_on_any_win,
      stop_on_feature: existing.stop_on_feature ?? fromPaytable.stop_on_feature,
      stop_on_balance_increase: existing.stop_on_balance_increase ?? fromPaytable.stop_on_balance_increase,
      stop_on_balance_decrease: existing.stop_on_balance_decrease ?? fromPaytable.stop_on_balance_decrease,
      stop_on_single_win_gt: existing.stop_on_single_win_gt ?? fromPaytable.stop_on_single_win_gt,
    },
  };
}

/**
 * Merge features từ paytable AI vào ApiSnapshot. Chiến lược:
 *   - Nếu API parser đã set field (vd buy_in_available=true), giữ.
 *   - Field nào parser để null mà paytable cung cấp → điền.
 *   - Field boolean: OR (true thắng).
 */
export function mergeFeatures(
  fromApi: ApiSnapshot["features"],
  fromPaytable: ApiSnapshot["features"],
): ApiSnapshot["features"] {
  if (!fromPaytable) return fromApi;
  if (!fromApi) return fromPaytable;

  const merged: NonNullable<ApiSnapshot["features"]> = { ...fromApi };

  for (const key of Object.keys(fromPaytable) as Array<keyof NonNullable<ApiSnapshot["features"]>>) {
    const apiVal = fromApi[key];
    const ptVal = fromPaytable[key];
    if (ptVal == null) continue;
    if (apiVal == null) {
      (merged as Record<string, unknown>)[key] = ptVal;
      continue;
    }
    // Both objects — merge field-by-field, prefer non-null from either, OR booleans.
    if (typeof apiVal === "object" && typeof ptVal === "object" && !Array.isArray(apiVal)) {
      const mergedSub: Record<string, unknown> = { ...(apiVal as Record<string, unknown>) };
      for (const [k, v] of Object.entries(ptVal as Record<string, unknown>)) {
        const existing = mergedSub[k];
        if (existing == null) mergedSub[k] = v;
        else if (typeof existing === "boolean" && typeof v === "boolean") mergedSub[k] = existing || v;
      }
      (merged as Record<string, unknown>)[key] = mergedSub;
    }
  }
  return merged;
}
