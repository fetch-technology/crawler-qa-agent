import { registryExists } from "../registry/exists.js";
import { deriveSlug } from "../step1-crawl/crawler.js";
import type { PipelineOptions } from "./types.js";

export type Mode = "cold" | "warm";

export async function pickMode(opts: PipelineOptions): Promise<{ mode: Mode; gameSlug: string }> {
  let slug = opts.gameSlug;
  if (!slug && opts.url) slug = deriveSlug(opts.url);
  if (!slug) throw new Error("Must provide either --game <slug> or --url <url>");
  const exists = await registryExists(slug);
  return { mode: exists ? "warm" : "cold", gameSlug: slug };
}
