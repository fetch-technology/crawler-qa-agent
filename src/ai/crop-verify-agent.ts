// AI: stateful crop-verify locator — Claude Agent SDK with conversation memory.
//
// FULL match to the canvas-click skill from logic-data-crawler-creator:
//   - Browser tools come from Playwright MCP (browser_take_screenshot,
//     browser_run_code, browser_mouse_click) — NOT custom tools.
//   - JS math for bbox adjustments REQUIRED via browser_run_code — agent never
//     does mental arithmetic (canvas-click rule).
//   - Skill loader pattern: agent calls `skill_canvas-click` FIRST to load
//     instructions, then follows them.
//   - CDP attach: Playwright MCP connects to the SAME browser instance the
//     manual-session has open (via cdpEndpoint), so the agent operates on the
//     EXACT page QA is viewing — no separate browser spawn, no state drift.
//
// One agent invocation per element. The conversation is stateful — every
// screenshot, crop, and adjustment is in the message history, so the agent
// learns from prior attempts (the fix for the stateless-locator's ping-pong).

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "module";
import path from "path";
import { z } from "zod";

export type AgentLocateResult = {
  ok: boolean;
  x?: number;
  y?: number;
  reason?: string;
  turnsUsed?: number;
};

// Resolve @playwright/mcp's CLI from local node_modules (matches the original
// repo's pattern — avoid `npx @latest` drift between install + runtime).
const playwrightMcpCliPath = (() => {
  const requireFn = createRequire(import.meta.url);
  const pkgPath = requireFn.resolve("@playwright/mcp/package.json");
  return path.join(path.dirname(pkgPath), "cli.js");
})();

// canvas-click.md adapted from logic-data-crawler-creator — loaded lazily
// when the agent calls `skill_canvas-click`. Differences from upstream:
//  • Agent IS allowed to call `browser_mouse_click` after crop-verify to
//    confirm the button responds — that observation is what made the upstream
//    locator reliable (it saw popups open / signals fire and could refine if
//    the click missed). Our caller still records the final coord via
//    `commit_click` after the agent confirms it works.
//  • Math uses `browser_evaluate` (page-side JS) per upstream — NOT
//    `browser_run_code` (Node-side), since the upstream pattern is the one
//    proven to produce stable arithmetic without prompt confusion.
const canvasClickSkillDescription =
  "Click a button in a canvas game. MANDATORY for ANY click on a canvas element. Canvas games have no DOM buttons — you must screenshot, detect position, crop to verify, then click.";

