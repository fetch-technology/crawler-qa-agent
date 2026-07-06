// Drop main-screen false positives from popup AI discovery results.
//
// When a popup opens with a dimmed background, AI vision sometimes still
// flags main-game controls visible THROUGH the dim (spin/bet/menu in the
// background). Those are not popup content — they're the same buttons that
// already live in the main registry.
//
// Important nuance: some real popup buttons are centered over the main
// button row. A coordinate-only filter would silently drop them. We therefore
// drop only when the proposed key/name also looks like a main-screen control.
//
// IMPORTANT — sub-state overlaps are NOT filtered: two popups can legitimately
// share coords (e.g., `betMinus` and `betPlus` both open the SAME bet-selector
// popup, so its chips appear under BOTH namespaces with identical coords).
// Only overlap with TOP-LEVEL main keys is treated as a false positive.

// Tolerance for treating a popup-AI coord as overlapping a canonical main
// element. AI vision on canvas-rendered slot buttons routinely drifts 30-50px
// (the visible button is large, AI picks an arbitrary point within it). 30px
// was too tight in practice (Mahjong Wins, Riches: main spin/bet survived);
// 60px stays well under the typical slot-button spacing (~100-200px) so
// legitimate popup elements are never dropped.
export const POPUP_MAIN_OVERLAP_TOLERANCE_PX = 60;

export type PopupCandidate = { key: string; x: number; y: number };

export type FilterResult<T extends PopupCandidate> = {
  kept: T[];
  dropped: Array<{ key: string; x: number; y: number; overlapsMainKey: string }>;
};

/**
 * Build a prompt fragment listing the canonical main-screen elements with
 * their coords, so the AI vision call knows EXPLICITLY which buttons live in
 * the dimmed background and must not be re-detected as popup content. This is
 * the FIRST line of defense (instruct AI directly). The coord-based filter
 * below is the second line of defense (catches AI mistakes deterministically).
 * Returns empty string when there are no canonical main entries to list.
 */
export function buildMainElementsHint(
  registry: Record<string, { x: number; y: number } | undefined>,
): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(registry)) {
    if (!v) continue;
    if (k.includes("__")) continue;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    lines.push(`  - ${k} at (${Math.round(v.x)}, ${Math.round(v.y)})`);
  }
  if (lines.length === 0) return "";
  return [
    "",
    "",
    "--- MAIN-GAME CONTROLS (visible in the DIMMED BACKGROUND — DO NOT include these) ---",
    "These buttons live on the main game screen, BEHIND the popup. You may see",
    "them faintly through the popup's dimmed overlay. SKIP THEM ALL:",
    ...lines,
    "",
    `If you see a BACKGROUND/main-game button at any of those coords (within ~${POPUP_MAIN_OVERLAP_TOLERANCE_PX}px), DO NOT return it. If a foreground popup button is drawn on top of the same coord, DO return the popup button with its popup-specific label/key.`,
  ].join("\n");
}

/**
 * Build a hint block listing the popup's ALREADY-KNOWN children so AI
 * vision REUSES the exact same key names instead of inventing synonyms.
 *
 * Problem this solves: between Discover runs AI labels the same chip
 * inconsistently — e.g. run 1 returns `bet-0.40`, run 2 returns
 * `betAmount-0.40`. Both end up registered → duplicate entries. Mechanical
 * coord-overlap dedup catches this, but only post-fact. Telling the AI
 * "this popup already has bet-0.40 at (631,347) — reuse that name if
 * you see the same chip" stops the duplication at the source AND saves
 * downstream dedup logic from chasing every possible synonym.
 *
 * Lists ALL existing children (verified + pending) so resume-runs don't
 * blow away the pending ones with renames either. Only the parent's
 * direct children — grand-children belong to a deeper nesting level.
 */
