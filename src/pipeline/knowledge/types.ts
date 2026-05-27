// CompiledKnowledge — single immutable bundle that the engine consumes
// at runtime, instead of loading 10+ raw registry files separately.
//
// Phase 7.3 architecture: raw configs → Knowledge Compiler → CompiledKnowledge
// → engine. Compiler is pure (no I/O at the engine layer), deterministic
// (same input → same output), and cross-validates configs for consistency.

import type {
  UiRegistry,
  ProviderCache,
  ApiMapping,
  FieldMapping,
  ParserCache,
  GameMechanics,
  TimingConfig,
  BetControlsConfig,
  PopupKeywordsConfig,
  SubStateHintsConfig,
} from "../registry/types.js";

export type CompiledKnowledge = {
  /** Schema version of this compiled bundle. Bump when shape changes. */
  schemaVersion: 1;
  /** SHA-256 of each source file at compile time. Allows cache invalidation. */
  sourceHashes: Record<string, string>;
  /** Wall-clock timestamp of compilation. */
  compiledAt: string;
  /** Game slug this knowledge applies to. */
  gameSlug: string;

  /** Effective UI element map (registry as-loaded, no transformation). */
  ui: UiRegistry;
  /** Provider info. */
  provider: ProviderCache | null;
  /** API mappings. */
  api: ApiMapping | null;
  /** Field mapping (canonical + aliases). */
  fields: FieldMapping | null;
  /** Parser kind to use. */
  parser: ParserCache | null;
  /** Game mechanic (lines/ways/cluster) + bet multiplier. */
  mechanics: GameMechanics | null;

  /** Resolved configs with defaults baked in (engine doesn't need to know about defaults). */
  timing: Required<TimingConfig>;
  betControls: Required<BetControlsConfig>;
  popupKeywords: {
    interstitial: ReadonlyArray<string>;
    substate: ReadonlyArray<string>;
  };
  subStateHints: Record<string, { stateLabel: string; description: string }>;

  /** Derived/pre-computed values that engine repeatedly needs. */
  derived: {
    /** Pre-computed `c × M` (bet ladder) when mechanics + coinValues known. Empty if not derivable. */
    betLadder: number[];
    /** Convenience: bet formula description string for logs/AI prompts. */
    betFormulaDescription: string;
  };

  /** Cross-validation results: non-fatal warnings + fatal errors. Engine
   *  refuses to load if errors.length > 0 (caller responsible for surfacing). */
  warnings: string[];
  errors: string[];
};

/** Subset of source file keys used by the compiler. Used for hash computation. */
export const COMPILE_SOURCE_KEYS = [
  "uiRegistry",
  "providerCache",
  "apiMapping",
  "fieldMapping",
  "parserCache",
  "gameMechanics",
  "timingConfig",
  "betControls",
  "popupKeywords",
  "subStateHints",
  "popupRegions",
  "stateSignatures",
] as const;
