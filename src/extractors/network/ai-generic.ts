import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import type { HttpEntry } from "./http-jsonl.js";
import { pickConfigCandidates } from "./http-jsonl.js";
import { type ApiSnapshot, emptyApiSnapshot } from "./types.js";

/**
 * Generic AI extractor — dùng khi provider không có deterministic parser.
 *
 * Pipeline:
 *  1. Filter http.jsonl → các response 200 trông giống "game config" (looksLikeGameConfig).
 *  2. Truncate body mỗi candidate xuống ~6KB để tránh blow context.
 *  3. Gửi Claude full digest + ApiSnapshot schema, yêu cầu trả JSON đầy đủ.
 *  4. Parse + return.
 *
 * Không dependency cứng vào provider — Claude tự đọc URL + body để suy ra
 * canonical config endpoint, decode form-encoded / JSON / JS-object literal,
 * và map sang shape ApiSnapshot.
 */

const MAX_BODY_PER_CANDIDATE = 6000;
const MAX_CANDIDATES = 10;

const SYSTEM_PROMPT = `You are a reverse-engineering assistant for slot-game QA. You analyze captured HTTP responses (from a Playwright network log) and produce a single JSON snapshot describing every testable game parameter (bets, RTP, max win, buy feature, special bets / ante, paylines, symbols, paytable). You handle ANY iGaming provider — Pragmatic Play, Revenge Games, PG Soft, NetEnt, Play'n GO, Evoplay, Spribe, etc. Bodies may be JSON, form-encoded (key=value&key2=value2), JS-object literals (unquoted keys), XML, or proprietary text — decode whatever shape is present. Never invent values; only extract what is actually present in the bodies. Output ONLY valid JSON conforming to the schema.`;

function digestEntries(entries: HttpEntry[]): string {
  const candidates = pickConfigCandidates(entries).slice(0, MAX_CANDIDATES);
  const parts: string[] = [];
  parts.push(`Captured ${entries.length} HTTP entries total. Filtered to ${candidates.length} likely-config responses below.`);
  parts.push(``);
  candidates.forEach((c, i) => {
    const body = c.body.length > MAX_BODY_PER_CANDIDATE
      ? c.body.slice(0, MAX_BODY_PER_CANDIDATE) + `\n…[truncated ${c.body.length - MAX_BODY_PER_CANDIDATE} more bytes]`
      : c.body;
    parts.push(`=== CANDIDATE ${i + 1} ===`);
    parts.push(`URL: ${c.url}`);
    parts.push(`METHOD: ${c.method}    STATUS: ${c.status}`);
    parts.push(`BODY:`);
    parts.push(body);
    parts.push(``);
  });
  return parts.join("\n");
}

