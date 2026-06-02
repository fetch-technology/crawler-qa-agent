// AI: Agent-driven click verification — copies the upstream
// logic-data-crawler-creator pattern (canvas-click skill + outer agent that
// observes click result + reasons about whether it matches expected
// behavior), adapted to per-element verification for QA registry building.
//
// Unlike crop-verify-agent.ts (which LOCATES a button via crop iteration),
// this agent CLICKS at an already-known coord and judges the response:
//   - Pre-click screenshot baseline.
//   - Single mouse_click at the supplied coord.
//   - Post-click screenshot + recent network requests.
//   - Compare against the supplied expected-behavior description.
//   - Commit verdict {ok, reason} via custom MCP tool.
//
// Replaces pixel-diff sub-state probe (false-positives observed when
// clicks on wrong coords still produced visible change — real spin from
// canvas tap, popup-close from wrong-area click, etc.). The agent reads
// the same screenshot + network signal that a human QA would and reasons
// about it; no hardcoded threshold can substitute for "did the click do
// what we expected".

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "module";
import path from "path";
import { z } from "zod";

export type VerifyClickResult = {
  ok: boolean;
  reason: string;
  turnsUsed?: number;
};

const playwrightMcpCliPath = (() => {
  const requireFn = createRequire(import.meta.url);
  const pkgPath = requireFn.resolve("@playwright/mcp/package.json");
  return path.join(path.dirname(pkgPath), "cli.js");
})();

export async function verifyClickAgent(opts: {
  /** HTTP CDP endpoint the manual-session opened (e.g. "http://localhost:53827"). */
  cdpEndpoint: string;
  /** Coord to click. */
  coord: { x: number; y: number };
  /** Element key (used in prompts for context, not for click logic). */
  elementKey: string;
  /** What the click is expected to produce — see expectedBehaviorFor(). */
  expectedBehavior: string;
  /** Optional: state context (e.g., "inside the paytable popup"). */
  stateContext?: string;
  /** Per-call turn budget. Single verify usually takes 5-10 turns. */
  maxTurns?: number;
  /** Where Playwright MCP writes browser_take_screenshot output. When set,
   *  debug PNGs land under this directory instead of the repo root —
   *  callers typically pass `fixtures/registry/<gameSlug>/debug-agent/`. */
  outputDir?: string;
  abortSignal?: AbortSignal;
}): Promise<VerifyClickResult> {
  let verdict: { ok: boolean; reason: string } | null = null;

  // Custom MCP: verdict commit. The agent must call this exactly once to
  // end the task. ok/reason are the verdict; downstream code persists
  // ok→verified or ok→stay-pending based on it.
  const verdictMcp = createSdkMcpServer({
    name: "verify",
    version: "1.0.0",
    tools: [
      tool(
        "commit_verdict",
        "Commit your verification verdict. Call this exactly ONCE after observing the click result. Setting ok=true marks the element verified; ok=false leaves it pending. Reason should briefly describe what was observed (what changed on screen, what network fired, why this matches/mismatches the expected behavior).",
        {
          ok: z.boolean().describe("true if the observed click response matches the expected behavior; false otherwise."),
          reason: z.string().describe("Short explanation of what was observed and the verdict rationale (1-2 sentences)."),
        },
        async (input) => {
          verdict = { ok: input.ok as boolean, reason: input.reason as string };
          return { content: [{ type: "text" as const, text: `verdict committed: ok=${input.ok}` }] };
        },
      ),
    ],
  });

  const playwrightMcp = {
    type: "stdio" as const,
    command: "node",
    args: [
      playwrightMcpCliPath,
      "--browser=chromium",
      "--cdp-endpoint",
      opts.cdpEndpoint,
      "--shared-browser-context",
      ...(opts.outputDir ? ["--output-dir", opts.outputDir] : []),
    ],
  };

  const stateContextLine = opts.stateContext
    ? `Current state: ${opts.stateContext}\n`
    : "";

  const systemPrompt =
    "You are a click-result verification agent for a slot-game UI registry. " +
    "The browser is ALREADY connected to the user's session via CDP — the game page is open and " +
    "the game is in the EXPECTED parent state (the popup or screen where the target element lives). " +
    "DO NOT navigate, DO NOT click anywhere except the target coord ONCE, DO NOT recover state.\n\n" +
    `${stateContextLine}` +
    `Target element key: ${opts.elementKey}\n` +
    `Target click coord: (${opts.coord.x}, ${opts.coord.y})\n\n` +
    `EXPECTED BEHAVIOR:\n${opts.expectedBehavior}\n\n` +
    "Procedure:\n" +
    "1. browser_take_screenshot — capture pre-click state. Note what's visible.\n" +
    `2. browser_mouse_click with x=${opts.coord.x}, y=${opts.coord.y} — click ONCE.\n` +
    "3. Wait ~1.5s for the game to respond (Playwright tools have implicit waits; you may take an interim screenshot if needed).\n" +
    "4. browser_take_screenshot — capture post-click state.\n" +
    "5. browser_network_requests — see what (if any) network activity fired since the click.\n" +
    "6. Compare post-click observation against the EXPECTED BEHAVIOR. Decide:\n" +
    "   - ok=true ⇔ the response matches what was expected. The click hit the intended element.\n" +
    "   - ok=false ⇔ the response does NOT match expected. Common causes:\n" +
    "       • click triggered a real SPIN (reels rotating, balance dropping by bet amount) when the expected behavior was UI-only;\n" +
    "       • a different popup opened than expected (clicked an adjacent button);\n" +
    "       • popup closed unexpectedly when the expected behavior was opening a sub-popup;\n" +
    "       • nothing visible changed at all (click landed in dead space).\n" +
    "7. Call commit_verdict(ok, reason) ONCE. THIS ENDS THE TASK.\n\n" +
    "Strict rules:\n" +
    "- One click only. NEVER click again to retry — that would corrupt the verdict.\n" +
    "- NEVER recover state (don't press Escape, don't dismiss popups). The caller handles recovery after your verdict.\n" +
    "- If you observe ambiguous results, commit ok=false with a clear reason — better to keep an element pending than mark it verified incorrectly.";

  const userPrompt = `Verify whether clicking on "${opts.elementKey}" at (${opts.coord.x}, ${opts.coord.y}) produces the expected behavior.`;

  const maxTurns = opts.maxTurns ?? 15;
  let turnsUsed = 0;

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: "claude-opus-4-7",
        systemPrompt,
        mcpServers: {
          verify: verdictMcp,
          playwright: playwrightMcp,
        },
        maxTurns,
        effort: "high",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        abortController: opts.abortSignal
          ? Object.assign(new AbortController(), { signal: opts.abortSignal })
          : undefined,
      },
    })) {
      if (msg.type === "assistant") turnsUsed++;
      if (verdict) break;
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      turnsUsed,
    };
  }

  if (!verdict) {
    return {
      ok: false,
      reason: `agent did not commit a verdict (turns=${turnsUsed}, maxTurns=${maxTurns})`,
      turnsUsed,
    };
  }
  return {
    ok: (verdict as { ok: boolean; reason: string }).ok,
    reason: (verdict as { ok: boolean; reason: string }).reason,
    turnsUsed,
  };
}
