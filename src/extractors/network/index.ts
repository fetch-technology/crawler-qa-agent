import { readHttpJsonl } from "./http-jsonl.js";
import { tryExtractPragmatic } from "./pragmatic.js";
import { tryExtractRevengeGames } from "./revenge-games.js";
import { extractWithAI } from "./ai-generic.js";
import type { ApiSnapshot } from "./types.js";

export type { ApiSnapshot } from "./types.js";

export type ExtractOptions = {
  /** Force AI extractor ngay cả khi deterministic match. Default: false. */
  forceAi?: boolean;
  /** Bỏ qua AI fallback (khi không có deterministic). Default: false. */
  skipAi?: boolean;
};

/**
 * Try deterministic parsers theo thứ tự, fallback AI generic.
 * Trả về null nếu không có endpoint nào nhận được.
 */
export async function extractApiSnapshot(
  httpJsonlPath: string,
  opts: ExtractOptions = {},
): Promise<ApiSnapshot | null> {
  const entries = readHttpJsonl(httpJsonlPath);
  if (entries.length === 0) return null;

  if (!opts.forceAi) {
    // Pragmatic Play
    if (entries.some((e) => /pragmaticplay\.net/i.test(e.url))) {
      const pp = tryExtractPragmatic(entries);
      if (pp) return pp;
    }
    // Revenge Games
    if (entries.some((e) => /revenge-games\.com/i.test(e.url))) {
      const rg = tryExtractRevengeGames(entries);
      if (rg) return rg;
    }
  }

  if (opts.skipAi) return null;
  console.log("[network] No deterministic parser matched — falling back to AI generic extractor");
  return extractWithAI(entries);
}
