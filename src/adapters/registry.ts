/**
 * Adapter registry — resolve `GameAdapter` from slug / snapshot / spec.
 *
 * Lookup precedence:
 *   1. Explicit per-slug factory (registered via `registerAdapter(slug, ...)`)
 *   2. Provider × Mechanic composition based on snapshot/spec hints
 *   3. GenericProvider × WaysMechanic fallback
 */

import { composeGameAdapter } from "./compose.js";
import { genericProvider } from "./providers/generic.js";
import { pragmaticProvider } from "./providers/pragmatic.js";
import { waysMechanic } from "./mechanics/ways.js";
import { paylinesMechanic } from "./mechanics/paylines.js";
import { clusterMechanic } from "./mechanics/cluster.js";
import type { GameSpec } from "../ai/authoring.js";
import type {
  GameAdapter,
  MechanicAdapter,
  ProviderAdapter,
} from "./types.js";

export type ResolveArgs = {
  slug: string;
  /** Optional GameSpec from authoring (provides paytable + mechanic hint). */
  spec?: GameSpec | null;
  /** Optional URL sample from recording (to sniff provider). */
  sampleUrl?: string | null;
  /** Explicit overrides — beats everything else. */
  providerOverride?: ProviderAdapter;
  mechanicOverride?: MechanicAdapter;
};

type AdapterFactory = (args: ResolveArgs) => GameAdapter;

const slugFactories = new Map<string, AdapterFactory>();
const providers: ProviderAdapter[] = [pragmaticProvider, genericProvider];

/** Register a slug-specific adapter factory. Highest precedence. */
export function registerAdapter(slug: string, factory: AdapterFactory): void {
  slugFactories.set(slug, factory);
}

/** Register a provider so the registry can compose with it on demand. */
export function registerProvider(provider: ProviderAdapter): void {
  if (!providers.find((p) => p.providerCode === provider.providerCode)) {
    providers.unshift(provider); // most-recently-registered wins
  }
}

function sniffProvider(args: ResolveArgs): ProviderAdapter {
  if (args.providerOverride) return args.providerOverride;
  const url = args.sampleUrl ?? "";
  if (url && /\/gs2c\//i.test(url)) return pragmaticProvider;
  return genericProvider;
}

function sniffMechanic(args: ResolveArgs): MechanicAdapter {
  if (args.mechanicOverride) return args.mechanicOverride;
  const spec = args.spec;
  if (!spec) return waysMechanic;
  // Heuristic: features mentioning "cluster" / "tumble" → cluster mechanic.
  // features mentioning "lines" → paylines. Default ways.
  const featTxt = (spec.features ?? [])
    .map((f) => `${f.name} ${f.description}`)
    .join(" ")
    .toLowerCase();
  if (/cluster|tumble|cascade/.test(featTxt)) return clusterMechanic;
  if (/payline|fixed line/.test(featTxt)) return paylinesMechanic;
  return waysMechanic;
}

/** Resolve a GameAdapter. Always returns something usable (fallback included). */
export function resolveAdapter(args: ResolveArgs): GameAdapter {
  const explicit = slugFactories.get(args.slug);
  if (explicit) return explicit(args);

  const provider = sniffProvider(args);
  const mechanic = sniffMechanic(args);

  return composeGameAdapter({
    gameCode: args.slug,
    provider,
    mechanic,
    spec: args.spec ?? null,
  });
}

/** Diagnostic — list all registered slug-specific factories. */
export function listRegisteredSlugs(): string[] {
  return [...slugFactories.keys()].sort();
}

/** Diagnostic — list provider codes in resolution order. */
export function listProviders(): string[] {
  return providers.map((p) => p.providerCode);
}
