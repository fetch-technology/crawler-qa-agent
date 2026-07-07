// Lightweight JSON Schema-style validators for registry config files.
// Phase 7.2 — replaces ad-hoc type checks scattered through store load paths.
//
// Why not Ajv? Schemas are small + simple (no $ref, no complex patterns), and
// adding a runtime dep just for this isn't worth it. The mini-validator below
// supports: type checks, required fields, enums, array of T, nested objects,
// optional fields. Enough for all current configs.

export type SchemaType = "string" | "number" | "boolean" | "object" | "array" | "null";

export type Schema =
  | { type: SchemaType; nullable?: boolean }
  | { type: "string"; enum?: string[]; pattern?: string; nullable?: boolean }
  | { type: "number"; min?: number; max?: number; nullable?: boolean }
  | { type: "array"; items: Schema; nullable?: boolean }
  | { type: "object"; required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; nullable?: boolean };

export type ValidationError = {
  path: string;
  message: string;
};

export function validate(value: unknown, schema: Schema, path = "$"): ValidationError[] {
  const errors: ValidationError[] = [];
  if (value === null) {
    if ((schema as { nullable?: boolean }).nullable) return errors;
    if (schema.type === "null") return errors;
    errors.push({ path, message: "value is null but schema doesn't allow null" });
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push({ path, message: `expected string, got ${typeof value}` });
      return errors;
    }
    const sch = schema as { enum?: string[]; pattern?: string };
    if (sch.enum && !sch.enum.includes(value)) {
      errors.push({ path, message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(sch.enum)}` });
    }
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) {
      errors.push({ path, message: `value ${JSON.stringify(value)} doesn't match pattern ${sch.pattern}` });
    }
    return errors;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({ path, message: `expected finite number, got ${typeof value}` });
      return errors;
    }
    const sch = schema as { min?: number; max?: number };
    if (sch.min !== undefined && value < sch.min) errors.push({ path, message: `${value} < min ${sch.min}` });
    if (sch.max !== undefined && value > sch.max) errors.push({ path, message: `${value} > max ${sch.max}` });
    return errors;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push({ path, message: `expected boolean, got ${typeof value}` });
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `expected array, got ${typeof value}` });
      return errors;
    }
    const items = (schema as { items: Schema }).items;
    value.forEach((item, i) => errors.push(...validate(item, items, `${path}[${i}]`)));
    return errors;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push({ path, message: `expected object, got ${Array.isArray(value) ? "array" : typeof value}` });
      return errors;
    }
    const sch = schema as { required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema };
    const obj = value as Record<string, unknown>;
    for (const req of sch.required ?? []) {
      if (!(req in obj)) errors.push({ path: `${path}.${req}`, message: "required property missing" });
    }
    for (const [key, val] of Object.entries(obj)) {
      const propSchema = sch.properties?.[key];
      if (propSchema) {
        errors.push(...validate(val, propSchema, `${path}.${key}`));
      } else if (sch.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: "additional property not allowed" });
      } else if (typeof sch.additionalProperties === "object") {
        errors.push(...validate(val, sch.additionalProperties, `${path}.${key}`));
      }
    }
    return errors;
  }
  return errors;
}

// ============================================================================
// Schemas per registry store
// ============================================================================

export const META_SCHEMA: Schema = {
  type: "object",
  required: ["schemaVersion", "createdAt", "gameUrl"],
  properties: {
    schemaVersion: { type: "number", min: 1 },
    createdAt: { type: "string" },
    gameUrl: { type: "string" },
    lastValidatedAt: { type: "string", nullable: true },
    baseGameSlug: { type: "string", nullable: true },
    currency: { type: "string", nullable: true },
    language: { type: "string", nullable: true },
    recordSlug: { type: "string", nullable: true },
    clonedFromSlug: { type: "string", nullable: true },
  },
};

export const UI_ELEMENT_SCHEMA: Schema = {
  type: "object",
  required: ["x", "y", "strategy", "confidence", "detectedAt"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    strategy: { type: "string", enum: ["dom", "ocr", "template", "ai_vision", "ai_recover", "manual"] },
    confidence: { type: "number", min: 0, max: 1 },
    detectedAt: { type: "string" },
    verifiedAt: { type: "string", nullable: true },
    verifiedBy: { type: "string", nullable: true },
    status: { type: "string", enum: ["pending", "verified", "rejected"], nullable: true },
    baselineImage: { type: "string", nullable: true },
    preferredGesture: { type: "string", enum: ["click", "hold"], nullable: true },
    preferredHoldMs: { type: "number", nullable: true },
  },
};