const CANVAS_CLICK_INSTRUCTIONS = `# Canvas Click Skill

## Why this exists

Canvas games render all UI as pixels on one canvas element. There are no child DOM nodes. browser_click with a CSS selector hits the canvas center — not the button. This skill detects the exact button position from a whole website screenshot, verifies it by cropping, mouse-clicks to confirm the button responds, then commits the verified coordinate so the caller can record it.

## When to use

MANDATORY for ANY click on a canvas element. Canvas games have no DOM buttons — you must screenshot the whole website, detect the button position from the screenshot, crop to verify, mouse click to confirm a response, then commit the click center.

## Procedure

### Step 1: Screenshot the whole website

Call browser_take_screenshot to capture the full page.

View the screenshot to find the target button. The canvas is only a part of the website — identify the button within the page.

### Step 2: Estimate the clickable button bounds

From the screenshot, estimate the button's bounding box in screenshot coordinates (pixels from top-left of the image):

- x — left edge
- y — top edge
- w — width
- h — height

The clickable area is the visible button shape — not surrounding decoration, glow, or shadow.

### Step 3: Crop and verify (loop up to 10 times)

Crop the button area using browser_run_code with Playwright's page.screenshot clip option:

async (page) => {
  await page.screenshot({
    path: 'crop-button.png',
    clip: { x: X_VALUE, y: Y_VALUE, width: W_VALUE, height: H_VALUE }
  });
  return 'cropped button';
}

View the cropped image to verify.

The crop must satisfy ALL of these:

1. Correct button — this is the button the user wants to click.
2. Fully captured — entire clickable button is inside the crop, no edges cut off.
3. Button centered — the button must sit AT or NEAR the center of the crop (roughly equal padding on left/right and top/bottom). The center of this crop becomes the click target, so any off-center padding shifts the click away from the button.

If the crop fails ANY of these, adjust the screenshot coordinates and crop again. State what changed:
> Attempt #2: Button cut off on the right, expanding w from 120 to 150. Or Move up 20 pixels by changing y from 300 to 280. Or move right 30 pixels by changing x from 500 to 530. Or Button sits in the left half of the crop (more empty space on the right), decreasing x by 20 (e.g. from 500 to 480) to shift the crop left and recenter.

### Step 3a: Move / resize the crop with JavaScript math

NEVER do mental math when shifting the crop. ALWAYS compute the next \`{x, y, w, h}\` via browser_evaluate using the current values, then plug the result into Step 3's clip.

Coordinate system reminder (screenshot space, top-left origin):

- LEFT  → decrease x
- RIGHT → increase x
- UP    → decrease y
- DOWN  → increase y
- WIDER  / NARROWER → increase / decrease w
- TALLER / SHORTER  → increase / decrease h

When you move the crop without resizing, shift x or y by the SAME amount you want the view to move. When you resize from one edge only, you must adjust BOTH the position and the size so the opposite edge stays put — otherwise the whole crop drifts.

Use this single recipe for every adjustment. Set the deltas you want and pass zero for the rest:

(() => {
  // Current crop
  const x = X_VALUE, y = Y_VALUE, w = W_VALUE, h = H_VALUE;

  // Movement (positive = right / down, negative = left / up)
  const dx = 0;   // e.g. +30 to move right 30px, -20 to move left 20px
  const dy = 0;   // e.g. -20 to move up 20px, +40 to move down 40px

  // Edge expansion in pixels (positive = grow outward, negative = shrink inward)
  const expandLeft   = 0;
  const expandRight  = 0;
  const expandTop    = 0;
  const expandBottom = 0;

  const nx = x + dx - expandLeft;
  const ny = y + dy - expandTop;
  const nw = w + expandLeft + expandRight;
  const nh = h + expandTop + expandBottom;

  return { x: nx, y: ny, w: nw, h: nh };
})()

Worked examples (state which one you are doing before calling browser_evaluate):

- Move right 30px:                 dx = +30
- Move left 30px:                  dx = -30
- Move up 20px:                    dy = -20
- Move down 20px:                  dy = +20
- Button cut off on the right by ~25px → expand right edge: expandRight  = 25
- Button cut off on the left  by ~25px → expand left  edge: expandLeft   = 25
- Button cut off on top by ~15px       → expand top   edge: expandTop    = 15
- Crop too loose on the bottom by 40px → shrink bottom edge: expandBottom = -40
- Recenter: move right 10 AND up 5: dx = +10, dy = -5

After browser_evaluate returns the new \`{x, y, w, h}\`, go back to Step 3 and re-crop with those values.

### Step 3b: Recenter the button inside the crop

Before computing the click target, confirm the button is centered in the verified crop. Estimate the padding (empty space) on each side of the button inside the crop:

Intuition: the crop window has to chase the button. Wherever there is MORE empty space, that side of the crop is "wasted" — shift the whole crop TOWARD that empty side so its opposite edge pulls back toward the button.

- More empty space on the RIGHT of the button (button sits in left half) → shift crop LEFT  (dx = -(rightPad - leftPad) / 2)
- More empty space on the LEFT  of the button (button sits in right half) → shift crop RIGHT (dx = +(leftPad - rightPad) / 2)
- More empty space BELOW the button (button sits in top half)    → shift crop UP   (dy = -(bottomPad - topPad) / 2)
- More empty space ABOVE the button (button sits in bottom half) → shift crop DOWN (dy = +(topPad - bottomPad) / 2)

Ignore differences under ~10px — they will not meaningfully shift the click.

Apply the shift via Step 3a's recipe (movement only, no resize), re-crop, and verify the button now sits at or near the center. Only proceed to Step 4 once the button is centered — otherwise the computed center will miss the button.

### Step 4: Calculate center, click to verify, then commit

Calculate the center of the verified, centered bounding box via browser_evaluate:

(() => {
  const x = X_VALUE, y = Y_VALUE, w = W_VALUE, h = H_VALUE;
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
})()

Now CONFIRM the coord works:
1. Take a screenshot via browser_take_screenshot — note the current screen state.
2. Click via browser_mouse_click(x, y) at the computed center.
3. Wait ~2 seconds for the game to respond (Playwright's auto-wait is enough; you may also re-screenshot).
4. Take another screenshot via browser_take_screenshot.
5. Compare against the EXPECTED RESPONSE in your target description. The response must MATCH WHAT THE TARGET BUTTON SHOULD DO — not just any change on screen.

   CRITICAL: a screen change ALONE is not success. Examples:
   - Looking for AUTOPLAY button but reels start spinning → you hit the SPIN button. Click missed. Refine.
   - Looking for BET PLUS but the autoplay popup opens → you hit the autoplay button. Click missed.
   - Looking for PAYTABLE but the buy-bonus confirmation appears → you hit the buy button. Click missed.
   - Looking for AUTOPLAY and a popup opens with "Number of spins" / "Stop after" options → CORRECT. Commit.
   - Looking for BET PLUS and the bet readout increases by one step → CORRECT. Commit.

   If the observed response does NOT match the expected response described for your target, the click missed — go back to Step 3 with a refined crop. Do NOT commit a coord that produced the wrong behavior.

Once the click is CONFIRMED (response matches the EXPECTED RESPONSE in your target description), call commit_click(x, y) with the verified center coords. THIS ENDS THE TASK.

If the click was correct AND opened a popup/overlay, you may dismiss it (press Escape or click a close button) before committing — but committing is the ONLY required final step.

## Rules

- NEVER skip crop verification on the FIRST attempt — even if you think you see the button clearly.
- ALL coordinate math MUST use JavaScript via browser_evaluate — no mental math. This includes shifting/resizing the crop between attempts (Step 3a), not just the final center (Step 4).
- All coordinates are in screenshot space — same space the mouse click uses.
- Max 10 crop attempts before reporting failure.
- You MUST click to verify (Step 4) before committing. A coord without observation is worthless to the caller. If you click and see NO response, the click missed — refine and try again.
- If the button is NOT on the current screen (not visible at all, not just off-center), reply with the exact text "BUTTON NOT FOUND" and do NOT call commit_click.
`;

