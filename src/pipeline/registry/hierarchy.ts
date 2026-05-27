// Format the UI registry as a hierarchical tree string for AI prompts.
// Verified-by-human entries are marked so AI knows which coords are
// trusted vs auto-detected. Rejected entries are excluded.

import type { UiRegistry, UiElement } from "./types.js";

export type HierarchyOptions = {
  /** Include rejected entries? Default false. */
  includeRejected?: boolean;
  /** Maximum depth to render. Default unlimited. */
  maxDepth?: number;
  /** Indent per depth. Default "  " (two spaces). */
  indent?: string;
};

/**
 * Render the registry as a tree. Example:
 *
 *   - spinButton (1014,656) ✓ verified  [strategy: ai_vision]
 *   - buyBonusButton (137,224) ✓ verified
 *     - buyBonusButton__closeButton (905,232) ⏳ pending
 *     - buyBonusButton__freeSpinsOption (380,325) ✓ verified
 *       - buyBonusButton__freeSpinsOption__confirmButton (...) ⏳ pending
 *
 * AI catalog + case-action-translator can use this as the single source of
 * truth for what's available in the registry.
 */
export function formatRegistryHierarchy(registry: UiRegistry, opts: HierarchyOptions = {}): string {
  const indent = opts.indent ?? "  ";
  const maxDepth = opts.maxDepth ?? Infinity;
  const includeRejected = opts.includeRejected ?? false;

  const keys = Object.keys(registry).filter((k) => {
    const el = registry[k];
    if (!el) return false;
    if (!includeRejected && el.status === "rejected") return false;
    return true;
  });

  // Build parent → children map. Root parent = "".
  const childrenMap = new Map<string, string[]>();
  for (const k of keys) {
    const i = k.lastIndexOf("__");
    const parent = i === -1 ? "" : k.slice(0, i);
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(k);
  }
  for (const arr of childrenMap.values()) arr.sort();

  const lines: string[] = [];
  const roots = childrenMap.get("") ?? [];
  for (const root of roots) renderNode(root, 0);

  function renderNode(key: string, depth: number): void {
    if (depth > maxDepth) return;
    const el = registry[key];
    if (!el) return;
    const lastDelim = key.lastIndexOf("__");
    const displayKey = lastDelim === -1 ? key : key.slice(lastDelim + 2);
    const statusMark =
      el.status === "verified" ? "✓ verified" :
      el.status === "rejected" ? "✗ rejected" :
      "⏳ pending";
    const verifiedByQA = el.verifiedBy === "QA" ? " [human-verified]" : "";
    const prefix = indent.repeat(depth);
    lines.push(`${prefix}- ${key} → ${displayKey} (${el.x},${el.y}) ${statusMark}${verifiedByQA} [${el.strategy}]`);
    const children = childrenMap.get(key) ?? [];
    for (const c of children) renderNode(c, depth + 1);
  }

  return lines.join("\n");
}

/**
 * Stats summary for AI prompt header. Tells AI roughly how much registry data
 * is available + how much is human-verified.
 */
export function registryStats(registry: UiRegistry): {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  humanVerified: number;
  maxDepth: number;
} {
  let total = 0, verified = 0, pending = 0, rejected = 0, humanVerified = 0, maxDepth = 0;
  for (const [k, el] of Object.entries(registry)) {
    if (!el) continue;
    total++;
    const status = el.status ?? "pending";
    if (status === "verified") verified++;
    else if (status === "rejected") rejected++;
    else pending++;
    if (el.verifiedBy === "QA") humanVerified++;
    const depth = k.split("__").length;
    if (depth > maxDepth) maxDepth = depth;
  }
  return { total, verified, pending, rejected, humanVerified, maxDepth };
}

/**
 * True if registry has been substantively human-verified. Used by cold-start
 * to decide whether to skip AI discovery and reuse existing coords.
 */
export function isHumanVerified(registry: UiRegistry | null): boolean {
  if (!registry) return false;
  const stats = registryStats(registry);
  // Heuristic: at least 3 entries AND >=50% human-verified.
  return stats.total >= 3 && stats.humanVerified / stats.total >= 0.5;
}

void {} as unknown as UiElement;
