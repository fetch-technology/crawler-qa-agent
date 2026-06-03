// Phase: persist-network — attach a Playwright response listener for the
// duration of a callback, collect spin-relevant requests/responses, build
// canonical NetworkRound shape, persist to
// fixtures/registry/<slug>/network/network.jsonl.
//
// Why: cold-start writes network.jsonl in this canonical format (one round
// per game-action). Auto-Onboard's calibrate phase fires K×2 spins but the
// captures only land in case-evidence/<id>.network.jsonl (per-case format,
// different shape). Catalog gen reads both, but the canonical file is the
// source of truth — having Auto-Onboard write it means a subsequent
// catalog regen has the data without needing case-evidence.
//
// Usage: wrap a spin-firing operation with `withNetworkPersist`:
//   await withNetworkPersist({ page, gameSlug }, async () => {
//     await runManySpins(...);   // listener captures during this
//   });
// On exit, persists all captured rounds + detaches listener.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Request, Response } from "playwright";
import { dirForGame } from "../registry/paths.js";
import type { NetworkRound, CapturedRequest, CapturedResponse } from "../step3-capture-network/types.js";
import type { PhaseResult } from "./types.js";

export type PhasePersistNetworkResult = PhaseResult & {
  /** Rounds appended this run. */
  roundsAppended?: number;
  /** Total rounds in file after append. */
  totalRoundsOnDisk?: number;
};

/**
 * Run `work` while collecting spin-relevant network responses (matches
 * /gameService|doSpin/ URLs). Each spin POST + its response becomes one
 * NetworkRound. After `work` resolves, persist all rounds to the canonical
 * `network/network.jsonl` (append mode — preserves prior runs).
 *
 * Listener is auto-detached on success OR throw — safe to wrap any
 * spin-firing logic.
 */
export async function withNetworkPersist<T>(
  args: { page: Page; gameSlug: string },
  work: () => Promise<T>,
): Promise<{ workResult: T; persist: PhasePersistNetworkResult }> {
  const t0 = Date.now();
  const { page, gameSlug } = args;
  // Map keyed by request URL+timestamp so the response handler can find the
  // paired request and emit one round. Simpler approach: track recent
  // requests in an array; pair each response to the latest unpaired request
  // whose URL matches.
  type Pending = { req: CapturedRequest; reqUrl: string };
  const pending: Pending[] = [];
  const rounds: NetworkRound[] = [];

  const onRequest = (req: Request): void => {
    try {
      const url = req.url();
      if (!/gameService|doSpin/i.test(url)) return;
      if (req.method() !== "POST") return;
      const body = req.postData();
      pending.push({
        req: {
          url, method: req.method(), headers: {}, body: body ?? null, timestamp: Date.now(),
        },
        reqUrl: url,
      });
    } catch { /* ignore */ }
  };

  const onResponse = async (res: Response): Promise<void> => {
    try {
      const url = res.url();
      if (!/gameService|doSpin/i.test(url)) return;
      if (res.request().method() !== "POST") return;
      const body = await res.text().catch(() => "");
      const captured: CapturedResponse = {
        url, status: res.status(), headers: {}, body,
        timing: { startedAt: 0, finishedAt: Date.now() },
      };
      // Pair with the most recent pending request for the same URL.
      const reqIdx = pending.findIndex((p) => p.reqUrl === url);
      const req: CapturedRequest = reqIdx >= 0 ? pending.splice(reqIdx, 1)[0]!.req : {
        url, method: "POST", headers: {}, body: null, timestamp: 0,
      };
      rounds.push({
        index: rounds.length,
        requests: [req],
        responses: [captured],
        wsFrames: [],
        screenshots: [],
      });
    } catch { /* ignore */ }
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  // Inner helper — writes whatever rounds were captured. Called from both
  // success + failure paths so captures aren't lost when `work()` throws
  // (e.g. calibrate spins partway then hits an unexpected popup → captured
  // 5 useful rounds → caller would lose them without this).
  const flushRounds = async (): Promise<{ roundsAppended: number; totalRoundsOnDisk: number | undefined }> => {
    if (rounds.length === 0) return { roundsAppended: 0, totalRoundsOnDisk: undefined };
    const dir = path.join(dirForGame(gameSlug), "network");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "network.jsonl");
    let existing = "";
    try { existing = await readFile(file, "utf8"); } catch { /* first run */ }
    const priorCount = existing ? existing.split("\n").filter((l) => l.trim()).length : 0;
    const lines = rounds
      .map((r, i) => JSON.stringify({ ...r, index: priorCount + i }))
      .join("\n");
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(file, existing + sep + lines + "\n", "utf8");
    return { roundsAppended: rounds.length, totalRoundsOnDisk: priorCount + rounds.length };
  };

  let workResult: T;
  let workError: unknown = null;
  try {
    workResult = await work();
  } catch (err) {
    workError = err;
    workResult = undefined as unknown as T;
  }
  // Detach listeners BEFORE the file write so subsequent code (in caller)
  // can attach its own listener without seeing duplicates.
  page.off("request", onRequest);
  page.off("response", onResponse);

  // Persist whatever was captured regardless of work() success — captures
  // mid-run before a throw are still valuable for catalog gen.
  let persistInfo: { roundsAppended: number; totalRoundsOnDisk: number | undefined };
  try {
    persistInfo = await flushRounds();
  } catch (err) {
    // Persist itself failed (disk full, permission). Rare. Re-throw the
    // ORIGINAL work error if any (more informative) else this one.
    if (workError) throw workError;
    throw err;
  }
  // If work() threw, rethrow now (after persist) so caller's try/catch
  // still sees the original error — they can inspect what was captured
  // via a follow-up disk read if needed.
  if (workError) throw workError;
  return {
    workResult,
    persist: {
      ok: true,
      roundsAppended: persistInfo.roundsAppended,
      totalRoundsOnDisk: persistInfo.totalRoundsOnDisk,
      note: persistInfo.roundsAppended === 0 ? "no spin responses captured" : undefined,
      durationMs: Date.now() - t0,
    },
  };
}