export const UI_REGISTRY_SCHEMA: Schema = {
  type: "object",
  additionalProperties: UI_ELEMENT_SCHEMA,
};

export const PROVIDER_CACHE_SCHEMA: Schema = {
  type: "object",
  required: ["provider", "gameName", "platform", "detectedAt"],
  properties: {
    provider: { type: "string" },
    gameName: { type: "string" },
    platform: { type: "string" },
    detectedAt: { type: "string" },
    iframeCount: { type: "number", nullable: true },
    canvasCount: { type: "number", nullable: true },
  },
};

export const PARSER_CACHE_SCHEMA: Schema = {
  type: "object",
  required: ["parser", "version"],
  properties: {
    parser: { type: "string", enum: ["PragmaticParser", "GenericParser"] },
    version: { type: "number", min: 1 },
  },
};

export const GAME_MECHANICS_SCHEMA: Schema = {
  type: "object",
  required: ["mechanic", "betMultiplier", "waysOrLines", "detectedAt", "detectionMethod"],
  properties: {
    mechanic: { type: "string", enum: ["lines", "ways", "cluster", "unknown"] },
    betMultiplier: { type: "number", min: 0 },
    waysOrLines: { type: "number", min: 0 },
    detectedAt: { type: "string" },
    detectionMethod: { type: "string", enum: ["balance_derived", "manual", "fallback"] },
    evidence: {
      type: "object",
      properties: {
        coin: { type: "number" },
        deductedFromBalance: { type: "number" },
        requestSample: { type: "string", nullable: true },
      },
      nullable: true,
    },
  },
};

export const TIMING_CONFIG_SCHEMA: Schema = {
  type: "object",
  properties: {
    spinResponseTimeoutMs: { type: "number", min: 100 },
    postActionSettleMs: { type: "number", min: 100 },
    actionTimeoutMs: { type: "number", min: 100 },
    hardCapMs: { type: "number", min: 1000 },
    popupCheckDelayMs: { type: "number", min: 0 },
    dismissInterClickMs: { type: "number", min: 0 },
    dismissPreWaitMs: { type: "number", min: 0 },
    maxSpinRetries: { type: "number", min: 0, max: 10 },
  },
};

export const BET_CONTROLS_SCHEMA: Schema = {
  type: "object",
  properties: {
    minBetClicks: { type: "number", min: 1, max: 100 },
    maxBetClicks: { type: "number", min: 1, max: 100 },
    stepDelayMs: { type: "number", min: 0, max: 10000 },
  },
};

export const POPUP_KEYWORDS_SCHEMA: Schema = {
  type: "object",
  properties: {
    interstitial: { type: "array", items: { type: "string" } },
    substate: { type: "array", items: { type: "string" } },
    replaceDefaults: { type: "boolean" },
  },
};

