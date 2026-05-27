import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { ApiMapping } from "../registry/types.js";
import type { MassiveSpinOptions, MassiveSpinResult } from "./types.js";
import { simulate, type SimulateResult } from "../../statistical/simulate.js";

export type ApiModeContext = {
  gameSlug: string;
  api: ApiMapping;
  parser: BaseParser;
  /**
   * Cascade game flag. When true, simulate fetches doCollect tail per spin
   * until `na !== "c"` so final balance + tw reflect the full chain.
   * Critical for PP tumble games (vs20rnriches, vswayscyhecity) — without it,
   * server auto-settles pending cascades on next doSpin and FinancialRule
   * sees balance drift (±N×0.8 etc).
   */
  cascade?: boolean;
};

/**
 * API mode runs the legacy simulate() to fire N spin requests via raw fetch,
 * then post-parses the dumped response bodies through the pipeline's parser to
 * produce NormalizedSpinResult[]. This bridges simulate's rich aggregate output
 * to the rule engine + aggregator (which need per-spin records).
 *
 * dumpResponses=count is forced so we can recover per-spin payloads without
 * modifying legacy simulate.
 */
export async function runApiMode(
  ctx: ApiModeContext,
  opts: MassiveSpinOptions,
): Promise<MassiveSpinResult & { simulate: SimulateResult | null; skipReason?: string }> {
  const start = Date.now();
  // Minimal spec stub enables fetchCascade in legacy simulate. Loop is a no-op
  // for non-cascade games (na=s first response → exits immediately), so it's
  // safe to pass even when uncertain.
  const spec = ctx.cascade
    ? ({ cascade: true } as unknown as Parameters<typeof simulate>[0]["spec"])
    : null;
  let sim: SimulateResult;
  try {
    sim = await simulate({
      slug: ctx.gameSlug,
      spins: opts.count,
      concurrency: opts.concurrency,
      throttleMs: opts.throttleMs,
      dumpResponses: opts.count,
      spec,
    });
  } catch (err) {
    // Graceful skip when no spin capture exists yet (no legacy recording AND
    // no pipeline capture). Common on first cold-start before capture-network
    // has produced data, or for games that have only been touched via manual
    // session preview-case (which writes to a different cache). Surface a
    // clear warning instead of crashing the warm-start orchestrator.
    const msg = err instanceof Error ? err.message : String(err);
    if (/No spin capture found|Could not find spin request template/i.test(msg)) {
      console.warn(`[api-mode] skipped massive-spin for "${ctx.gameSlug}": ${msg.split("\n")[0]}`);
      return {
        mode: "api",
        attempted: 0,
        succeeded: 0,
        spins: [],
        durationMs: Date.now() - start,
        simulate: null,
        skipReason: `no spin capture available for slug "${ctx.gameSlug}" — run a capture-network or manual session first`,
      };
    }
    throw err; // rethrow other errors (network, parser, etc.)
  }

  const rawSpins = sim.debugDump?.dir
    ? await loadDumpedSpins(sim.debugDump.dir, ctx.parser)
    : [];
  const spins = reconcileWinFromBalanceTrajectory(rawSpins);

  return {
    mode: "api",
    attempted: sim.spinsRequested,
    succeeded: sim.spinsSuccessful,
    spins,
    durationMs: Date.now() - start,
    simulate: sim,
  };
}

/**
 * For some demo servers (notably PP gs2c sandbox), per-spin `tw`/`w` fields are
 * desynced from `balance` due to deferred win-crediting. simulate handles this
 * via balance-delta inference for its RTP calc — mirror that here so the rule
 * engine + aggregator see SETTLED wins (what actually moved in the wallet),
 * not server-CLAIMED wins.
 *
 * Per-spin win is overwritten with `balance_now - balance_prev + bet`. The
 * first spin keeps its reported win (no prior balance to diff against).
 *
 * Sequence: spins must be in dispatch order (sortedIndices guarantees this).
 *
 * Caveat: FinancialRule becomes trivially-passing after this step because we
 * DEFINE win such that the equation holds. The "did server lie about win
 * amount" check belongs in a separate ReportedWinAccuracy rule (out of scope).
 */
