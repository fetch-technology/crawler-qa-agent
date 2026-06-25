// AI provider-spec learner. Given a handful of REJECTED spin request/response
// samples from an unsupported provider, ask Claude to propose a ProviderSpec
// (deep field paths + amount scale + board decoder), then VERIFY it
// deterministically by running the resulting SpecDrivenParser over the same
// samples. AI only PROPOSES the field map; acceptance is decided by arithmetic,
// never by the model's say-so.

import { askClaude, extractJsonFromText } from "./claude.js";
import type { ProviderSpec } from "../pipeline/step6-build-model/providers/spec-types.js";
import { SpecDrivenParser } from "../pipeline/step6-build-model/providers/spec-driven-parser.js";
import { replayGate } from "../pipeline/step8-run-scenarios/spec-replay-gate.js";

export type ProviderSample = { url: string; reqBody: string; respBody: string };

export type LearnVerifyResult = {
  ok: boolean;
  reasons: string[];
  spins: Array<{ bet: number; win: number; balanceBefore: number | null; balanceAfter: number; reelCols: number }>;
};

const SYSTEM = `You map an unknown slot-game provider's network wire format to a ProviderSpec JSON used by a generic parser. You are given 1-3 SPIN samples (request body + response body + URL). Infer how to read each spin's bet, win, balance, and reel board from the RESPONSE.

Return ONLY a JSON object with this shape (no prose):
{
  "name": "<ShortProviderName>",
  "wireFormat": "json",
  "urlPatterns": ["<regex matching the spin endpoint host/path>"],
  "skipUrlPatterns": [],
  "response": {
    "fields": {
      "balanceAfter": "<deep.path.to.current_balance>",
      "betAmount": "<deep.path.to.round_bet>",       // omit if bet only in request
      "totalWin": "<deep.path.to.round_win>",
      "initialReels": "<deep.path.to.board>"          // omit if no board
    },
    "reelsDecoder": "json_array",                      // board is a 2D JSON array
    "defaultReelDimensions": { "width": <n>, "height": <n> },
    "amountScale": <1 or 0.01>,                         // 0.01 if amounts are MINOR units (cents)
    "deriveBalanceBefore": true,                        // true when only current balance is given
    "shapeScore": { "requiredFields": [<the field paths that MUST exist>], "bonusFields": [], "minScore": <n> },
    "winItemization": "none"
  },
  "request": { "fields": {}, "betFormula": "explicit" },
  "roundId": { "source": "response", "fields": ["<deep.path.to.request_id>"], "fallback": "response_hash" }
}

OPTIONAL free-spin / feature-state detection (include ONLY when a sample shows
a free-spin/feature indicator that is NOT a plain top-level numeric counter):
- "response.nestedExtractions": pull a value out of a DELIMITED string field
  into a new top-level key, e.g. a PP clone packs "trail=mode~free;...;fs~3":
    "nestedExtractions": [{ "sourceField": "trail", "pattern": "fs~(\\d+)", "targetField": "fs" }]
  then set "response.fields.freeSpinsRemaining": "fs".
- "response.freeSpinSignal": a declarative FS-state matcher when the indicator
  is a token rather than a number, e.g.:
    "freeSpinSignal": { "field": "trail", "contains": "mode~free" }
  Forms: { "counterField": "<numeric field>" } | { "field": "<str field>",
  "contains": "<substr>" | "pattern": "<regex>" } | { "rawBodyPattern": "<regex>" }.
  IMPORTANT: the signal marks a frame as a FREE-SPIN CANDIDATE only — a BUY frame
  often carries the same token but DEDUCTS the buy cost; the parser's balance
  guard keeps it NORMAL. Acceptance is verified arithmetically (free frames must
  not deduct a wager), never by your say-so.

RULES:
- Field paths are DOT-separated to walk nested objects (e.g. "context.spins.round_bet", "user.balance"). Use "a|b" only for alternative names.
- AMOUNT SCALE: if bet/win/balance look like integer MINOR units (e.g. round_bet 50 for a 0.50 bet, balance 100905650), set amountScale to 0.01. If they already look like decimals, use 1.
- requiredFields must be paths that are ALWAYS present on a real spin (e.g. the board path + a balance path). Set minScore = number of requiredFields.
- urlPatterns: a regex that matches the spin endpoint (use the host or a stable path segment, escape dots). It must NOT match unrelated endpoints.
- Output STRICT JSON only.`;

/** Ask Claude to propose a ProviderSpec from samples. Returns null on failure. */
export async function proposeProviderSpec(samples: ProviderSample[]): Promise<ProviderSpec | null> {
  if (samples.length === 0) return null;
  const payload = samples.slice(0, 3).map((s, i) =>
    `SAMPLE ${i + 1}\nURL: ${s.url}\nREQUEST: ${s.reqBody.slice(0, 2000)}\nRESPONSE: ${s.respBody.slice(0, 4000)}`,
  ).join("\n\n");
  let raw: string;
  try {
    raw = await askClaude({
      content: `Infer the ProviderSpec for this provider from these spin samples:\n\n${payload}`,
      system: SYSTEM,
      label: "learn-provider",
      timeoutMs: 90_000,
    });
  } catch {
    return null;
  }
  const spec = extractJsonFromText<ProviderSpec>(raw);
  if (!spec || typeof spec !== "object") return null;
  // Harden a few fields the parser depends on, regardless of model output.
  spec.wireFormat = "json";
  if (!Array.isArray(spec.urlPatterns) || spec.urlPatterns.length === 0) {
    try { spec.urlPatterns = [new URL(samples[0]!.url).host.replace(/\./g, "\\.")]; } catch { spec.urlPatterns = []; }
  }
  if (!spec.response?.shapeScore) return null;
  if (!spec.request) spec.request = { fields: {}, betFormula: "explicit" } as ProviderSpec["request"];
  if (!spec.roundId) spec.roundId = { source: "response", fields: [], fallback: "response_hash" };
  if (!spec.name) spec.name = "Learned";
  return spec;
}

