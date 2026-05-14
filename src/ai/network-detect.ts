import { askClaude, extractJsonFromText } from "./claude.js";

export type FieldMapping = {
  bet: string | null;
  win: string | null;
  balance: string | null;
  starting_balance: string | null;
  ending_balance: string | null;
  matrix: string | null;
  round_id: string | null;
  status: string | null;
  currency: string | null;
  extras: Record<string, string>;
};

export type NetworkHints = {
  game_slug: string;
  provider: string;
  detected_at: string;
  detection_method: "heuristic" | "ai" | "cache";
  spin_endpoint: {
    url_pattern: string;
    method: string;
    body_format: "json" | "urlencoded" | "unknown";
  };
  field_mapping: FieldMapping;
  reasoning: string;
  confidence: number;
};

export type ResponseSummary = {
  url: string;
  method: string;
  status: number;
  body_length: number;
  body_preview: string;
  parsed_keys: string[];
};

const SYSTEM_PROMPT =
  "You are a reverse-engineering expert analyzing HTTP traffic from online casino slot games. You identify which endpoint represents a 'spin round' and map its response fields to standardized names. You output ONLY valid JSON.";

/**
 * Cho AI xem traffic summary → identify spin endpoint + field mapping.
 * Dùng làm fallback khi heuristic không tự tin.
 */
export async function detectSpinEndpointWithAI(args: {
  gameSlug: string;
  provider: string;
  responses: ResponseSummary[];
}): Promise<NetworkHints> {
  const { gameSlug, provider, responses } = args;

  const responseList = responses
    .map(
      (r, i) =>
        `[${i + 1}] ${r.method} ${r.status} ${r.url}
    body[${r.body_length} chars]: ${r.body_preview.slice(0, 300).replace(/\n/g, "\\n")}
    parsed_keys: ${r.parsed_keys.slice(0, 30).join(", ")}`,
    )
    .join("\n\n");

  const prompt = `Game: ${gameSlug} (provider: ${provider})

Below are HTTP responses captured during a spin session. Identify the ONE endpoint that represents a "spin round" (where: player wagers a bet, reels spin, win is determined, balance updates).

Map the spin response field names to standardized names. Field names can be abbreviated or provider-specific (e.g. Pragmatic Play uses "tw" for total win, "balance_cash" for balance).

=== RESPONSES ===
${responseList}

=== OUTPUT — JSON ONLY ===

{
  "game_slug": "${gameSlug}",
  "provider": "${provider}",
  "detected_at": "${new Date().toISOString()}",
  "detection_method": "ai",
  "spin_endpoint": {
    "url_pattern": string,          // URL substring or regex that identifies spin (e.g. "/gs2c/ge/" or "/spin" or "/fortune-pig/spin")
    "method": "POST" | "GET",
    "body_format": "json" | "urlencoded" | "unknown"
  },
  "field_mapping": {
    "bet":              string | null,   // field name for bet amount. Could be: betAmount, bet, stake, c (coin × bl)
    "win":              string | null,   // field name for win amount. Could be: winAmount, win, tw (total win), earn
    "balance":          string | null,   // balance (generic). Could be: balance, balance_cash
    "starting_balance": string | null,   // balance BEFORE spin, if distinguishable
    "ending_balance":   string | null,   // balance AFTER spin, if distinguishable (same as balance for some providers)
    "matrix":           string | null,   // reels/symbols. Could be: matrix, reels, s, sa, sb
    "round_id":         string | null,   // round/spin ID. Could be: id, round, index, counter
    "status":           string | null,   // finalized state. Could be: status, state
    "currency":         string | null,   // currency code field if present
    "extras": {                          // any OTHER useful mappings you notice, e.g. { "totalBet": "totalBet", "multiplier": "rs_m" }
      ...
    }
  },
  "reasoning": string,   // 1-2 sentences explaining which response # is the spin endpoint and why
  "confidence": number   // 0..1 — how confident you are in the mapping
}

Rules:
- If a standard field is NOT present in the response, set to null (don't force a match).
- For PP-style: "tw" is total win, "balance"/"balance_cash" is post-spin balance. No separate starting_balance — derive from balance - tw + bet if needed.
- For matrix: if response has multiple arrays like "sa"/"sb" (PP stops before/after), pick the one that represents FINAL visible symbols.
- If NO spin endpoint identifiable, return null for url_pattern and confidence < 0.3.
- Output ONLY the JSON object.`;

  const raw = await askClaude({
    content: [{ type: "text", text: prompt }],
    system: SYSTEM_PROMPT,
    maxTurns: 1,
  });
  const parsed = extractJsonFromText<NetworkHints>(raw);
  if (!parsed) {
    throw new Error(`detectSpinEndpointWithAI: không parse được JSON. Raw: ${raw.slice(0, 300)}`);
  }
  parsed.detection_method = "ai";
  parsed.detected_at = new Date().toISOString();
  return parsed;
}

/**
 * Dùng mapping để normalize raw response → standard shape.
 * Output luôn có các key chuẩn: betAmount, winAmount, startingBalance,
 * endingBalance, updatedBalance, matrix, id, status, currency, _raw.
 */
export function applyFieldMapping(
  raw: Record<string, unknown>,
  mapping: FieldMapping,
): Record<string, unknown> {
  const out: Record<string, unknown> = { _raw: raw };

  const take = (name: string | null) => {
    if (!name) return null;
    const v = raw[name];
    if (v == null) return null;
    return v;
  };

  const betV = take(mapping.bet);
  const winV = take(mapping.win);
  const balV = take(mapping.balance);
  const sbV = take(mapping.starting_balance);
  const ebV = take(mapping.ending_balance);
  const matrixV = take(mapping.matrix);
  const idV = take(mapping.round_id);
  const statusV = take(mapping.status);
  const currV = take(mapping.currency);

  if (betV != null) out.betAmount = parseMoneyValue(betV);
  if (winV != null) out.winAmount = parseMoneyValue(winV);
  if (ebV != null) {
    out.endingBalance = parseMoneyValue(ebV);
  } else if (balV != null) {
    out.endingBalance = parseMoneyValue(balV);
    out.updatedBalance = out.endingBalance;
  }
  if (sbV != null) {
    out.startingBalance = parseMoneyValue(sbV);
  } else if (out.endingBalance != null && out.winAmount != null && out.betAmount != null) {
    // Derive: startingBalance = endingBalance - winAmount + betAmount
    const eb = out.endingBalance as number;
    const w = out.winAmount as number;
    const b = out.betAmount as number;
    if (Number.isFinite(eb) && Number.isFinite(w) && Number.isFinite(b)) {
      out.startingBalance = Number((eb - w + b).toFixed(4));
    }
  }
  if (matrixV != null) out.matrix = matrixV;
  if (idV != null) out.id = String(idV);
  if (statusV != null) out.status = String(statusV);
  if (currV != null) out.currency = String(currV);

  // Apply extras too
  for (const [stdName, rawName] of Object.entries(mapping.extras || {})) {
    const v = raw[rawName];
    if (v != null) out[stdName] = v;
  }

  return out;
}

export function parseMoneyValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Strip currency symbols, commas as thousands separator (e.g. "99,998.00" or "$1,234.56")
    const cleaned = v.replace(/[^\d.-]/g, "").replace(/(?<=\d),(?=\d{3})/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