function reconcileWinFromBalanceTrajectory(
  spins: NormalizedSpinResult[],
): NormalizedSpinResult[] {
  if (spins.length === 0) return spins;
  const out: NormalizedSpinResult[] = [];
  let prevBalance: number | null = null;
  for (const spin of spins) {
    if (prevBalance !== null && Number.isFinite(spin.balanceAfter)) {
      const inferred = spin.balanceAfter - prevBalance + spin.bet;
      if (Number.isFinite(inferred) && inferred >= -0.02) {
        out.push({
          ...spin,
          win: Math.max(0, inferred),
          balanceBefore: prevBalance,
          raw: { ...spin.raw, _reportedWin: spin.win, _inferredFromBalance: true },
        });
        prevBalance = spin.balanceAfter;
        continue;
      }
    }
    out.push(spin);
    // If current balanceAfter is missing/NaN, reset to null so the next spin
    // doesn't diff against a stale 2-spins-back balance (which would inflate
    // its inferred win by an extra bet).
    prevBalance = Number.isFinite(spin.balanceAfter) ? spin.balanceAfter : null;
  }
  return out;
}

async function loadDumpedSpins(
  dir: string,
  parser: BaseParser,
): Promise<NormalizedSpinResult[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  // Group files by spin index. Three artifacts per spin:
  //   spin-NNN-request.txt   — querystring body sent
  //   spin-NNN-response-*.txt — initial response body (pre-cascade-tail)
  //   spin-NNN-final.json    — final parsed state after cascade collection;
  //                            preferred over response.txt for accurate
  //                            balance/tw in cascade games.
  const byIndex = new Map<string, { request?: string; response?: string; final?: string }>();
  for (const f of files) {
    const m = /^spin-(\d+)-(request|response|final)/.exec(f);
    if (!m) continue;
    const idx = m[1]!;
    const kind = m[2] as "request" | "response" | "final";
    const entry = byIndex.get(idx) ?? {};
    entry[kind] = path.join(dir, f);
    byIndex.set(idx, entry);
  }

  const sortedIndices = [...byIndex.keys()].sort();
  const spins: NormalizedSpinResult[] = [];
  for (const idx of sortedIndices) {
    const pair = byIndex.get(idx);
    if (!pair) continue;

    let requestBody: string | null = null;
    if (pair.request) {
      try {
        requestBody = await readFile(pair.request, "utf8");
      } catch {
        requestBody = null;
      }
    }

    // Prefer final.json sidecar (cascade-aware). Encode as querystring so
    // existing parsers (which expect that format) work uniformly.
    if (pair.final) {
      try {
        const final = JSON.parse(await readFile(pair.final, "utf8")) as Record<string, unknown>;
        // Skip cascade tails — na=c responses are continuations of the
        // PREVIOUS initial spin (na=s), not new logical spins. simulate
        // fires doSpin for each iteration, but PP server may respond with
        // na=c when prior cascade still pending. Treating these as separate
        // spins (with their own bet) inflates totalBet → false-positive
        // FinancialRule mismatches (~16 cascade tails per 100 spins seen).
        if (final.na === "c") continue;
        const reencoded = encodeAsQueryString(final);
        const spin = parser.parseSpinPair
          ? parser.parseSpinPair(requestBody, reencoded)
          : parser.parseResponse(reencoded);
        spins.push(spin);
        continue;
      } catch {
        // fall through to response.txt
      }
    }

    if (!pair.response) continue;
    let responseBody: string;
    try {
      responseBody = await readFile(pair.response, "utf8");
    } catch {
      continue;
    }
    if (!responseBody || responseBody.startsWith("(error:")) continue;
    // Same na=c filter applied to raw response body fallback path.
    if (/(?:^|&)na=c(?:&|$)/.test(responseBody)) continue;
    try {
      const spin = parser.parseSpinPair
        ? parser.parseSpinPair(requestBody, responseBody)
        : parser.parseResponse(responseBody);
      spins.push(spin);
    } catch {
      // skip unparseable
    }
  }
  return spins;
}

function encodeAsQueryString(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}
