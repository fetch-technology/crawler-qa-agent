import { instantiateTemplates, type FillContext } from "./template-engine.js";
import { aiAugmentTestcases } from "./ai-augment.js";
import { toYaml } from "./yaml-writer.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { GeneratedTestcase, TestcaseDocument } from "./types.js";

export type GenerateOptions = FillContext & {
  features: FeatureRegistry;
  game: string;
  useAi?: boolean;
};

export async function generateTestcases(opts: GenerateOptions): Promise<TestcaseDocument> {
  const baseCases: GeneratedTestcase[] = instantiateTemplates(opts.features, opts);
  const augmented = opts.useAi ? await aiAugmentTestcases(baseCases) : baseCases;
  return {
    game: opts.game,
    generatedAt: new Date().toISOString(),
    testcases: augmented,
  };
}

export { toYaml, TEMPLATES_BY_FEATURE };
export type { GeneratedTestcase, TestcaseDocument } from "./types.js";
export type { TestcaseTemplate } from "./templates.js";

import { TEMPLATES } from "./templates.js";
const TEMPLATES_BY_FEATURE = (() => {
  const m: Record<string, string[]> = {};
  for (const t of TEMPLATES) {
    (m[t.feature] ??= []).push(t.templateId);
  }
  return m;
})();
