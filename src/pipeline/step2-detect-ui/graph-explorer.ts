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
import { saveDiscoverySnapshot } from "../registry/discovery-snapshots.js";
import { filterMainOverlap, buildMainElementsHint } from "./popup-filter.js";
import type { UiGraph, UiGraphState } from "../registry/ui-graph-store.js";
import { classifyState, nextStateId, STATE_SAME_THRESHOLD } from "./state-hash.js";
import { isSafeToClickForDiscovery, explainSafety } from "./safe-click.js";
import { navigateBackTo } from "./navigate-back.js";

export type ExplorerOptions = {
  maxDepth?: number;        // default 3
  maxAiCalls?: number;      // default 25
  maxStates?: number;       // default 15
  /** Per-trigger extra prompt appended to the popup-discovery AI call when
   *  exploration enters a NEW state via that trigger key. Use to pin labeling
   *  conventions for known popups whose contents are predictable (e.g. bet
   *  selector → use exact gameSpec.betLadder values, not AI-guessed labels).
   *  Keyed by the parent-frame trigger element key (e.g. "betPlus"). */
  triggerHints?: Record<string, string>;
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
  triggerHints: {},
};

type Transition = { from: string; via: string; to: string };

/**
 * Add aliased copies of every namespaced element under a new trigger's
 * namespace. Used when a state is reached via multiple triggers (e.g. both
 * betPlus and betMinus open the same bet-selector popup) — without aliasing,
 * only the first trigger's namespace gets populated children, and probe +
 * dashboard see an empty tree under the second trigger. Mutates `elements`
 * in place; returns the number of aliases added (existing entries with the
 * target key are skipped, never overwritten).
 *
 * The aliasing strips ONE level of namespace prefix from each existing key
 * and replaces it with `${newTrigger}__`. So "betPlus__bet-0.20" under new
 * trigger "betMinus" becomes "betMinus__bet-0.20"; "autoButton__lossLimit"
 * under "soundToggle" becomes "soundToggle__lossLimit". Top-level keys
 * (no "__" separator) are skipped — they live on main, not under any
 * popup-trigger namespace.
 */
export function aliasElementsForNewTrigger(
  elements: Map<string, UiElement>,
  newTrigger: string,
): number {
  if (!newTrigger || elements.size === 0) return 0;
  const newPrefix = `${newTrigger}__`;
  let aliased = 0;
  for (const [existingKey, existingEl] of Array.from(elements)) {
    const parts = existingKey.split("__");
    if (parts.length < 2) continue; // top-level main key
    const tail = parts.slice(1).join("__");
    const aliasedKey = newPrefix + tail;
    if (elements.has(aliasedKey)) continue;
    elements.set(aliasedKey, { ...existingEl });
    aliased++;
  }
  return aliased;
}

/**
 * BFS in the discovered transition graph: returns the sequence of clicks
 * (transitions) needed to navigate from "main" to `target`. Returns [] when
 * target is "main", null when unreachable.
 *
 * Replaces the previous "1-level only" navigation (single inbound transition
 * click) — required to reach states at depth ≥ 2 (e.g. paytable_page1 →
 * paytable_page2 → paytable_page3). Without this, the explorer could see
 * level-2/3 elements via the AI vision pass but could never re-enter the
 * state to iterate them → depth-3 frames silently failed every navigation
 * and the frontier drained without firing further AI calls.
 */