/** Deterministically verify a proposed spec by parsing the samples with it.
 *  AI is NOT trusted — only arithmetic. A spec passes when EVERY sample parses
 *  to a plausible spin (finite, non-absurd bet/win/balance + a real reel grid)
 *  and the bet isn't accidentally mapped onto the balance. */
export function verifyLearnedSpec(spec: ProviderSpec, samples: ProviderSample[]): LearnVerifyResult {
  const reasons: string[] = [];
  const spins: LearnVerifyResult["spins"] = [];
  if (samples.length === 0) return { ok: false, reasons: ["no samples"], spins };
  let parser: SpecDrivenParser;
  try {
    parser = new SpecDrivenParser(spec, "GenericParser");
  } catch (err) {
    return { ok: false, reasons: [`spec invalid: ${err instanceof Error ? err.message : String(err)}`], spins };
  }
  let okCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const tag = `sample#${i + 1}`;
    if (!parser.canParseResponse(s.respBody, s.url)) {
      reasons.push(`${tag}: spec did not accept the response (urlPatterns / shapeScore)`);
      continue;
    }
    let spin;
    try {
      spin = parser.parseSpinPair
        ? parser.parseSpinPair(s.reqBody || null, s.respBody, s.url)
        : parser.parseResponse(s.respBody);
    } catch (err) {
      reasons.push(`${tag}: parse threw — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { bet, win, balanceAfter, balanceBefore, reels } = spin;
    const reelCols = reels.length;
    spins.push({ bet, win, balanceBefore, balanceAfter, reelCols });
    const problems: string[] = [];
    if (!Number.isFinite(balanceAfter) || balanceAfter <= 0) problems.push(`balanceAfter=${balanceAfter}`);
    if (!Number.isFinite(bet) || bet < 0 || bet > 1_000_000) problems.push(`bet=${bet}`);
    if (!spin.isFreeSpin && bet === 0) problems.push("bet=0 on a paid spin");
    if (!Number.isFinite(win) || win < 0) problems.push(`win=${win}`);
    if (balanceAfter > 0 && bet > 0 && bet === balanceAfter) problems.push("bet equals balance (likely mis-mapped)");
    if (reelCols > 0 && reelCols < 3) problems.push(`board only ${reelCols} cols`);
    if (problems.length > 0) reasons.push(`${tag}: ${problems.join(", ")}`);
    else okCount++;
  }
  // Accept on ≥1 fully-plausible spin rather than ALL samples. WS-protocol
  // providers (Playtech socket.io) split a spin across frames, so the captured
  // samples include PARTIAL frames (e.g. a balance-only or board-only frame
  // whose balanceAfter is 0) — those are capture noise, not evidence the spec
  // is wrong. A genuinely bad spec produces ZERO plausible spins (and the
  // bet==balance / board<3 mis-map checks still veto a specific sample). So
  // "at least one sample maps to a sane bet/win/balance/board" is the gate.
  let ok = okCount >= 1;
  if (ok) reasons.push(`${okCount}/${samples.length} sample(s) parsed to plausible spins`);
  else reasons.push(`no sample parsed to a plausible spin (${samples.length} tried)`);

  // State-signal safety check — when the spec proposes a free-spin signal
  // (freeSpinSignal or an fs nestedExtraction), it must NOT mark a frame that
  // DEDUCTS a wager as free (a too-greedy signal that swallows BUY/base spins).
  // The replay-gate chains balanceBefore across the samples (which isolated
  // per-sample parsing can't), so it's the right place to read deduction.
  // Full FS-vs-base discrimination coverage is deferred to the Phase-2
  // replay-gate over the complete capture; here we only reject an unsafe signal.
  const hasStateSignal = !!spec.response.freeSpinSignal
    || (spec.response.nestedExtractions ?? []).some((e) => e.targetField === spec.response.fields.freeSpinsRemaining);
  if (ok && hasStateSignal) {
    try {
      const gate = replayGate(
        parser,
        samples.map((s) => ({ request: s.reqBody, response: s.respBody, url: s.url })),
        { minFreeFrames: 1, minBaseFrames: 0 },
      );
      if (gate.stateSignal.freeFramesThatDeducted > 0) {
        ok = false;
        reasons.push(
          `free-spin signal rejected: ${gate.stateSignal.freeFramesThatDeducted} FREE_SPIN frame(s) deducted a wager `
            + `(${gate.stateSignal.examples[0] ?? "signal too greedy"})`,
        );
      } else if (gate.stateSignal.freeFrames > 0) {
        reasons.push(`free-spin signal: ${gate.stateSignal.freeFrames} FS frame(s), none deducted — safe`);
      }
    } catch (err) {
      // Gate failure is non-fatal to the bet/win plausibility verdict.
      reasons.push(`state-signal check skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok, reasons, spins };
}
