import { registerBuiltInParsers } from "./providers/index.js";

registerBuiltInParsers();

export { pickParser, pickParserByKind, registerParser } from "./registry.js";
export type { BaseParser, ParserKind } from "./base-parser.js";
export type { NormalizedSpinResult, SpinState } from "./normalized.js";
export { isValidTransition, validTransitionsFrom } from "./state-machine.js";
