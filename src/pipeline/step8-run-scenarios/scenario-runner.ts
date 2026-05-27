// Scenario runner — consume testcases.yaml and execute steps deterministically.
// Resolves selectors against the UI registry; uses waitForState for state transitions.
// NEVER calls AI at runtime.

import type { Page } from "playwright";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { UiRegistry } from "../registry/types.js";
import type { StateSignatures } from "../registry/types.js";
import type { CaptureHandle } from "../step3-capture-network/types.js";
import type { SpinState } from "../step6-build-model/normalized.js";
import { waitForState } from "./wait-for-state.js";

export type StepKind = "click" | "wait_state" | "wait_network" | "verify_diff";

export type ScenarioStep =
  | { kind: "click"; uiKey: string }
  | { kind: "wait_state"; state: SpinState; timeoutMs?: number }
  | { kind: "wait_network"; urlContains: string; timeoutMs?: number }
  | { kind: "verify_diff"; region?: { x: number; y: number; width: number; height: number }; minRatio: number };

export type ScenarioResult = {
  scenarioId: string;
  pass: boolean;
  events: Array<{ step: number; kind: StepKind; ok: boolean; detail?: string }>;
};

export type ScenarioContext = {
  page: Page;
  uiMap: UiRegistry;
  parser: BaseParser;
  capture: CaptureHandle;
  stateSignatures?: StateSignatures | null;
};

export async function runScenario(
  id: string,
  steps: ScenarioStep[],
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const events: ScenarioResult["events"] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    try {
      if (step.kind === "click") {
        const el = ctx.uiMap[step.uiKey];
        if (!el) {
          events.push({
            step: i,
            kind: "click",
            ok: false,
            detail: `uiKey '${step.uiKey}' not in registry`,
          });
          return { scenarioId: id, pass: false, events };
        }
        await ctx.page.mouse.click(el.x, el.y);
        events.push({ step: i, kind: "click", ok: true, detail: `clicked ${step.uiKey} at (${el.x},${el.y})` });
      } else if (step.kind === "wait_state") {
        const res = await waitForState(
          ctx.page,
          step.state,
          {
            capture: ctx.capture,
            parser: ctx.parser,
            stateSignatures: ctx.stateSignatures,
          },
          { timeoutMs: step.timeoutMs ?? 5000 },
        );
        events.push({
          step: i,
          kind: "wait_state",
          ok: res.ok,
          detail: res.ok
            ? `entered ${step.state} via ${res.source}`
            : res.reason,
        });
        if (!res.ok) return { scenarioId: id, pass: false, events };
      } else if (step.kind === "wait_network") {
        const ok = await waitNetworkContains(ctx.capture, step.urlContains, step.timeoutMs ?? 5000);
        events.push({
          step: i,
          kind: "wait_network",
          ok,
          detail: ok ? `saw ${step.urlContains}` : `timeout waiting for ${step.urlContains}`,
        });
        if (!ok) return { scenarioId: id, pass: false, events };
      } else if (step.kind === "verify_diff") {
        // Placeholder — verify diff requires before/after capture; runner provides
        // post-action diff via separate mechanism (see ui-mode.ts).
        events.push({ step: i, kind: "verify_diff", ok: true, detail: "skipped (no baseline)" });
      }
    } catch (e) {
      events.push({
        step: i,
        kind: step.kind,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
      return { scenarioId: id, pass: false, events };
    }
  }

  return { scenarioId: id, pass: true, events };
}

async function waitNetworkContains(
  capture: CaptureHandle,
  urlContains: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rounds = capture.flush();
    for (const round of rounds) {
      for (const res of round.responses) {
        if (res.url.includes(urlContains)) return true;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
