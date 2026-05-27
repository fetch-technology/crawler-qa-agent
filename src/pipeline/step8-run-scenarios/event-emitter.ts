// Per-case event emitter for SSE streaming + per-case lifecycle visibility.
// Events match legacy `EVENT:case_start` / `EVENT:case_end` so dashboard SSE
// can re-use existing client logic.
//
// Events are written to stdout as `EVENT:<kind> <json>` lines (parsed by the
// qa-routes task runner which captures stdout). Also forwarded to in-process
// listeners for callers running in same context.

export type CaseEventKind =
  | "case_start"     // before scenario step loop begins
  | "case_step"      // each scenario step result
  | "case_end"       // scenario finished (pass/fail/skip)
  | "phase_start"    // section marker: "discovery" / "smoke" / "verify" / etc.
  | "phase_end";

export type CaseEvent = {
  kind: CaseEventKind;
  ts: string;
  payload: Record<string, unknown>;
};

type Listener = (event: CaseEvent) => void;
const listeners = new Set<Listener>();

export function subscribeCaseEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitCaseEvent(kind: CaseEventKind, payload: Record<string, unknown> = {}): void {
  const event: CaseEvent = { kind, ts: new Date().toISOString(), payload };
  // Write a single-line marker to stdout so subprocess capture sees it.
  process.stdout.write(`EVENT:${kind} ${JSON.stringify(payload)}\n`);
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // listeners can't break emitter
    }
  }
}

export function caseStart(caseId: string, meta: Record<string, unknown> = {}): void {
  emitCaseEvent("case_start", { caseId, ...meta });
}

export function caseStep(
  caseId: string,
  stepIdx: number,
  ok: boolean,
  detail?: string,
): void {
  emitCaseEvent("case_step", { caseId, stepIdx, ok, detail });
}

export function caseEnd(
  caseId: string,
  status: "passed" | "failed" | "skipped",
  meta: Record<string, unknown> = {},
): void {
  emitCaseEvent("case_end", { caseId, status, ...meta });
}

export function phaseStart(phase: string, meta: Record<string, unknown> = {}): void {
  emitCaseEvent("phase_start", { phase, ...meta });
}

export function phaseEnd(phase: string, meta: Record<string, unknown> = {}): void {
  emitCaseEvent("phase_end", { phase, ...meta });
}
