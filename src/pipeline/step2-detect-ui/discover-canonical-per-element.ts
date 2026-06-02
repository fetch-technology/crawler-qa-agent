// Per-element canonical-button discovery — fallback for when the cheap batch
// AI-vision seed (resolver.ts → ai-vision-batch.ts) produces clustered /
// obviously-wrong coords. Observed 2026-05-31 on vs20rnriches: batch returned
// spinButton + betPlus + betMinus + autoButton all within ~50px of each other
// (cluster at the bottom-right corner), with the actual buttons spread across
// the bottom of the canvas. Probe correctly rejected each but crop-verify
// agent's per-element refinement was anchored to the wrong seed and committed
// neighboring (still-wrong) coords — the cluster pulled the agent in.
//
// This module bypasses the batch entirely for canonical keys: it discovers
// spinButton FIRST (largest, most unambiguous control), then uses spinButton's
// verified coord as a SPATIAL ANCHOR in the description for every subsequent
// canonical key. The crop-verify agent now has a measurable reference ("80px
// right of (988, 640)") instead of relying solely on visual identification.
//
// Cost: ~5-10x more LLM calls than the batch seed (one agent invocation per
// canonical element vs. one batch). Time: ~2-3 min per element × 6-8 = 15-25
// min for a full canonical sweep. Acceptable for one-time discovery / cluster
// recovery; the cheap batch is still the default path when its output passes
// the cluster check (deepDiscover decides which path to run).

import type { Page } from "playwright";
import { cropVerifyAgent } from "../../ai/crop-verify-agent.js";
import { dismissPopupsLoop } from "../utils/ocr-popup.js";
import {
  CANONICAL_PRIORITY_ORDER,
  describeCanonicalElement,
  enrichDescriptionWithSpinAnchor,
} from "../registry/canonical-element-hints.js";
import type { UiElement, UiRegistry } from "../registry/types.js";

export type PerElementDiscoverResult = {
  /** Updated registry — only the keys this run discovered are mutated; QA /
   *  probe-verified entries are NEVER overwritten. */
  registry: UiRegistry;
  discovered: string[];
  notFound: string[];
  failed: Array<{ key: string; reason: string }>;
};

const DEFAULT_MAX_TURNS = 400;

/**
 * Detect when the batch AI-vision seed produced a SUSPICIOUS CLUSTER of
 * canonical coordinates — i.e. ≥3 canonical (non-verified) elements all within
 * `maxDistance` px of each other. Real game UIs spread main controls across
 * the bottom (or across the screen for some layouts) — a tight cluster of
 * spin + bet± + auto in one corner is almost always a vision failure mode.
 *
 * Returns the offending keys + centroid so caller can clear them and re-seed
 * per-element. `verifiedBy ∈ {"QA","probe"}` entries are EXCLUDED from cluster
 * detection — they're known correct and shouldn't pull the centroid.
 */
export function detectCanonicalCluster(
  registry: UiRegistry,
  canonicalKeys: ReadonlyArray<string>,
  opts: { maxDistance?: number; minCluster?: number } = {},
): { detected: boolean; keys: string[]; centroid: { x: number; y: number } | null } {
  const maxDistance = opts.maxDistance ?? 80;
  const minCluster = opts.minCluster ?? 3;

  const candidates = canonicalKeys
    .map((k) => ({ k, el: registry[k] }))
    .filter(
      (e): e is { k: string; el: UiElement } =>
        !!e.el &&
        Number.isFinite(e.el.x) &&
        Number.isFinite(e.el.y) &&
        e.el.verifiedBy !== "QA" &&
        e.el.verifiedBy !== "probe",
    );

  for (let i = 0; i < candidates.length; i++) {
    const seed = candidates[i]!;
    const cluster = [seed];
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const other = candidates[j]!;
      const dx = seed.el.x - other.el.x;
      const dy = seed.el.y - other.el.y;
      if (Math.hypot(dx, dy) <= maxDistance) cluster.push(other);
    }
    if (cluster.length >= minCluster) {
      const cx = cluster.reduce((s, c) => s + c.el.x, 0) / cluster.length;
      const cy = cluster.reduce((s, c) => s + c.el.y, 0) / cluster.length;
      return {
        detected: true,
        keys: cluster.map((c) => c.k),
        centroid: { x: Math.round(cx), y: Math.round(cy) },
      };
    }
  }
  return { detected: false, keys: [], centroid: null };
}

