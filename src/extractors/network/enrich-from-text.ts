import type { ApiSnapshot } from "./types.js";

/**
 * Enrich các tier/variant null fields trong ApiSnapshot bằng cách parse
 * `features.other_features` (text human-readable đã extract từ paytable AI)
 * và `vision.rules_summary.feature_mentions`.
 *
 * Không gọi AI thêm — pure regex/string matching → deterministic + free.
 */

export type ParsedTierText = {
  raw: string;
  label: string;
  cost_multiplier: number | null;
  cost_label: string;          // "100x bet" / "240x total bet"
  notes: string | null;        // phần mô tả sau "—"
  category: "buy_feature" | "ante" | "super_spin" | "other";
};

// Label = bắt đầu bằng chữ (any case), kết thúc bằng chữ/số. Cho phép space, _, -.
// Cost: ngay sau "(" có "Nx bet" hoặc "Nx total bet"; PHẢI cho phép content tiếp theo
// trong cùng ngoặc (vd "(50x bet, ~8x higher free spins chance)").
const TIER_PATTERN =
  /^([A-Za-z][A-Za-z0-9 _-]*[A-Za-z0-9])\s*\(\s*(\d+(?:[,_]\d+)?)\s*x\s+(?:total\s+)?bet([^)]*)\)\s*(?:[—\-:]\s*(.*))?$/i;

/**
 * Parse 1 string từ `other_features`. Trả null nếu không match pattern tier.
 * Examples khớp:
 *   "Buy FREE SPINS (100x total bet) — guarantees 4+ scatters"
 *   "Buy Free Spins (100x bet)"
 *   "Buy Super Free Spins 1 (500x bet, multipliers min 20x)"
 *   "ANTE BET 1 (50x bet, ~8x higher free spins chance)"
 *   "SUPER SPIN 2 (5000x bet, guaranteed multiplier minimum 25x)"
 */
export function parseTierText(s: string): ParsedTierText | null {
  const m = s.match(TIER_PATTERN);
  if (!m) return null;
  const labelRaw = m[1]!.trim();
  const cost = Number(m[2]!.replace(/[,_]/g, ""));
  const innerNotes = m[3]?.trim().replace(/^,\s*/, "") || null;
  const trailingNotes = m[4]?.trim() || null;
  const notes = [innerNotes, trailingNotes].filter(Boolean).join(" — ") || null;

  let category: ParsedTierText["category"];
  if (
    /\bbuy\s+(free\s+spins|super\s+free\s+spins|bonus|feature)/i.test(s) ||
    /^buy\s+/i.test(labelRaw)
  ) {
    category = "buy_feature";
  } else if (/super\s+spin/i.test(labelRaw)) {
    category = "super_spin";
  } else if (/ante\s+bet|^\s*ante\b/i.test(labelRaw)) {
    category = "ante";
  } else {
    category = "other";
  }

  // Filter: "Max Win capped at 25,000x bet" không phải tier — label bắt đầu bằng "Max"
  // và pattern Nx ám chỉ cap, không phải cost. Loại bỏ.
  if (/^(?:max\s+win|max|overall|total)/i.test(labelRaw)) return null;
  // "Pay anywhere" / "Pays anywhere" v.v. không phải tier.
  if (category === "other" && !/buy|ante|super/i.test(labelRaw)) return null;

  // Normalize label casing: "Buy Free Spins" giữ nguyên, "ANTE BET 1" giữ nguyên all-caps.
  const label = labelRaw.replace(/\s+/g, " ").trim();

  return {
    raw: s,
    label,
    cost_multiplier: Number.isFinite(cost) ? cost : null,
    cost_label: `${m[2]}x bet`,
    notes,
    category,
  };
}

/**
 * Pair API tiers (đã có id/rtp/max_win_x) với text-parsed entries (label/cost).
 * Strategy:
 *   - Buy tiers: ALL có max_win_x giống nhau (Sweet Bonanza 25000 cả 3) → sort
 *     theo TEXT cost asc, sort theo TIER id asc (assume API đặt id theo cost order).
 *   - Ante variants: max_win_x khác nhau theo cost (rẻ → max cao). Sort tier
 *     by max_win_x DESC, sort text by cost ASC → pair theo index.
 */
type BuyTier = NonNullable<NonNullable<ApiSnapshot["buy_feature"]>["tiers"]>[number];
type AnteVariant = NonNullable<NonNullable<ApiSnapshot["special_bets"]>["variants"]>[number];

