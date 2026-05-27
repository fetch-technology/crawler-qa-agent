// BFS shortest-path navigation on a UI graph. Given current state + target
// state, return the sequence of clicks (element keys) needed to reach target.
//
// Used by scenario-executor to auto-navigate to required states before clicking
// scenario-specific elements.

import type { UiGraph } from "../registry/ui-graph-store.js";

export type NavigationStep = {
  fromState: string;
  via: string;          // element key to click
  toState: string;
};

export type NavigationPath =
  | { ok: true; steps: NavigationStep[] }
  | { ok: false; reason: string };

export function findPath(
  graph: UiGraph,
  fromState: string,
  toState: string,
): NavigationPath {
  if (fromState === toState) return { ok: true, steps: [] };
  if (!graph.states[fromState]) return { ok: false, reason: `unknown fromState ${fromState}` };
  if (!graph.states[toState]) return { ok: false, reason: `unknown toState ${toState}` };

  // BFS
  const queue: Array<{ state: string; path: NavigationStep[] }> = [
    { state: fromState, path: [] },
  ];
  const visited = new Set<string>([fromState]);

  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    const node = graph.states[state];
    if (!node) continue;
    for (const [via, target] of Object.entries(node.transitions)) {
      if (visited.has(target)) continue;
      const nextPath = [...path, { fromState: state, via, toState: target }];
      if (target === toState) {
        return { ok: true, steps: nextPath };
      }
      visited.add(target);
      queue.push({ state: target, path: nextPath });
    }
  }

  return { ok: false, reason: `no path from ${fromState} to ${toState}` };
}

/**
 * Find which state contains the given element key. Returns null if element not
 * present in any state.
 */
export function findStateForElement(graph: UiGraph, elementKey: string): string | null {
  for (const [stateId, node] of Object.entries(graph.states)) {
    if (node.elements.includes(elementKey)) return stateId;
  }
  return null;
}
