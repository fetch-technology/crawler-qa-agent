import { pickMode } from "./mode-detector.js";
import { coldStart } from "./cold-start.js";
import { warmStart } from "./warm-start.js";
import type { PipelineOptions, PipelineResult } from "./types.js";

export async function run(opts: PipelineOptions): Promise<PipelineResult> {
  const { mode, gameSlug } = await pickMode(opts);
  if (mode === "cold") {
    if (!opts.url) throw new Error("Cold-start requires --url");
    return coldStart({ ...opts, gameSlug });
  }
  return warmStart({ ...opts, gameSlug });
}

export type { PipelineOptions, PipelineResult } from "./types.js";