const SCHEMA_PROMPT = `Return ONLY a single JSON object with EXACTLY this shape — fill from the candidate bodies above. Use null for any field truly absent from the data. Never hallucinate values.

{
  "provider_guess": string,            // your best guess based on hosts/paths: "PP","RG","PG","NE","PNG","EVO","SPR","other"
  "source_endpoints": string[],        // EXACT URLs (from candidates) that contributed to this snapshot

  "game": { "code": string|null, "name": string|null },

  "balance": {
    "cash": number|null, "bonus": number|null, "currency": string|null
  } | null,

  "bet": {
    "current": number|null,            // current TOTAL bet (coin × level × lines if applicable)
    "default": number|null,
    "coin_values": number[]|null,      // chip ladder
    "bet_levels": number[]|null,       // multiplier levels (if separate from coins)
    "total_min": number|null,
    "total_max": number|null,
    "step_kind": "discrete_chips"|"level_x_coin"|"plus_minus"|"unknown"
  } | null,

  "rtp": {
    "regular": number|null,
    "ante": [{ "id": string, "rtp": number, "max_win_x": number|null }]|null,
    "purchase": [{ "id": string, "rtp": number, "max_win_x": number|null }]|null
  } | null,

  "max_win_x": number|null,            // overall max win multiplier (e.g. 25000)

  "buy_feature": {
    "available": boolean,
    "tiers": [{
      "id": string, "label": string|null, "rtp": number|null,
      "max_win_x": number|null, "price_multiplier": number|null, "price_absolute": number|null
    }]|null
  } | null,

  "special_bets": {
    "available": boolean,
    "variants": [{
      "id": string, "label": string|null, "rtp": number|null,
      "max_win_x": number|null, "cost_multiplier": number|null
    }]|null
  } | null,

  "reels": {
    "width": number|null, "height": number|null,
    "paylines_or_ways": (number|string)|null
  } | null,

  "symbols": [{
    "id": (number|string), "code": string|null, "name": string|null,
    "type": string|null                  // "WILD"|"SCATTER"|"PICTURE_SYMBOL"|"BONUS"|null
  }]|null,

  "paytable": { "<symbol_id>": [number, ...] }|null,    // multipliers per match-count

  "reel_sets_count": number|null,

  "features": {
    "free_spins": {
      "available": boolean,
      "trigger": string|null,
      "spins_awarded": number|null,
      "retrigger": string|null,
      "multiplier_during": string|null,
      "buy_in_available": boolean|null
    } | null,
    "tumble": { "available": boolean, "max_multiplier": (number|string)|null, "description": string|null } | null,
    "wild": { "available": boolean, "substitutes": string|null, "multiplier_values": (number[])|null, "sticky": boolean|null, "expanding": boolean|null } | null,
    "scatter": { "available": boolean, "min_count_to_pay": number|null, "pays": string|null } | null,
    "bonus_round": { "available": boolean, "type": string|null, "description": string|null } | null,
    "multipliers": { "base_game": string|null, "free_game": string|null, "values": (number[])|null } | null,
    "other_features": (string[])|null
  } | null,

  "session_state": {
    "free_spins_remaining": number|null,
    "free_spins_total": number|null,
    "free_spins_win_amount": number|null,
    "current_multiplier": (number|string)|null,
    "in_feature": boolean|null,
    "last_bet": {
      "amount": number|null, "coin_size": number|null, "level": number|null,
      "bet_type": string|null, "result_id": string|null, "win_amount": number|null,
      "ending_balance": number|null
    } | null,
    "engine": string|null
  } | null,

  "ui_options": {
    "autoplay": {
      "available": boolean, "presets": (number[])|null, "max_rounds": number|null,
      "stop_on_any_win": boolean|null, "stop_on_feature": boolean|null,
      "stop_on_balance_increase": boolean|null, "stop_on_balance_decrease": boolean|null,
      "stop_on_single_win_gt": number|null
    } | null,
    "sound": { "available": boolean, "default_state": "on"|"off"|null, "separate_music_fx": boolean|null } | null,
    "turbo_spin": { "available": boolean, "default_state": "on"|"off"|null } | null,
    "quick_spin": { "available": boolean, "default_state": "on"|"off"|null } | null,
    "languages": (string[])|null,
    "fullscreen": { "available": boolean } | null,
    "other_controls": (string[])|null
  } | null,

  "raw": {                              // debug aid: keep raw fragments you found relevant
    "<endpoint_url>": <object_or_string>
  }
}

EXTRACTING THE 3 NEW BLOCKS:
- features (RULE mechanics): rarely in API responses; usually only in HTML help/paytable. If candidates contain rules text → extract trigger phrasing, spins awarded, multiplier behavior. If candidates only have config (bet/RTP), set features=null and let the paytable enricher handle it later.
- session_state (RUNTIME): from PP \`bonuses\`/\`ntp\`/\`fs\` form-encoded fields, or RG \`playerState.{freeSpins, freeSpinsWinAmount, lastBet}\`, or any "balance/last spin" endpoint.
- ui_options (CLIENT): often in HTML embed (PP html5Game.do response body), bootstrap JSON (RG /{game}/config from rc host), or game asset config (game.json). Look for keys like \`autoplay\`, \`autoSpin\`, \`stopOnWin\`, \`maxAutoSpins\`, \`soundEnabled\`, \`SHOW_GAME_RULE\`, \`languages\`. If absent → null (vision will fill from controls).

DECODING HINTS:
- Pragmatic Play: \`/gs2c/ge/v4/gameService\` doInit response is form-encoded. Field \`gameInfo={rtps:{...},props:{...}}\` is a JS-object literal with UNQUOTED keys — quote them before JSON.parse. Fields: \`sc\` (coin chips CSV), \`bls\` (bet level multipliers CSV), \`c\` (current coin), \`l\` (lines), \`sw\`/\`sh\` (reel width/height), \`total_bet_max\`, \`balance_cash\`, \`paytable\` (rows ; separated, cells , separated), \`wl_i\` (win limits like \`tbm~25000;tbm_a1~10000\` — semicolon-separated, ~-separated), \`purInit_e\` (purchase variants enabled bitmap).
- Revenge Games: JSON \`/{game}/config\` has \`betSizes\`, \`betLevels\`, \`config.symbols\`, \`config.matrixDefault\`. \`/client/player/authorize-game\` has \`balance\`, \`currency\`, \`playerState.lastBet.betAmount/betSize/betLevel\`.
- PG Soft: usually JSON with \`payRate\`, \`betDetailList\`, \`baseBet\`, \`featureList\`.
- Numbers like "100,000.00" → strip commas → 100000. Decimal "0.20" → 0.2.
- If 2 sources disagree, prefer the more authoritative (config endpoint > balance refresh).
- "ante_a1", "ante_a2", … = special bet variants. "purchase_0", "purchase_1", … = buy feature tiers.

Output ONLY the JSON object, no prose, no fences.`;

export async function extractWithAI(entries: HttpEntry[]): Promise<ApiSnapshot | null> {
  const candidates = pickConfigCandidates(entries);
  if (candidates.length === 0) return null;

  const userText = `${digestEntries(entries)}\n\n${SCHEMA_PROMPT}`;

  let raw: string;
  try {
    raw = await askClaude({
      content: [{ type: "text", text: userText }],
      system: SYSTEM_PROMPT,
    });
  } catch (err) {
    console.warn(`[network/ai-generic] Claude request failed: ${(err as Error).message}`);
    return null;
  }

  const parsed = extractJsonFromText<Partial<ApiSnapshot> & { provider_guess?: string }>(raw);
  if (!parsed) {
    console.warn(`[network/ai-generic] Could not parse JSON from AI response (${raw.length} chars)`);
    return null;
  }

  const providerLabel = `AI:${parsed.provider_guess ?? "unknown"}`;
  const out = emptyApiSnapshot(providerLabel, "ai_generic");
  // Merge parsed values, defending against missing fields
  Object.assign(out, parsed, {
    capturedAt: new Date().toISOString(),
    provider: providerLabel,
    extractor_kind: "ai_generic" as const,
    source_endpoints: parsed.source_endpoints ?? candidates.map((c) => c.url),
  });
  if (!out.game) out.game = { code: null, name: null };
  if (!out.raw) out.raw = {};
  return out;
}