function pairBuyTiers(tiers: BuyTier[], buyTexts: ParsedTierText[]): BuyTier[] {
  const sortedTiers = [...tiers].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const sortedTexts = [...buyTexts].sort((a, b) => (a.cost_multiplier ?? 0) - (b.cost_multiplier ?? 0));
  return sortedTiers.map((tier, i) => {
    const txt = sortedTexts[i];
    if (!txt) return tier;
    return {
      ...tier,
      label: tier.label ?? txt.label,
      price_multiplier: tier.price_multiplier ?? txt.cost_multiplier,
    };
  });
}

function pairAnteVariants(variants: AnteVariant[], variantTexts: ParsedTierText[]): AnteVariant[] {
  // Sort tier theo max_win_x desc (cheap→high max_win), text theo cost asc
  const sortedVariants = [...variants].sort((a, b) => (b.max_win_x ?? 0) - (a.max_win_x ?? 0));
  const sortedTexts = [...variantTexts].sort((a, b) => (a.cost_multiplier ?? 0) - (b.cost_multiplier ?? 0));
  // Map ngược về thứ tự id ban đầu để giữ tier.id stable
  const enrichedById = new Map<string, AnteVariant>();
  sortedVariants.forEach((v, i) => {
    const txt = sortedTexts[i];
    if (!txt) {
      enrichedById.set(v.id, v);
      return;
    }
    enrichedById.set(v.id, {
      ...v,
      label: v.label ?? txt.label,
      cost_multiplier: v.cost_multiplier ?? txt.cost_multiplier,
    });
  });
  return variants.map((v) => enrichedById.get(v.id) ?? v);
}

export function enrichTiersFromText(snap: ApiSnapshot): ApiSnapshot {
  const otherFeatures = snap.features?.other_features ?? [];
  if (otherFeatures.length === 0) return snap;

  const parsed: ParsedTierText[] = [];
  for (const s of otherFeatures) {
    const p = parseTierText(s);
    if (p) parsed.push(p);
  }

  if (parsed.length === 0) return snap;

  const buyTexts = parsed.filter((p) => p.category === "buy_feature");
  const anteTexts = parsed.filter((p) => p.category === "ante" || p.category === "super_spin");

  const out: ApiSnapshot = { ...snap };

  if (snap.buy_feature?.tiers && buyTexts.length > 0) {
    out.buy_feature = {
      ...snap.buy_feature,
      tiers: pairBuyTiers(snap.buy_feature.tiers, buyTexts),
    };
  }

  if (snap.special_bets?.variants && anteTexts.length > 0) {
    out.special_bets = {
      ...snap.special_bets,
      variants: pairAnteVariants(snap.special_bets.variants, anteTexts),
    };
  }

  return out;
}

/**
 * Detect Turbo Spin từ vision controls + feature_mentions + paytable text.
 * Sweet Bonanza ẩn Turbo dưới hint "HOLD SPACE FOR TURBO SPIN" — vision
 * detect được string này nhưng không gắn vào `controls[]` → fall qua khe.
 */
export function detectTurboFromText(args: {
  apiSnapshot: ApiSnapshot;
  visionFeatureMentions: string[] | null;
  visionRawObservations: string | null;
  paytableMarkdown: string | null;
}): ApiSnapshot {
  const { apiSnapshot, visionFeatureMentions, visionRawObservations, paytableMarkdown } = args;
  if (apiSnapshot.ui_options?.turbo_spin?.available) return apiSnapshot; // đã set rồi

  const haystacks: string[] = [];
  if (visionFeatureMentions) haystacks.push(...visionFeatureMentions);
  if (visionRawObservations) haystacks.push(visionRawObservations);
  if (paytableMarkdown) haystacks.push(paytableMarkdown);

  const blob = haystacks.join(" ");
  const turboMatch = /\bturbo[\s-]?spin\b/i.test(blob);
  const holdSpaceMatch = /\bhold\s+space\b/i.test(blob);
  if (!turboMatch && !holdSpaceMatch) return apiSnapshot;

  const ui = apiSnapshot.ui_options ?? {
    autoplay: null,
    sound: null,
    turbo_spin: null,
    quick_spin: null,
    languages: null,
    fullscreen: null,
    other_controls: null,
  };
  return {
    ...apiSnapshot,
    ui_options: {
      ...ui,
      turbo_spin: {
        available: true,
        default_state: null,
      },
    },
    raw: {
      ...apiSnapshot.raw,
      turbo_detection: {
        via_keyword: turboMatch ? "turbo_spin" : "hold_space",
        source: visionRawObservations && /turbo/i.test(visionRawObservations) ? "vision" : "paytable",
      },
    },
  };
}