export function findPathFromMain(
  transitions: ReadonlyArray<Transition>,
  target: string,
): Transition[] | null {
  if (target === "main") return [];
  type Item = { state: string; path: Transition[] };
  const queue: Item[] = [{ state: "main", path: [] }];
  const visited = new Set<string>(["main"]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const t of transitions) {
      if (t.from !== cur.state) continue;
      if (visited.has(t.to)) continue;
      const newPath = [...cur.path, t];
      if (t.to === target) return newPath;
      visited.add(t.to);
      queue.push({ state: t.to, path: newPath });
    }
  }
  return null;
}

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

  // Persist a "main" discovery snapshot for the dashboard's visual review
  // panel. Best-effort — explorer should not bail on snapshot I/O errors.
  try {
    await saveDiscoverySnapshot(
      gameSlug,
      "main",
      PNG.sync.write(mainPng),
      Array.from(mainElements.entries()).map(([key, el]) => ({
        key, x: el.x, y: el.y, confidence: el.confidence,
      })),
      "explore-graph-main",
      { width: mainPng.width, height: mainPng.height },
    );
  } catch (err) {
    warnings.push(`failed to save main snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }

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

    // Make sure we're actually in this state. Multi-level navigation
    // (2026-06-01): BFS the transition graph from "main" to the target,
    // then replay each click in sequence. The previous "click the single
    // inbound transition" path only reached depth 1 — clicking a level-2
    // popup's trigger key while standing on main would miss the button
    // entirely (level-2 triggers exist only when the level-1 popup is
    // open). Now we click level-1 trigger → level-2 trigger → … in order
    // so frames at any depth resolve correctly.
    if (frame.stateId !== "main") {
      const current = await snapshot(page);
      const cls = classifyState(current, knownStates.map((s) => ({ id: s.id, baseline: s.baseline })));
      if (cls.kind !== "match" || cls.stateId !== frame.stateId) {
        const path = findPathFromMain(transitions, frame.stateId);
        if (!path) {
          warnings.push(`cannot reach ${frame.stateId} — no path from main in transition graph`);
          continue;
        }
        await navigateBackTo(page, knownStates[0]!.baseline);
        await page.waitForTimeout(500);
        let navFailed = false;
        for (const step of path) {
          const stepParent = knownStates.find((s) => s.id === step.from);
          const triggerEl = stepParent?.elements.get(step.via);
          if (!triggerEl) {
            warnings.push(`broken nav: ${step.from}/${step.via} not in parent state's elements`);
            navFailed = true;
            break;
          }
          try {
            await page.mouse.click(triggerEl.x, triggerEl.y);
          } catch (err) {
            warnings.push(`nav click failed at ${step.from}/${step.via}: ${String(err)}`);
            navFailed = true;
            break;
          }
          await waitUntilStable(page, { maxIterations: 4, changeThreshold: 0.01, consecutiveStable: 2 });
        }
        if (navFailed) continue;
        if (path.length > 1) {
          console.log(`[explorer/nav] reached ${frame.stateId} via ${path.length}-step path: ${path.map((p) => `${p.from}→${p.via}→${p.to}`).join(" → ")}`);
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

      // Click with offset retry to absorb the ~5-15px coord drift typical of
      // AI-vision bboxes on canvas-rendered slots. Probe uses the same
      // OFFSETS pattern (element-probe.ts); explorer used to single-click,
      // which meant a coord 8px off the hot zone silently self-looped
      // (observed 2026-05-31: autoButton at (995,703) — actual hit zone
      // (995,711) — explorer self-looped on every click, never opened the
      // autoplay popup, AI was never invoked → exploration stopped at depth 0
      // even though the rest of the pipeline verified autoButton fine).
      //
      // Logic: try center first; if state hash is unchanged (no popup),
      // try 8px in each cardinal direction. First offset that produces a
      // state change wins. All-offsets-no-op → genuine self-loop.
      const clickOffsets: ReadonlyArray<{ dx: number; dy: number }> = [
        { dx: 0, dy: 0 },
        { dx: -8, dy: 0 }, { dx: 8, dy: 0 },
        { dx: 0, dy: -8 }, { dx: 0, dy: 8 },
      ];
      let after: PNG | null = null;
      let cls: ReturnType<typeof classifyState> | null = null;
      let usedOffset = { dx: 0, dy: 0 };
      // New-tab detection: some games (esp. external "Game History" services)
      // open the popup as a separate browser tab via window.open(). Without
      // listening, the original page's screenshot stays unchanged →
      // classifyState reports "same state" → explorer marks self-loop and
      // skips. Set up a one-shot listener BEFORE clicking; capture the new
      // Page if one fires. Processed after the offset loop.
      // Use a 1-slot array so TypeScript's flow analysis doesn't narrow
      // `externalPage` to `never` based on the callback-only assignment.
      const externalPageSlot: Array<import("playwright").Page> = [];
      const ctx = page.context();
      const onNewPage = (p: import("playwright").Page): void => {
        if (externalPageSlot.length === 0) externalPageSlot.push(p);
      };
      ctx.on("page", onNewPage);
      try {
        for (const off of clickOffsets) {
          const cx = Math.round(el.x + off.dx);
          const cy = Math.round(el.y + off.dy);
          try {
            await page.mouse.click(cx, cy);
          } catch (err) {
            if (off.dx === 0 && off.dy === 0) {
              warnings.push(`click ${frame.stateId}/${elKey} threw: ${String(err)}`);
            }
            continue;
          }
          // Per-click settle — typically 1-3 frames suffice once the popup
          // animation is complete. Was 10 (heavy flicker in headed mode); cut to
          // 5 saves ~5 screenshots per safe-click without missing slow popups.
          await waitUntilStable(page, {
            maxIterations: 5,
            changeThreshold: 0.01,
            consecutiveStable: 2,
          });
          // Give the context's "page" event a beat to fire — new-page event
          // is async after click. If a tab opened, abort offset retry (don't
          // open a SECOND tab on the next offset).
          await page.waitForTimeout(300);
          if (externalPageSlot[0]) {
            // Wait for DOM ready so AI discover has content to see. Bounded
            // — some history pages are slow to load.
            await externalPageSlot[0].waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
            // Take screenshot of the NEW page (not the original). This is the
            // "after" state image — used both for state hashing and saved as
            // the baseline image. Note: classifyState compares against known
            // states; external page hashes will almost always differ → treated
            // as a brand new state below.
            after = await snapshot(externalPageSlot[0]);
            cls = classifyState(after, knownStates.map((s) => ({ id: s.id, baseline: s.baseline })));
            usedOffset = off;
            console.log(`[explorer/external-tab] ${frame.stateId}/${elKey} opened a new browser tab — discovering its contents`);
            break;
          }
          const a = await snapshot(page);
          const c = classifyState(a, knownStates.map((s) => ({ id: s.id, baseline: s.baseline })));
          if (c.kind === "match" && c.stateId === frame.stateId) {
            // Still on the same state — this offset missed. Try next.
            continue;
          }
          // State changed (new or matches another known state) — use this click.
          after = a;
          cls = c;
          usedOffset = off;
          break;
        }
      } finally {
        ctx.off("page", onNewPage);
      }

      if (!after || !cls) {
        // Every offset produced a self-loop → element genuinely doesn't change
        // state, OR all offsets missed the hot zone (rare with ±15px coverage).
        transitions.push({ from: frame.stateId, via: elKey, to: frame.stateId });
        continue;
      }
      if (usedOffset.dx !== 0 || usedOffset.dy !== 0) {
        // Record the working offset so QA can see which clicks needed
        // refinement (and future probe can pre-apply the offset).
        console.log(`[explorer] ${frame.stateId}/${elKey} opened state via offset (${usedOffset.dx},${usedOffset.dy})`);
      }

      // No-op transition? (still on same state)
      if (cls.kind === "match" && cls.stateId === frame.stateId) {
        // Element doesn't change state — record self-loop transition for completeness.
        transitions.push({ from: frame.stateId, via: elKey, to: frame.stateId });
        continue;
      }

      // Match a known state? Record transition.
      if (cls.kind === "match") {
        transitions.push({ from: frame.stateId, via: elKey, to: cls.stateId });
        // External tab opened but matches a state we already know (rare —
        // e.g. external history page visited twice via different triggers).
        // Close the dup tab so we don't accumulate handles.
        if (externalPageSlot[0]) {
          try { await externalPageSlot[0].close(); } catch { /* tab already closed */ }
        }
        // Trigger alias (2026-06-01): a popup can be reached via multiple
        // triggers — e.g. betPlus AND betMinus both open the same bet
        // selector popup in PP slots. The FIRST trigger to discover the
        // popup gets all its children namespaced under `firstTrigger__*`;
        // subsequent triggers that match the same state record the
        // transition but their namespace stays empty → dashboard tree
        // shows betPlus__bet-0.20 but not betMinus__bet-0.20 even though
        // both click paths land in identical UI (observed 2026-06-01 on
        // vswaysmahwin2: betPlus opened bet_multiplier_popup with 17
        // levels, betMinus matched the same state but `betMinus__*` had
        // no entries). Alias each child element under the new trigger's
        // namespace so probe + tree see both triggers as fully populated.
        // Restrict alias to MAIN-LEVEL triggers only (2026-06-01). Sub-state
        // clicks (e.g. clicking betPlus__bet-0.20 inside the bet selector
        // popup) frequently land you back in the SAME popup state with a
        // selection highlighted — classifyState sees a "match" to the popup
        // itself, but the click wasn't an alternate trigger to OPEN the
        // popup; it was an in-popup interaction. Aliasing under each bet
        // level then creates combinatorial bloat: 16 bet levels × 16 children
        // = 256 ghost entries, each demanding a sub-state probe at ~$0.50.
        //
        // Legitimate alias use case: TWO TOP-LEVEL triggers open the same
        // popup (betPlus AND betMinus → bet_selection_popup). Both clicks
        // originate from frame.stateId === "main", so the restriction below
        // keeps that case working while killing the bet-level explosion.
        if (frame.stateId === "main" && cls.stateId !== "main" && cls.stateId !== elKey) {
          const matchedState = knownStates.find((s) => s.id === cls.stateId);
          if (matchedState) {
            const aliased = aliasElementsForNewTrigger(matchedState.elements, elKey);
            if (aliased > 0) {
              console.log(`[explorer/alias] ${cls.stateId} reached via NEW trigger "${elKey}" — aliased ${aliased} elements under ${elKey}__*`);
            }
          }
        }
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
      // Tell AI explicitly which main controls live in the dimmed background
      // so it doesn't re-detect them as popup content. Falls back to default
      // prompt when no main entries (shouldn't happen during normal explore,
      // but defensive).
      const mainHint = buildMainElementsHint(initialRegistry as Record<string, { x: number; y: number } | undefined>);
      // Per-trigger extra hint (e.g. bet popup → use the exact bet ladder so
      // labels match real selectable values, not AI-interpolated guesses).
      const triggerHint = o.triggerHints[elKey] ?? "";
      const popupPrompt =
        (mainHint || triggerHint) ? USER_PROMPT_BASE + mainHint + (triggerHint ? "\n\n" + triggerHint : "") : undefined;
      // If a new tab opened, run AI discover on THAT page (its DOM has the
      // history/external content), not on the original game page (still
      // showing the main screen). The captured screenshot already used the
      // external page; aiDiscoverState screenshots again internally so we
      // pass externalPageSlot[0] too. Coords returned are external-page-relative —
      // case-executor would need to handle clicking in the new tab (out of
      // scope for v1; we just REGISTER the structure here).
      const discoverPage = externalPageSlot[0] ?? page;
      const newStateData = await aiDiscoverState(discoverPage, debugDir, aiCallsUsed, popupPrompt);
      // Label sanity: AI sometimes returns the existing state's label (e.g.
      // "main") for a freshly-discovered popup — observed 2026-05-31 when AI
      // saw a popup with subtle background and defaulted to "main" + 0
      // elements. classifyState already confirmed this is NOT the same as
      // any known state, so trust the hash over the AI's label: collisions
      // with existing state ids → fall back to an auto-generated id, never
      // create duplicate state entries that confuse the visited set.
      const rawLabel = (newStateData.label ?? "").trim().toLowerCase();
      let newStateId: string;
      if (rawLabel && !stateIds.has(rawLabel)) {
        newStateId = rawLabel;
      } else {
        const autoId = nextStateId(stateIds);
        if (rawLabel) {
          console.warn(`[explorer] AI returned colliding label "${rawLabel}" for ${frame.stateId}/${elKey} — using auto id "${autoId}"`);
        }
        newStateId = autoId;
      }
      stateIds.add(newStateId);

      // Drop main-screen false positives — AI sometimes flags main controls
      // visible through dimmed popup background. Filter against initialRegistry
      // (the canonical main keys; sub-state keys not affected).
      const filteredNew = filterMainOverlap(newStateData.elements, initialRegistry as Record<string, { x: number; y: number } | undefined>);
      console.log(`[explorer/filter] state ${newStateId} via ${elKey}: AI returned ${newStateData.elements.length}, kept ${filteredNew.kept.length}, dropped ${filteredNew.dropped.length} main-overlap`);
      if (filteredNew.dropped.length > 0) {
        const sample = filteredNew.dropped.map((d) => `  ${d.key}@(${d.x},${d.y}) → main "${d.overlapsMainKey}"`).join("\n");
        console.log(`[explorer/filter] dropped details:\n${sample}`);
        warnings.push(`state ${newStateId}: dropped ${filteredNew.dropped.length} main-overlap false positives`);
      }

      // Namespace popup elements by the TRIGGER KEY that opened this state
      // (matches `discoverSubState`'s convention so the dashboard tree groups
      // children under their trigger naturally — e.g. autoButton's popup
      // children are `autoButton__*`, not `autoplay_settings_popup__*`).
      const elementNamespace = elKey;
      const newElements = new Map<string, UiElement>();
      const isExternal = !!externalPageSlot[0];
      for (const e of filteredNew.kept) {
        const namespacedKey = `${elementNamespace}__${e.key}`;
        newElements.set(namespacedKey, {
          x: e.x,
          y: e.y,
          strategy: "ai_vision",
          confidence: e.confidence ?? 0.8,
          detectedAt: new Date().toISOString(),
          // Mark elements discovered on an external browser tab so the
          // case-executor knows to click on the captured tab page (not the
          // original game page). The PARENT trigger element keeps its
          // original coords on the game page — only the descendants live
          // in the external tab.
          ...(isExternal ? { externalPage: true } : {}),
        });
      }

      const baselinePath = path.join(debugDir, `${newStateId}.png`);
      await writeFile(baselinePath, PNG.sync.write(after));

      // Persist a discovery snapshot of the new state (PNG the AI saw +
      // labelled elements, NAMESPACED). Uses the TRIGGER KEY as stateId so it
      // matches the registry namespace (e.g. `autoButton.png`/`autoButton.json`).
      // The dashboard's Pick-on-Screenshot then maps a namespaced uiKey like
      // `autoButton__autospinsSlider` straight to this snapshot — QA picks on
      // the popup view without needing the live browser in that state.
      try {
        await saveDiscoverySnapshot(
          gameSlug,
          elementNamespace,
          newStateData.pngBuf,
          Array.from(newElements.entries()).map(([key, el]) => ({
            key, x: el.x, y: el.y, confidence: el.confidence,
          })),
          "explore-graph",
        );
      } catch (err) {
        warnings.push(`failed to save snapshot for ${newStateId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      knownStates.push({ id: newStateId, baseline: after, elements: newElements, close: null });
      transitions.push({ from: frame.stateId, via: elKey, to: newStateId });

      // Depth recursion: skip for external-tab states. Recursive exploration
      // of those would need to re-open the external tab + navigate path
      // tracking that crosses page boundaries — out of scope for v1.
      if (!externalPageSlot[0] && frame.depth + 1 < o.maxDepth) {
        frontier.push({ stateId: newStateId, depth: frame.depth + 1 });
      }

      if (externalPageSlot[0]) {
        // External tab path: original page is still on `frame.stateId`
        // (clicking the trigger opened a NEW tab, didn't navigate the
        // original). Close the new tab to avoid accumulating handles across
        // discovery. Skip navigateBackTo — original page didn't move.
        try {
          await externalPageSlot[0].close();
          console.log(`[explorer/external-tab] closed new tab opened by ${frame.stateId}/${elKey}`);
        } catch (err) {
          warnings.push(`failed to close external tab for ${elKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Same-page popup path: navigate back so next element starts from
        // the parent state's baseline (ESC / closeButton / route reload).
        await navigateBackTo(page, state.baseline);
        await waitUntilStable(page, { maxIterations: 3, changeThreshold: 0.01, consecutiveStable: 2 });
      }
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
): Promise<{
  label: string | null;
  elements: Array<{ key: string; x: number; y: number; confidence?: number; role?: string }>;
  /** Raw PNG buffer the AI saw — caller persists it to the discovery-snapshots
   *  store paired with the elements so the dashboard can render an overlay. */
  pngBuf: Buffer;
}> {
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
    if (!parsed || !Array.isArray(parsed.elements)) return { label: null, elements: [], pngBuf: buf };
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
    return { label: typeof parsed.stateLabel === "string" ? parsed.stateLabel : null, elements, pngBuf: buf };
  } catch (err) {
    return { label: null, elements: [], pngBuf: buf };
  }
}

// Expose explain helper for diagnostics.
export { explainSafety, STATE_SAME_THRESHOLD };
