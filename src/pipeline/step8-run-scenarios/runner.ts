import type { Page } from "playwright";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { ApiMapping, UiRegistry } from "../registry/types.js";
import type { CaptureHandle } from "../step3-capture-network/types.js";
import { runUiMode } from "./ui-mode.js";
import { runApiMode } from "./api-mode.js";
import type { MassiveSpinOptions, MassiveSpinResult, SpinMode } from "./types.js";

const UI_API_THRESHOLD = 200;

export type RunnerContext = {
  gameSlug: string;
  page?: Page;
  uiMap?: UiRegistry;
  capture?: CaptureHandle;
  api?: ApiMapping;
  parser: BaseParser;
  /** Pass-through to api-mode: enable cascade-tail fetching in simulate. */
  cascade?: boolean;
};

export async function runMassiveSpins(
  ctx: RunnerContext,
  opts: MassiveSpinOptions,
): Promise<MassiveSpinResult> {
  const mode: SpinMode = opts.mode ?? (opts.count <= UI_API_THRESHOLD ? "ui" : "api");
  if (mode === "ui") {
    if (!ctx.page || !ctx.uiMap || !ctx.capture)
      throw new Error("UI mode requires page + uiMap + capture");
    return runUiMode(ctx.page, ctx.uiMap, ctx.capture, ctx.parser, opts);
  }
  if (!ctx.api) throw new Error("API mode requires api mapping");
  return runApiMode(
    { gameSlug: ctx.gameSlug, api: ctx.api, parser: ctx.parser, cascade: ctx.cascade },
    opts,
  );
}
