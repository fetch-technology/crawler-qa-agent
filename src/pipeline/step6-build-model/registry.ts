import type { ProviderName } from "../registry/types.js";
import type { BaseParser, ParserKind } from "./base-parser.js";

const FACTORIES = new Map<ParserKind, () => BaseParser>();

export function registerParser(kind: ParserKind, factory: () => BaseParser): void {
  FACTORIES.set(kind, factory);
}

export function pickParser(provider: ProviderName): BaseParser {
  const kind: ParserKind =
    provider === "Pragmatic" ? "PragmaticParser"
    : provider === "ThreeOaks" ? "ThreeOaksParser"
    : provider === "Playtech" ? "PlaytechParser"
    : "GenericParser";
  return pickParserByKind(kind);
}

export function pickParserByKind(kind: ParserKind): BaseParser {
  const factory = FACTORIES.get(kind);
  if (!factory) {
    throw new Error(
      `No parser registered for kind: ${kind}. Call registerBuiltInParsers() from step6-build-model/providers/index.js at app startup.`,
    );
  }
  return factory();
}
