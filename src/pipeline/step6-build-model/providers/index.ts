import { readFileSync } from "node:fs";
import path from "node:path";
import { registerParser } from "../registry.js";
import { PragmaticParser } from "./pragmatic-parser.js";
import { GenericParser } from "./generic-parser.js";
import { SpecDrivenParser } from "./spec-driven-parser.js";
import { ThreeOaksParser } from "./threeoaks-parser.js";
import { PlaytechParser } from "./playtech-parser.js";
import { dirForGame } from "../../registry/paths.js";
import type { ProviderSpec } from "./spec-types.js";

let registered = false;

/** Sync-load a provider spec JSON at module-init time. Throws if missing
 *  or invalid — caught by registerBuiltInParsers's fallback path. */
function loadSpecSync(providerName: string): ProviderSpec | null {
  const file = path.join(dirForGame("_providers"), `${providerName.toLowerCase()}.json`);
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as ProviderSpec;
  } catch {
    return null;
  }
}

export function registerBuiltInParsers(): void {
  if (registered) return;
  // Phase 9 — prefer spec-driven if a JSON spec exists; fall back to
  // hardcoded class. QA_SPEC_DRIVEN_PARSER=0 forces legacy path.
  const useSpec = process.env.QA_SPEC_DRIVEN_PARSER !== "0";
  const ppSpec = useSpec ? loadSpecSync("pragmatic") : null;
  if (ppSpec) {
    registerParser("PragmaticParser", () => new SpecDrivenParser(ppSpec, "PragmaticParser"));
  } else {
    registerParser("PragmaticParser", () => new PragmaticParser());
  }
  registerParser("GenericParser", () => new GenericParser());
  registerParser("ThreeOaksParser", () => new ThreeOaksParser());
  registerParser("PlaytechParser", () => new PlaytechParser());
  registered = true;
}

export { PragmaticParser, GenericParser, SpecDrivenParser, ThreeOaksParser, PlaytechParser };