export function buildExistingChildrenHint(
  registry: Record<string, { x: number; y: number; verifiedBy?: string | null } | undefined>,
  parentNamespace: string,
): string {
  if (!parentNamespace) return "";
  const prefix = `${parentNamespace}__`;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(registry)) {
    if (!v) continue;
    if (!k.startsWith(prefix)) continue;
    // Only DIRECT children — skip deeper nesting (`<prefix>__X__Y` etc).
    const remainder = k.slice(prefix.length);
    if (remainder.includes("__")) continue;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    const tag = v.verifiedBy === "QA" ? " [QA-verified]"
      : v.verifiedBy === "probe" ? " [probe-verified]"
      : "";
    lines.push(`  - ${remainder} at (${Math.round(v.x)}, ${Math.round(v.y)})${tag}`);
  }
  if (lines.length === 0) return "";
  return [
    "",
    "",
    `--- EXISTING CHILDREN of this popup (REUSE these key names verbatim) ---`,
    `The registry already has these children for "${parentNamespace}".`,
    `If you see the same UI control, return the EXACT SAME key (NOT a synonym).`,
    `For example, if "bet-0.40" is listed, do NOT return "betAmount-0.40" /`,
    `"betValue-0.40" / "wagerAmount-0.40" for the same chip — return "bet-0.40".`,
    `Only emit NEW children that have NO entry below:`,
    ...lines,
    "",
    "You MAY emit additional children not in this list — those are new discoveries.",
    "You MUST NOT rename any control that's already listed.",
  ].join("\n");
}

/**
 * Partition AI-returned popup elements into `kept` (popup-specific) vs
 * `dropped` (overlap a canonical main element → background false positive).
 * Pure; safe to test in isolation.
 */
export function filterMainOverlap<T extends PopupCandidate>(
  candidates: ReadonlyArray<T>,
  registry: Record<string, { x: number; y: number } | undefined>,
  tolerancePx: number = POPUP_MAIN_OVERLAP_TOLERANCE_PX,
): FilterResult<T> {
  // Only keys WITHOUT `__` are canonical main entries; sub-state keys may
  // legitimately collide with each other on coord.
  const mainEntries: Array<[string, { x: number; y: number }]> = [];
  for (const [k, v] of Object.entries(registry)) {
    if (!v) continue;
    if (k.includes("__")) continue;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    mainEntries.push([k, v]);
  }

  const kept: T[] = [];
  const dropped: FilterResult<T>["dropped"] = [];
  for (const c of candidates) {
    let overlap: string | null = null;
    for (const [k, v] of mainEntries) {
      if (Math.abs(v.x - c.x) <= tolerancePx && Math.abs(v.y - c.y) <= tolerancePx && isMainLikePopupCandidate(c.key, k)) {
        overlap = k;
        break;
      }
    }
    if (overlap) dropped.push({ key: c.key, x: c.x, y: c.y, overlapsMainKey: overlap });
    else kept.push(c);
  }
  return { kept, dropped };
}

function normalizeKeyForCompare(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True only when an overlapped popup candidate is probably a dimmed
 *  main-screen control, not a real foreground popup button drawn over the same
 *  coordinate. */
export function isMainLikePopupCandidate(candidateKey: string, mainKey: string): boolean {
  const c = normalizeKeyForCompare(candidateKey);
  const m = normalizeKeyForCompare(mainKey);
  if (!c || !m) return false;
  if (c.includes(m) || m.includes(c)) return true;

  const family = (key: string): string | null => {
    if (/spin|turbo|quickspin/.test(key)) return "spin";
    if (/bet|stake|wager|coin|chip/.test(key)) return "bet";
    if (/menu|hamburger|settings|setting/.test(key)) return "menu";
    if (/sound|audio|volume|mute|speaker/.test(key)) return "sound";
    if (/info|help|paytable|rules|question/.test(key)) return "info";
    if (/auto|autoplay/.test(key)) return "auto";
    return null;
  };
  const mf = family(m);
  const cf = family(c);
  return Boolean(mf && cf && mf === cf);
}
