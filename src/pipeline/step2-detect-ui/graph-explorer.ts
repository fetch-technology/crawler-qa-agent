// AI: called only during cold-start. Recursively explores UI states — DFS from
// main play screen, opening every clickable element, hashing each state, and
// recursing into new states. Result: a complete UI navigation graph + element
// registry that allows replay of ANY scenario via deterministic clicks.
//
// Safety: only clicks elements in the whitelist (see safe-click.ts). Spin,
// confirm-purchase, start-autoplay, gamble are NEVER clicked during discovery.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { snapshot, waitUntilStable } from "../utils/pixel-diff/index.js";
import type { UiElement, UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";
import type { UiGraph, UiGraphState } from "../registry/ui-graph-store.js";
import { classifyState, nextStateId, STATE_SAME_THRESHOLD } from "./state-hash.js";
import { isSafeToClickForDiscovery, explainSafety } from "./safe-click.js";
import { navigateBackTo } from "./navigate-back.js";

export type ExplorerOptions = {
  maxDepth?: number;        // default 3
  maxAiCalls?: number;      // default 25
  maxStates?: number;       // default 15
};

export type ExploreResult = {
  graph: UiGraph;
  registry: UiRegistry;
  warnings: string[];
};

const DEFAULT_OPTS: Required<ExplorerOptions> = {
  maxDepth: 3,
  maxAiCalls: 25,
  maxStates: 15,
};

const SYSTEM_PROMPT =
  "You are a slot-game UI locator. Look at the screenshot and return JSON listing every clickable button/control you can see with pixel coordinates. Return ONLY JSON, no prose.";

const USER_PROMPT_BASE = `Identify every clickable UI element visible in this screenshot.

Return JSON in this shape:
{
  "stateLabel": "short_kebab_case_label_for_this_screen",  // e.g. "main", "menu", "history_popup", "paytable_page1"
  "elements": [
    { "key": "kebab-case-key", "x": int, "y": int, "confidence": 0..1, "role": "spin|menu|close|prev|next|tab|toggle|setting|action|other" }
  ]
}

Rules:
- Only include things you can SEE.
- Use semantic keys ("closeButton", "prevPageButton", "soundToggle", "rulesButton"). Avoid generic "button1".
- stateLabel describes the WHOLE screen, not individual elements.
- Coordinates are CSS pixels from top-left.
- Confidence reflects how certain you are about the click target.

JSON only.`;

export async function exploreUiGraph(
  page: Page,
  gameSlug: string,
  initialRegistry: UiRegistry,
  opts: ExplorerOptions = {},
): Promise<ExploreResult> {
  const o = { ...DEFAULT_OPTS, ...opts };
  const startTs = Date.now();
  const warnings: string[] = [];
  const debugDir = path.join(dirForGame(gameSlug), "graph");
  await mkdir(debugDir, { recursive: true });

  // State knowledge
  type KnownState = { id: string; baseline: PNG; elements: Map<string, UiElement>; close: string | null };
  const stateIds = new Set<string>();
  const knownStates: KnownState[] = [];
  const transitions: Array<{ from: string; via: string; to: string }> = [];
  let aiCallsUsed = 0;

  // Build initial state "main" from the supplied registry (already discovered).
  const mainPng = await snapshot(page);
  const mainBaseline = path.join(debugDir, "main.png");
  await writeFile(mainBaseline, PNG.sync.write(mainPng));
  const mainElements = new Map<string, UiElement>();
  for (const [key, el] of Object.entries(initialRegistry)) {
    if (el) mainElements.set(key, el);
  }
  knownStates.push({ id: "main", baseline: mainPng, elements: mainElements, close: null });
  stateIds.add("main");

  // DFS frontier — tuples (parentState, depth)
  type Frame = { stateId: string; depth: number };
  const visited = new Set<string>(); // state IDs we have explored from
  const frontier: Frame[] = [{ stateId: "main", depth: 0 }];

  while (frontier.length > 0) {
    const frame = frontier.shift()!;
    if (visited.has(frame.stateId)) continue;
    if (knownStates.length > o.maxStates) {
      warnings.push(`max-states (${o.maxStates}) reached; stopping exploration`);
      break;
    }
    if (aiCallsUsed >= o.maxAiCalls) {
      warnings.push(`max-ai-calls (${o.maxAiCalls}) reached; stopping`);
      break;
    }
    visited.add(frame.stateId);
    const state = knownStates.find((s) => s.id === frame.stateId);
    if (!state) continue;

    // Make sure we're actually in this state.
    if (frame.stateId !== "main") {
      const current = await snapshot(page);
      const cls = classifyState(current, knownStates.map((s) => ({ id: s.id, baseline: s.baseline })));
      if (cls.kind !== "match" || cls.stateId !== frame.stateId) {
        // We need to navigate to this state first. Find parent transition.
        const inboundTransition = transitions.find((t) => t.to === frame.stateId);
        if (!inboundTransition) {
          warnings.push(`cannot reach ${frame.stateId} — no inbound transition recorded`);
          continue;
        }
        const parent = knownStates.find((s) => s.id === inboundTransition.from);
        if (!parent) continue;
        // Best effort: navigate back to main, then to parent (only supports 1-level for now)
        await navigateBackTo(page, knownStates[0]!.baseline);
        await page.waitForTimeout(500);
        const triggerEl = parent.elements.get(inboundTransition.via);
        if (triggerEl) {
          await page.mouse.click(triggerEl.x, triggerEl.y);
          await waitUntilStable(page, { maxIterations: 8, changeThreshold: 0.005, consecutiveStable: 2 });
        }
      }
    }

    // Iterate all elements in this state — try opening each.
    const elementKeys = Array.from(state.elements.keys());
    for (const elKey of elementKeys) {
      if (!isSafeToClickForDiscovery(elKey)) {
        // skip — won't click destructive elements
        continue;
      }
      if (transitions.find((t) => t.from === frame.stateId && t.via === elKey)) {
        // already explored this edge
        continue;
      }
      const el = state.elements.get(elKey);
      if (!el) continue;

      // Snapshot before click
      const before = await snapshot(page);

      try {
        await page.mouse.click(el.x, el.y);
      } catch (err) {
        warnings.push(`click ${frame.stateId}/${elKey} threw: ${String(err)}`);
        continue;
      }
      await waitUntilStable(page, {
        maxIterations: 10,
        changeThreshold: 0.005,
        consecutiveStable: 2,
      });

      const after = await snapshot(page);
      const cls = classifyState(after, knownStates.map((s) => ({ id: s.id, baseline: s.baseline })));

      // No-op transition? (still on same state)
      if (cls.kind === "match" && cls.stateId === frame.stateId) {
        // Element doesn't change state — record self-loop transition for completeness.
        transitions.push({ from: frame.stateId, via: elKey, to: frame.stateId });
        continue;
      }

      // Match a known state? Record transition.
      if (cls.kind === "match") {
        transitions.push({ from: frame.stateId, via: elKey, to: cls.stateId });
        // Navigate back to current state.
        await navigateBackTo(page, state.baseline);
        continue;
      }

      // NEW state — needs AI discovery.
      if (aiCallsUsed >= o.maxAiCalls) {
        warnings.push(`hit max-ai-calls while at ${frame.stateId}/${elKey} → unrecorded new state`);
        await navigateBackTo(page, state.baseline);
        continue;
      }

      aiCallsUsed++;
      const newStateData = await aiDiscoverState(page, debugDir, aiCallsUsed);
      const newStateId = newStateData.label || nextStateId(stateIds);
      stateIds.add(newStateId);

      const newElements = new Map<string, UiElement>();
      for (const e of newStateData.elements) {
        // Namespace popup elements with their state id.
        const namespacedKey = `${newStateId}__${e.key}`;
        newElements.set(namespacedKey, {
          x: e.x,
          y: e.y,
          strategy: "ai_vision",
          confidence: e.confidence ?? 0.8,
          detectedAt: new Date().toISOString(),
        });
      }

      const baselinePath = path.join(debugDir, `${newStateId}.png`);
      await writeFile(baselinePath, PNG.sync.write(after));

      knownStates.push({ id: newStateId, baseline: after, elements: newElements, close: null });
      transitions.push({ from: frame.stateId, via: elKey, to: newStateId });

      if (frame.depth + 1 < o.maxDepth) {
        frontier.push({ stateId: newStateId, depth: frame.depth + 1 });
      }

      // Navigate back to parent state before next element.
      await navigateBackTo(page, state.baseline);
      await waitUntilStable(page, { maxIterations: 6, changeThreshold: 0.005, consecutiveStable: 2 });
    }
  }

  // Build final UiGraph + merged registry.
  const states: Record<string, UiGraphState> = {};
  const mergedRegistry: UiRegistry = { ...initialRegistry };

  for (const s of knownStates) {
    const stateTransitions: Record<string, string> = {};
    for (const t of transitions.filter((x) => x.from === s.id)) {
      stateTransitions[t.via] = t.to;
    }
    states[s.id] = {
      id: s.id,
      description: null,
      baselineImage: path.relative(dirForGame(gameSlug), path.join(debugDir, `${s.id}.png`)),
      elements: Array.from(s.elements.keys()),
      transitions: stateTransitions,
    };
    // Save namespaced elements into merged registry.
    for (const [key, el] of s.elements) {
      if (s.id === "main") continue; // already in initial registry
      (mergedRegistry as Record<string, UiElement | undefined>)[key] = el;
    }
  }

  const graph: UiGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    initialState: "main",
    states,
    exploration: {
      aiCallsUsed,
      statesDiscovered: knownStates.length,
      transitionsRecorded: transitions.length,
      elapsedMs: Date.now() - startTs,
    },
  };

  return { graph, registry: mergedRegistry, warnings };
}