export const SUB_STATE_HINTS_SCHEMA: Schema = {
  type: "object",
  properties: {
    hints: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["stateLabel", "description"],
        properties: {
          stateLabel: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

export const FIELD_MAPPING_SCHEMA: Schema = {
  type: "object",
  required: ["bet", "win", "balance", "roundId", "reels"],
  properties: {
    bet: { type: "string" },
    win: { type: "string" },
    balance: { type: "string" },
    balanceBefore: { type: "string", nullable: true },
    roundId: { type: "string" },
    reels: { type: "string" },
    state: { type: "string", nullable: true },
    freeSpinsRemaining: { type: "string", nullable: true },
  },
};

/** Phase 9 — Provider Spec schema. Used to validate per-provider JSON files
 *  under fixtures/registry/_providers/*.json. */
export const PROVIDER_SPEC_SCHEMA: Schema = {
  type: "object",
  required: ["name", "wireFormat", "urlPatterns", "response", "request", "roundId"],
  properties: {
    name: { type: "string" },
    wireFormat: { type: "string", enum: ["querystring", "json", "form", "auto"] },
    urlPatterns: { type: "array", items: { type: "string" } },
    skipUrlPatterns: { type: "array", items: { type: "string" }, nullable: true },
    nonSpinActions: { type: "array", items: { type: "string" }, nullable: true },
    spinRequiredParams: { type: "array", items: { type: "string" }, nullable: true },
    response: {
      type: "object",
      required: ["fields", "shapeScore"],
      properties: {
        fields: {
          type: "object",
          required: ["balanceAfter"],
          properties: {
            balanceBefore: { type: "string", nullable: true },
            balanceAfter: { type: "string" },
            totalWin: { type: "string", nullable: true },
            initialReels: { type: "string", nullable: true },
            cascadeFrames: { type: "string", nullable: true },
            freeSpinsRemaining: { type: "string", nullable: true },
            roundIndex: { type: "string", nullable: true },
            roundAction: { type: "string", nullable: true },
            roundId: { type: "string", nullable: true },
            reelWidth: { type: "string", nullable: true },
            reelHeight: { type: "string", nullable: true },
          },
        },
        reelsDecoder: {
          type: "string",
          enum: ["column_major", "row_major", "json_array", "csv"],
          nullable: true,
        },
        defaultReelDimensions: {
          type: "object",
          required: ["width", "height"],
          properties: {
            width: { type: "number", min: 1 },
            height: { type: "number", min: 1 },
          },
          nullable: true,
        },
        shapeScore: {
          type: "object",
          required: ["requiredFields", "minScore"],
          properties: {
            requiredFields: { type: "array", items: { type: "string" } },
            bonusFields: { type: "array", items: { type: "string" }, nullable: true },
            minScore: { type: "number", min: 0 },
          },
        },
        nestedExtractions: {
          type: "array",
          items: {
            type: "object",
            required: ["sourceField", "pattern", "targetField"],
            properties: {
              sourceField: { type: "string" },
              pattern: { type: "string" },
              targetField: { type: "string" },
            },
          },
          nullable: true,
        },
      },
    },
    request: {
      type: "object",
      required: ["fields", "betFormula"],
      properties: {
        fields: {
          type: "object",
          properties: {
            coin: { type: "string", nullable: true },
            betLevel: { type: "string", nullable: true },
            lines: { type: "string", nullable: true },
            explicitBet: { type: "string", nullable: true },
            roundIdParts: { type: "array", items: { type: "string" }, nullable: true },
          },
        },
        betFormula: { type: "string" },
      },
    },
    roundId: {
      type: "object",
      required: ["source", "fields"],
      properties: {
        source: { type: "string", enum: ["request", "response"] },
        fields: { type: "array", items: { type: "string" } },
        format: { type: "string", nullable: true },
        fallback: { type: "string", enum: ["response_hash", "timestamp_random", "throw"], nullable: true },
      },
    },
    roundEndSignals: {
      type: "array",
      items: {
        type: "object",
        required: ["urlPattern"],
        properties: {
          urlPattern: { type: "string" },
          bodyPattern: { type: "string", nullable: true },
        },
      },
      nullable: true,
    },
  },
};

export const API_MAPPING_SCHEMA: Schema = {
  type: "object",
  required: ["spinApi"],
  properties: {
    spinApi: {
      type: "object",
      required: ["url", "method"],
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
      },
    },
    historyApi: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
      },
      nullable: true,
    },
    buyBonusApi: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
      },
      nullable: true,
    },
  },
};

/** Schema lookup by REGISTRY_FILES key. Only files with formal schemas appear. */
export const SCHEMA_BY_KEY: Record<string, Schema> = {
  meta: META_SCHEMA,
  uiRegistry: UI_REGISTRY_SCHEMA,
  providerCache: PROVIDER_CACHE_SCHEMA,
  parserCache: PARSER_CACHE_SCHEMA,
  gameMechanics: GAME_MECHANICS_SCHEMA,
  timingConfig: TIMING_CONFIG_SCHEMA,
  betControls: BET_CONTROLS_SCHEMA,
  popupKeywords: POPUP_KEYWORDS_SCHEMA,
  subStateHints: SUB_STATE_HINTS_SCHEMA,
  fieldMapping: FIELD_MAPPING_SCHEMA,
  apiMapping: API_MAPPING_SCHEMA,
};
