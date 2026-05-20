/**
 * Adapter layer entrypoint. Importing this module ensures all built-in
 * providers + mechanics are registered.
 *
 * Callers typically do:
 *   import { resolveAdapter } from "../adapters/index.js";
 *   const adapter = resolveAdapter({ slug, spec });
 */

export * from "./types.js";
export { composeGameAdapter } from "./compose.js";
export {
  resolveAdapter,
  registerAdapter,
  registerProvider,
  listRegisteredSlugs,
  listProviders,
} from "./registry.js";

export { genericProvider } from "./providers/generic.js";
export { pragmaticProvider } from "./providers/pragmatic.js";

export { waysMechanic } from "./mechanics/ways.js";
export { paylinesMechanic } from "./mechanics/paylines.js";
export { clusterMechanic } from "./mechanics/cluster.js";

/**
 * Idempotent bootstrap — call once from each entrypoint that needs adapters
 * (auto-play.ts, generate-and-run.ts, playwright.config.ts globalSetup).
 * Module side-effects already register built-in adapters; this function
 * exists so the registration site is explicit and greppable.
 */
let bootstrapped = false;
export function bootstrapAdapters(): void {
  if (bootstrapped) return;
  // Importing this barrel triggers all provider/mechanic registrations.
  // Per-game adapter files (src/adapters/games/*.ts) self-register on import;
  // add explicit imports here when game-specific adapters are written.
  bootstrapped = true;
}
