// Deterministic scenario executor. Given a YAML/JSON scenario consisting of
// element keys + state assertions, walks the UI graph to execute clicks
// without per-action AI.
//
// Step kinds:
//   - { kind: "click", target: <elementKey> }          → auto-navigates if not in current state
//   - { kind: "reach_state", state: <stateId> }        → explicit navigation
//   - { kind: "wait_ms", ms: number }                  → sleep
//   - { kind: "expect_state", state: <stateId> }       → assertion

import type { Page } from "playwright";
import type { UiElement, UiRegistry } from "../registry/types.js";
import type { UiGraph } from "../registry/ui-graph-store.js";
import { findPath, findStateForElement } from "./graph-navigator.js";
import { waitUntilStable, snapshot } from "../utils/pixel-diff/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { pixelDiff } from "../utils/pixel-diff/diff.js";
import { dirForGame } from "../registry/paths.js";

export type ScenarioStep =
  | { kind: "click"; target: string }
  | { kind: "reach_state"; state: string }
  | { kind: "wait_ms"; ms: number }
  | { kind: "expect_state"; state: string };

export type Scenario = {
  name: string;
  steps: ScenarioStep[];
};

export type ScenarioContext = {
  page: Page;
  gameSlug: string;
  uiRegistry: UiRegistry;
  uiGraph: UiGraph;
};

export type ExecutionEvent = {
  stepIndex: number;
  kind: ScenarioStep["kind"];
  ok: boolean;
  detail?: string;
};

export type ScenarioResult = {
  scenarioName: string;
  ok: boolean;
  events: ExecutionEvent[];
  finalState: string;
};

const STATE_MATCH_THRESHOLD = 0.05;

export async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  const events: ExecutionEvent[] = [];
  let currentState = ctx.uiGraph.initialState;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    try {
      if (step.kind === "click") {
        const targetState = findStateForElement(ctx.uiGraph, step.target);
        if (!targetState) {
          events.push({ stepIndex: i, kind: "click", ok: false, detail: `element ${step.target} not in any known state` });
          return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
        }
        if (targetState !== currentState) {
          const path = findPath(ctx.uiGraph, currentState, targetState);
          if (!path.ok) {
            events.push({ stepIndex: i, kind: "click", ok: false, detail: `cannot navigate to ${targetState}: ${path.reason}` });
            return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
          }
          for (const navStep of path.steps) {
            const navOk = await performClick(ctx, navStep.via);
            if (!navOk.ok) {
              events.push({ stepIndex: i, kind: "click", ok: false, detail: `auto-nav click ${navStep.via} failed: ${navOk.reason}` });
              return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
            }
            currentState = navStep.toState;
          }
        }
        const clickOk = await performClick(ctx, step.target);
        if (!clickOk.ok) {
          events.push({ stepIndex: i, kind: "click", ok: false, detail: clickOk.reason });
          return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
        }
        const after = ctx.uiGraph.states[currentState]?.transitions[step.target];
        if (after) currentState = after;
        events.push({ stepIndex: i, kind: "click", ok: true, detail: `${step.target} → ${currentState}` });
      } else if (step.kind === "reach_state") {
        if (currentState === step.state) {
          events.push({ stepIndex: i, kind: "reach_state", ok: true, detail: `already in ${step.state}` });
          continue;
        }
        const path = findPath(ctx.uiGraph, currentState, step.state);
        if (!path.ok) {
          events.push({ stepIndex: i, kind: "reach_state", ok: false, detail: path.reason });
          return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
        }
        for (const navStep of path.steps) {
          const navOk = await performClick(ctx, navStep.via);
          if (!navOk.ok) {
            events.push({ stepIndex: i, kind: "reach_state", ok: false, detail: `nav click ${navStep.via} failed: ${navOk.reason}` });
            return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
          }
          currentState = navStep.toState;
        }
        events.push({ stepIndex: i, kind: "reach_state", ok: true, detail: `now in ${currentState}` });
      } else if (step.kind === "wait_ms") {
        await ctx.page.waitForTimeout(step.ms);
        events.push({ stepIndex: i, kind: "wait_ms", ok: true });
      } else if (step.kind === "expect_state") {
        const matched = await verifyCurrentState(ctx, step.state);
        if (!matched) {
          events.push({ stepIndex: i, kind: "expect_state", ok: false, detail: `pixel-diff says NOT in ${step.state}` });
          return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
        }
        events.push({ stepIndex: i, kind: "expect_state", ok: true });
      }
    } catch (err) {
      events.push({
        stepIndex: i,
        kind: step.kind,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return { scenarioName: scenario.name, ok: false, events, finalState: currentState };
    }
  }

  return { scenarioName: scenario.name, ok: true, events, finalState: currentState };
}

async function performClick(
  ctx: ScenarioContext,
  elementKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  const el = (ctx.uiRegistry as Record<string, UiElement | undefined>)[elementKey];
  if (!el) return { ok: false, reason: `element ${elementKey} missing in registry` };
  try {
    await ctx.page.mouse.click(el.x, el.y);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await waitUntilStable(ctx.page, {
    maxIterations: 8,
    changeThreshold: 0.005,
    consecutiveStable: 2,
  });
  return { ok: true };
}

async function verifyCurrentState(ctx: ScenarioContext, stateId: string): Promise<boolean> {
  const stateMeta = ctx.uiGraph.states[stateId];
  if (!stateMeta?.baselineImage) return false;
  const baselinePath = join(dirForGame(ctx.gameSlug), stateMeta.baselineImage);
  let baseline: PNG;
  try {
    baseline = PNG.sync.read(readFileSync(baselinePath));
  } catch {
    return false;
  }
  const current = await snapshot(ctx.page);
  if (baseline.width !== current.width || baseline.height !== current.height) return false;
  const { ratio } = pixelDiff(baseline, current);
  return ratio < STATE_MATCH_THRESHOLD;
}
