import type {
  ApiMapping,
  OcrRegions,
  PopupRegions,
  UiRegistry,
} from "../registry/types.js";
import type { FeatureRegistry } from "../step4-feature-discovery/types.js";
import type { GeneratedTestcase, TestcaseId } from "./types.js";
import { TEMPLATES, type TestcaseTemplate } from "./templates.js";

export type FillContext = {
  uiMap: UiRegistry;
  api?: ApiMapping;
  ocrRegions?: OcrRegions;
  popupRegions?: PopupRegions;
  spinCount?: number;
};

export function instantiateTemplates(
  features: FeatureRegistry,
  ctx: FillContext,
): GeneratedTestcase[] {
  const out: GeneratedTestcase[] = [];
  for (const tpl of TEMPLATES) {
    if (tpl.feature !== "core") {
      const f = features.features[tpl.feature];
      if (!f?.present) continue;
    }
    if (!hasRequiredParams(tpl, ctx)) continue;
    out.push(fillTemplate(tpl, ctx));
  }
  return out;
}

function hasRequiredParams(tpl: TestcaseTemplate, ctx: FillContext): boolean {
  for (const p of tpl.parameters) {
    const val = resolveParam(p, ctx);
    if (val === null || val === undefined) return false;
  }
  return true;
}

function resolveParam(name: string, ctx: FillContext): string | null {
  if (name === "spinCount") return String(ctx.spinCount ?? 10000);
  if (name === "spinApi") return ctx.api?.spinApi?.url ?? null;
  if (name === "historyApi") return ctx.api?.historyApi?.url ?? null;
  if (name === "buyBonusApi") return ctx.api?.buyBonusApi?.url ?? null;
  // UI elements
  if (name in ctx.uiMap) {
    const el = ctx.uiMap[name];
    if (el) return `(${el.x},${el.y})`;
  }
  // OCR regions
  if (ctx.ocrRegions && name in ctx.ocrRegions) {
    const r = (ctx.ocrRegions as Record<string, { x: number; y: number; width: number; height: number } | undefined>)[name];
    if (r) return `[${r.x},${r.y},${r.width},${r.height}]`;
  }
  // Popup regions
  if (ctx.popupRegions && name in ctx.popupRegions) {
    const r = (ctx.popupRegions as Record<string, { x: number; y: number; width: number; height: number } | undefined>)[name];
    if (r) return `[${r.x},${r.y},${r.width},${r.height}]`;
  }
  return null;
}

function fillTemplate(tpl: TestcaseTemplate, ctx: FillContext): GeneratedTestcase {
  const interp = (s: string): string =>
    s.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name: string) => {
      const v = resolveParam(name, ctx);
      return v ?? `\${${name}}`;
    });
  return {
    id: tpl.templateId as TestcaseId,
    title: tpl.title,
    category: tpl.category as GeneratedTestcase["category"],
    priority: tpl.priority,
    steps: tpl.steps.map(interp),
    expected: interp(tpl.expected),
  };
}