export async function aiDiscoverState(
  page: Page,
  debugDir: string,
  callIdx: number,
  /** Optional override of the user prompt — used by manual-session to add
   *  popup-focus instructions for sub-state discovery. */
  userPromptOverride?: string,
): Promise<{ label: string | null; elements: Array<{ key: string; x: number; y: number; confidence?: number; role?: string }> }> {
  const buf = await page.screenshot({ type: "png" });
  const debugPath = path.join(debugDir, `state-${callIdx}-${Date.now()}.png`);
  await writeFile(debugPath, buf);
  try {
    const text = await askClaude({
      label: `step2/graph/${callIdx}`,
      system: SYSTEM_PROMPT,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
        { type: "text", text: userPromptOverride ?? USER_PROMPT_BASE },
      ],
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    const parsed = extractJsonFromText<{ stateLabel?: string; elements?: Array<Record<string, unknown>> }>(text);
    if (!parsed || !Array.isArray(parsed.elements)) return { label: null, elements: [] };
    const elements: Array<{ key: string; x: number; y: number; confidence?: number; role?: string }> = [];
    for (const e of parsed.elements) {
      const key = typeof e.key === "string" ? e.key : null;
      const x = typeof e.x === "number" ? e.x : null;
      const y = typeof e.y === "number" ? e.y : null;
      if (key && x !== null && y !== null && x > 0 && y > 0) {
        elements.push({
          key,
          x,
          y,
          confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
          role: typeof e.role === "string" ? e.role : undefined,
        });
      }
    }
    return { label: typeof parsed.stateLabel === "string" ? parsed.stateLabel : null, elements };
  } catch (err) {
    return { label: null, elements: [] };
  }
}

// Expose explain helper for diagnostics.
export { explainSafety, STATE_SAME_THRESHOLD };
