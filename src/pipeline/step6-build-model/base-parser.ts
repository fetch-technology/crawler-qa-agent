import type { NormalizedSpinResult } from "./normalized.js";

export type ParserKind = "PragmaticParser" | "GenericParser" | "ThreeOaksParser" | "LearnedSpecParser";

export interface BaseParser {
  readonly kind: ParserKind;
  readonly providerCode: string;
  canParseResponse(raw: string, url?: string): boolean;
  parseResponse(raw: string): NormalizedSpinResult;
  /**
   * Optional richer parse: when caller can match a REQUEST body to its RESPONSE,
   * pass both. The bet for most providers (PP, JILI, RG) lives in the request
   * (`c=0.2&bl=200` → bet=40), NOT the response — so this is the only way to
   * populate `bet` accurately. Falls back to parseResponse alone if not provided.
   */
  parseSpinPair?(
    request: string | null,
    response: string,
    url?: string,
  ): NormalizedSpinResult;
}
