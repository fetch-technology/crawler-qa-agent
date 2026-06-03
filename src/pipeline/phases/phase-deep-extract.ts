// Phase: deep-extract — vision-driven capture of paytable / info / buy-options
// / special-bets text + JSON from in-game popups. Thin wrapper around
// step4-feature-discovery/deep-extract.ts so the same logic runs in BOTH
// cold-start (CLI) and Auto-Onboard (dashboard) without duplication.
//
// Side effects: writes fixtures/registry/<slug>/auxiliary-sources/{*.md,*.json}
// + persists paytable via paytableStore.save(). Idempotent — re-runs overwrite.
//
// Why a phase wrapper exists at all (vs caller importing deepExtractInfo
// directly): consistent { ok, reason, durationMs } envelope + opt to skip
// via QA_DEEP_EXTRACT=0, mirrored from cold-start's behavior so the env-var
// contract is the same regardless of caller.

import { deepExtractInfo, type DeepExtractResult } from "../step4-feature-discovery/deep-extract.js";
import type { PhaseContext, PhaseResult } from "./types.js";

export type PhaseDeepExtractResult = PhaseResult & {
  /** Raw deep-extract output — full text + parsed JSON sources. Null when
   *  phase was skipped (env opt-out, no page available). */
  extract: DeepExtractResult | null;
};

export async function phaseDeepExtract(ctx: PhaseContext): Promise<PhaseDeepExtractResult> {
  const t0 = Date.now();
  if (process.env.QA_DEEP_EXTRACT === "0") {
    return { ok: true, extract: null, note: "skipped via QA_DEEP_EXTRACT=0", durationMs: Date.now() - t0 };
  }
  if (!ctx.page) {
    return { ok: false, extract: null, reason: "no page — deep-extract requires browser session", durationMs: Date.now() - t0 };
  }
  if (!ctx.uiMap || Object.keys(ctx.uiMap).length === 0) {
    return { ok: false, extract: null, reason: "no UI registry — run discover first", durationMs: Date.now() - t0 };
  }
  try {
    const extract = await deepExtractInfo(ctx.page, ctx.uiMap, ctx.gameSlug);
    return { ok: true, extract, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      extract: null,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}
