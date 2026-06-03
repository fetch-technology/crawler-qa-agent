import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { GameSlug } from "./types.js";

const ROOT = path.resolve(process.cwd(), "fixtures", "registry");

export function dirForGame(slug: GameSlug): string {
  return path.join(ROOT, slug);
}

export async function ensureDir(slug: GameSlug): Promise<string> {
  const dir = dirForGame(slug);
  await mkdir(dir, { recursive: true });
  return dir;
}

export const REGISTRY_FILES = {
  uiRegistry: "ui-registry.json",
  providerCache: "provider-cache.json",
  apiMapping: "api-mapping.json",
  fieldMapping: "field-mapping.json",
  gameMechanics: "game-mechanics.json",
  timingConfig: "timing-config.json",
  betControls: "bet-controls.json",
  popupKeywords: "popup-keywords.json",
  subStateHints: "sub-state-hints.json",
  expectedUiElements: "expected-ui-elements.json",
  parserCache: "parser.json",
  ocrRegions: "ocr-regions.json",
  stateSignatures: "state-signatures.json",
  paytable: "paytable.json",
  payoutModel: "payout-model.json",
  popupRegions: "popup-regions.json",
  featureRegistry: "feature-registry.json",
  uiGraph: "ui-graph.json",
  testcases: "testcases.yaml",
  meta: "_meta.json",
  gameSpecOverride: "game-spec-override.json",
} as const;

export function fileForGame(slug: GameSlug, key: keyof typeof REGISTRY_FILES): string {
  return path.join(dirForGame(slug), REGISTRY_FILES[key]);
}

export const SCHEMA_VERSION = 1;