export async function cropVerifyAgent(opts: {
  description: string;
  label: string;
  cdpEndpoint: string;
  maxTurns?: number;
  /** Where Playwright MCP writes browser_take_screenshot output. Caller
   *  typically passes `fixtures/registry/<gameSlug>/debug-agent/` so debug
   *  PNGs land in a per-game folder instead of the repo root. */
  outputDir?: string;
  abortSignal?: AbortSignal;
}): Promise<AgentLocateResult> {
  let finalClick: { x: number; y: number } | null = null;
  let buttonNotFound = false;

  // Custom MCP server with the skill loader + the commit endpoint. Browser
  // primitives come from Playwright MCP (next).
  const skillsMcp = createSdkMcpServer({
    name: "skills",
    version: "1.0.0",
    tools: [
      tool(
        "skill_canvas-click",
        `Load the "canvas-click" skill. ${canvasClickSkillDescription}. Call this tool to get the full instructions before proceeding.`,
        {},
        async () => ({
          content: [{ type: "text" as const, text: CANVAS_CLICK_INSTRUCTIONS }],
        }),
      ),
      tool(
        "commit_click",
        "Commit the final click center coordinate. ONLY call AFTER you have crop-verified the button AND clicked it via browser_mouse_click to confirm the game responded (popup opened / button reacted). The caller records this coord for later re-use. This ends the task.",
        {
          x: z.number().int().describe("Final click x in screenshot pixels."),
          y: z.number().int().describe("Final click y in screenshot pixels."),
        },
        async (input) => {
          finalClick = { x: input.x as number, y: input.y as number };
          return { content: [{ type: "text" as const, text: `committed click at (${finalClick.x}, ${finalClick.y}) — task complete` }] };
        },
      ),
    ],
  });

  // Playwright MCP via stdio + CDP attach to the manual-session browser.
  // The agent sees the EXACT page QA is viewing — no separate spawn.
  const playwrightMcp = {
    type: "stdio" as const,
    command: "node",
    args: [
      playwrightMcpCliPath,
      "--browser=chromium",
      "--cdp-endpoint",
      opts.cdpEndpoint,
      // Reuse the connected browser's existing context — DON'T spin up an
      // isolated profile, otherwise MCP creates a new page and we lose sync
      // with manual-session's actual page.
      "--shared-browser-context",
      ...(opts.outputDir ? ["--output-dir", opts.outputDir] : []),
    ],
  };

  const systemPrompt =
    `You are a precise locator agent for a slot-game UI button. ` +
    `The browser is ALREADY connected to the user's session via CDP — the game page is open. DO NOT navigate; just operate on the existing page.\n\n` +
    `Your first action MUST be to call \`skill_canvas-click\` to load the procedure. Then follow it strictly.\n\n` +
    `Target button: ${opts.description}\n\n` +
    `Follow the skill exactly: crop-verify the button, then click via \`browser_mouse_click\` to confirm it responds, then call \`commit_click(x, y)\` to record the verified center. If the button is not visible on the current screen, reply "BUTTON NOT FOUND" and stop.\n\n` +
    `Available skills (call the corresponding tool to load instructions):\n` +
    `- canvas-click: ${canvasClickSkillDescription}`;

  const userPrompt = `Locate this button: "${opts.description}". Start by calling skill_canvas-click for instructions.`;

  // Match upstream (logic-data-crawler-creator) — empirically tuned for canvas
  // vision: Opus 4.7 latest, high effort for stable spatial reasoning, ample
  // turns so the agent can iterate (typically 15-50 per element), empty
  // settingSources so user-level CLAUDE.md doesn't bleed into the prompt, and
  // bypassPermissions because every tool call is sandboxed inside our MCP.
  const maxTurns = opts.maxTurns ?? 400;
  let turnsUsed = 0;
  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: "claude-opus-4-7",
        systemPrompt,
        mcpServers: {
          skills: skillsMcp,
          playwright: playwrightMcp,
        },
        maxTurns,
        effort: "high",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        // Allow the FULL Playwright MCP toolset — the skill assumes
        // browser_evaluate (math), browser_take_screenshot (verification), and
        // browser_mouse_click (the actual click + observation step) are all
        // available. Restricting these previously left the agent unable to
        // verify its own work → it returned guesses, often drifting onto
        // adjacent buttons. Custom skills tools remain available too.
        abortController: opts.abortSignal ? Object.assign(new AbortController(), { signal: opts.abortSignal }) : undefined,
      },
    })) {
      if (msg.type === "assistant") {
        turnsUsed++;
        const blocks = ((msg as { message?: { content?: unknown } }).message?.content as unknown);
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
              const text = ((b as { text?: string }).text ?? "").toUpperCase();
              if (text.includes("BUTTON NOT FOUND")) buttonNotFound = true;
            }
          }
        }
      }
      if (finalClick || buttonNotFound) break;
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), turnsUsed };
  }

  if (buttonNotFound) {
    return { ok: false, reason: "agent reported BUTTON NOT FOUND on the current screen", turnsUsed };
  }
  if (!finalClick) {
    return { ok: false, reason: `agent did not commit a coord (turns=${turnsUsed}, maxTurns=${maxTurns})`, turnsUsed };
  }
  return { ok: true, x: finalClick.x, y: finalClick.y, turnsUsed };
}
