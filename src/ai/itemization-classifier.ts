// AI tail (Phase 5) for win-itemization detection. Invoked ONLY when the
// deterministic detector + replay-gate can't reconcile despite enough winning
// rounds (spec-learner's `needsAi`) — e.g. a game emits MULTIPLE itemization
// fields and the default "auto" picked the wrong one, or the format is
// unusual. The model reads raw sample bodies and picks the best-fit strategy
// among the KNOWN enum. Its answer is NEVER trusted directly — the caller
// re-runs the replay-gate on the AI's pick, and only a reconciling result is
// promoted to `trusted`. So a wrong AI guess is caught, not believed.

import { askClaude, extractJsonFromText } from "./claude.js";
import type { WinItemization } from "../pipeline/step6-build-model/providers/spec-types.js";

const VALID: ReadonlySet<string> = new Set(["wlc_v", "cluster", "lines", "none", "auto"]);

const SYSTEM = `You are a slot-game protocol analyst. Given raw spin RESPONSE bodies
(URL-encoded key=value&... pairs) from one game, decide HOW the server itemizes
per-combo wins. The total round win is the \`tw\` field. Itemization strategies:

- "wlc_v":  a \`wlc_v\` field lists each winning combo as
            symbol~win~ways~count~positions (e.g. wlc_v=12~0.04~1~3~6,8,19~l;…).
            Common for ways/payline games.
- "cluster": pays-anywhere games list each cluster in \`l0\`,\`l1\`,… as
            marker~win~pos~pos~… (the symbol is read from the reel grid \`s\`).
- "lines":  per-payline itemization in a per-line field (rare).
- "none":   the server reports ONLY the total \`tw\`, no per-combo breakdown.

Pick the strategy whose itemized wins would SUM to \`tw\` on the winning frames.
If several fields are present, choose the one that actually reconciles to \`tw\`.
Reply ONLY with JSON: {"value":"wlc_v|cluster|lines|none","reasoning":"<1 sentence>"}.`;

/** Ask the model which itemization strategy fits the samples. Returns null on
 *  any failure (no token, parse error, invalid value) so the caller falls back
 *  to the deterministic (untrusted) overlay rather than throwing. Pure I/O —
 *  the gate, not this function, decides trust. */
export async function aiProposeWinItemization(
  sampleResponses: string[],
): Promise<{ value: WinItemization; reasoning: string } | null> {
  // Prefer WINNING frames (tw>0) — they're what the gate checks — and cap the
  // prompt size. A handful of winning samples is plenty to classify.
  const winning = sampleResponses.filter((b) => {
    const m = /(?:^|&)tw=([0-9.]+)/.exec(b);
    return m != null && Number(m[1]) > 0;
  });
  const chosen = (winning.length > 0 ? winning : sampleResponses).slice(0, 8);
  if (chosen.length === 0) return null;

  try {
    const raw = await askClaude({
      content: `Sample winning spin responses:\n${chosen.map((b, i) => `[${i + 1}] ${b}`).join("\n\n")}`,
      system: SYSTEM,
      label: "parser/itemization",
    });
    const json = extractJsonFromText<{ value?: string; reasoning?: string }>(raw);
    const value = json?.value;
    if (typeof value !== "string" || !VALID.has(value)) return null;
    return { value: value as WinItemization, reasoning: json?.reasoning ?? "" };
  } catch {
    return null; // missing token / API error / parse failure → graceful fallback
  }
}