/**
 * Discover one canonical element at a time via crop-verify agent. Iterates in
 * an order that puts spinButton FIRST so its coord can anchor the descriptions
 * of subsequent keys (see [enrichDescriptionWithSpinAnchor]).
 *
 * Between iterations, dismiss popups and wait — the agent's click-verify step
 * may have opened a popup or triggered a spin. Don't let that state leak into
 * the next element's discovery (the next agent would screenshot a popup
 * instead of the main game and either fail or commit a wrong coord).
 */
export async function discoverCanonicalPerElement(
  page: Page,
  opts: {
    cdpEndpoint: string;
    existingRegistry: UiRegistry;
    /** Limit to specific canonical keys. Default: all in CANONICAL_PRIORITY_ORDER. */
    onlyKeys?: ReadonlyArray<string>;
    /** Crop-verify agent budget per element. */
    maxTurnsPerElement?: number;
    /** Where Playwright MCP writes debug screenshots from the crop-verify
     *  agent. Caller passes per-game `fixtures/registry/<slug>/debug-agent/`
     *  so screenshots stay grouped per game instead of in repo root. */
    outputDir?: string;
    abortSignal?: AbortSignal;
  },
): Promise<PerElementDiscoverResult> {
  const registry: UiRegistry = { ...opts.existingRegistry };
  const discovered: string[] = [];
  const notFound: string[] = [];
  const failed: Array<{ key: string; reason: string }> = [];

  // Candidate keys: requested (or all canonical), minus already-verified.
  const requested = opts.onlyKeys ?? CANONICAL_PRIORITY_ORDER;
  const targets = requested.filter((k) => {
    if (!describeCanonicalElement(k)) return false;
    const existing = registry[k];
    return !(existing && (existing.verifiedBy === "QA" || existing.verifiedBy === "probe"));
  });

  // Put spinButton first so its coord anchors the rest. Otherwise preserve
  // CANONICAL_PRIORITY_ORDER (small/easy elements before adjacent ambiguous ones).
  const ordered = [...targets].sort((a, b) => {
    if (a === "spinButton") return -1;
    if (b === "spinButton") return 1;
    return CANONICAL_PRIORITY_ORDER.indexOf(a) - CANONICAL_PRIORITY_ORDER.indexOf(b);
  });

  for (const key of ordered) {
    if (opts.abortSignal?.aborted) break;
    const baseDesc = describeCanonicalElement(key);
    if (!baseDesc) continue;

    const spinCoord =
      registry.spinButton && Number.isFinite(registry.spinButton.x) && Number.isFinite(registry.spinButton.y)
        ? { x: registry.spinButton.x, y: registry.spinButton.y }
        : null;
    const description = enrichDescriptionWithSpinAnchor(key, baseDesc, spinCoord);
    const anchorTag = key === "spinButton" ? "no-anchor" : spinCoord ? `anchor=spin@(${spinCoord.x},${spinCoord.y})` : "no-anchor";
    console.log(`[discover-per-element] ${key}: invoking crop-verify agent (${anchorTag})…`);

    try {
      const r = await cropVerifyAgent({
        description,
        label: key,
        cdpEndpoint: opts.cdpEndpoint,
        maxTurns: opts.maxTurnsPerElement ?? DEFAULT_MAX_TURNS,
        outputDir: opts.outputDir,
        abortSignal: opts.abortSignal,
      });

      if (r.ok && typeof r.x === "number" && typeof r.y === "number") {
        registry[key] = {
          x: r.x,
          y: r.y,
          strategy: "ai_vision",
          confidence: 0.85,
          status: "pending",
          detectedAt: new Date().toISOString(),
        };
        discovered.push(key);
        console.log(`[discover-per-element] ${key}: agent committed (${r.x},${r.y}) turns=${r.turnsUsed}`);
      } else if (r.reason && /not found/i.test(r.reason)) {
        notFound.push(key);
        console.log(`[discover-per-element] ${key}: agent reported BUTTON NOT FOUND on current screen`);
      } else {
        failed.push({ key, reason: r.reason ?? "unknown" });
        console.log(`[discover-per-element] ${key}: failed — ${r.reason ?? "unknown"}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ key, reason });
      console.warn(`[discover-per-element] ${key}: threw — ${reason}`);
    }

    // Restore main state for the next iteration. The agent's click-verify step
    // typically leaves a popup open OR (for spinButton) a spin in progress.
    try {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(800);
      await dismissPopupsLoop(page, { maxAttempts: 3 });
      // Extra settle: spin animations take a couple seconds to finish + balance
      // refresh fires async. Without this gap the next agent screenshots a
      // mid-animation frame and the crop-verify procedure thrashes.
      await page.waitForTimeout(2000);
    } catch {}
  }

  return { registry, discovered, notFound, failed };
}
