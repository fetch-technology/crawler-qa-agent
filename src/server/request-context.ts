// Per-request execution context — propagates the QA's Claude token (from
// the X-Claude-Token HTTP header) through every async call inside the
// request handler, including AI calls in nested phase functions, deep
// extractors, etc. Uses Node's AsyncLocalStorage so we don't need to
// thread the token through every function signature.
//
// HTTP middleware wraps each incoming request with `requestContext.run(ctx, …)`.
// askClaude (src/ai/claude.ts) reads `getCurrentClaudeToken()` to choose
// between the QA-supplied token and the master env-var fallback.
//
// Background-task propagation note: AsyncLocalStorage flows transparently
// through await chains. Long-running endpoints like /auto-onboard (which
// internally call dozens of askClaude over 30+ minutes) keep the context
// alive as long as the route handler awaits the full work — which they
// do today (`await session.autoOnboard(...)`). Node's HTTP server does
// NOT abort handlers on client disconnect, so even a polling client that
// gives up on the 504 leaves the server-side handler (and its context)
// intact. Phase-3 of the per-QA token plan therefore reduces to "verify
// the await chain is unbroken." If a future change introduces a real
// fire-and-forget (setTimeout dispatched work that outlives the request),
// snapshot via `snapshotRequestContext()` and re-enter with
// `requestContext.run(snapshot, () => ...)` at the dispatch site.

import { AsyncLocalStorage } from "node:async_hooks";

/** Shape of data threaded through the async call chain for one HTTP req. */
export type RequestContext = {
  /** Raw token from X-Claude-Token header. Null when header not set
   *  (master env fallback applies). */
  claudeToken: string | null;
  /** First 8 chars of SHA-256(token) — stable per-QA identifier used for
   *  usage attribution + logs without exposing the raw token. Null when
   *  no QA token (master used). Phase 5 will populate this. */
  qaHash?: string | null;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Read the QA's Claude token from the active request context. Returns
 *  null when (a) no HTTP request context is active (e.g. CLI mode, CLI
 *  cold-start subprocess) or (b) the request didn't carry an
 *  X-Claude-Token header. Callers fall back to process.env in either case. */
export function getCurrentClaudeToken(): string | null {
  return requestContext.getStore()?.claudeToken ?? null;
}

/** Read the QA hash for attribution. Currently unused but reserved for
 *  Phase 5 usage tracking — claude.ts hashes the token once and stamps
 *  the context, downstream loggers read this without re-hashing. */
export function getCurrentQaHash(): string | null {
  return requestContext.getStore()?.qaHash ?? null;
}

/** Helper: snapshot the current context so a background task can re-enter
 *  it later (e.g. autoOnboard captures token at start, then re-runs
 *  context for each phase even after the HTTP response closes). Returns
 *  null when no active context (CLI mode). */
export function snapshotRequestContext(): RequestContext | null {
  return requestContext.getStore() ?? null;
}
