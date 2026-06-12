// RTP (logic-level e2e) integration — triggers RG's internal e2e API which
// replays N million spins against the game's LOGIC service (statistical RTP
// validation — the one payout dimension the browser-side tool deliberately
// does NOT cover; per-round/per-combo integrity lives in payout-integrity).
//
// Flow: dashboard [Run RTP] → triggerRtpRuns() fires the RG API twice (base
// command + `--ps=true` variant) → RG runs ~30 min → RG POSTs an event to our
// /api/qa/rtp-callback → recordCallback() matches it to the pending run and
// stores the RAW payload verbatim. No pass/fail interpretation — per client,
// we display the full result as-is until the event schema settles.
//
// Secrets: API key comes from env RG_E2E_API_KEY (never hardcoded). Endpoint
// overridable via RG_E2E_URL.

import { readFile, writeFile, mkdir, appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "../registry/paths.js";

const RTP_FILE = "rtp-runs.json";
const INBOX_DIR = "_rtp-inbox";
const DEFAULT_ENDPOINT = "https://bot.rg-lgna.com/api/v1/internal/e2e-local";
export const DEFAULT_RTP_COMMAND =
  "pnpm e2e --all --ec=volLevel=2&poolHitRate=[0.5,0.7]&hitRate=[0.5,0.7]&featureChance=1 --n=1M";

export type RtpRun = {
  id: string;
  gameSlug: string;
  logicName: string;
  tag: string;
  command: string;
  psVariant: boolean;
  triggeredAt: string;
  /** Raw body the RG trigger API answered with (audit). */
  triggerResponse?: string;
  triggerStatus?: number;
  /** The raw callback event RG sent for this run, verbatim. */
  callback?: { receivedAt: string; raw: string };
};

export type RtpRunsFile = {
  schemaVersion: 1;
  /** Last-used inputs, prefilled on the dashboard. */
  lastTag?: string;
  lastCommand?: string;
  lastLogicName?: string;
  runs: RtpRun[];
};

function rtpFilePath(slug: string): string {
  return path.join(dirForGame(slug), RTP_FILE);
}

export async function loadRtpRuns(slug: string): Promise<RtpRunsFile> {
  try {
    return JSON.parse(await readFile(rtpFilePath(slug), "utf8")) as RtpRunsFile;
  } catch {
    return { schemaVersion: 1, runs: [] };
  }
}

async function saveRtpRuns(slug: string, data: RtpRunsFile): Promise<void> {
  await mkdir(dirForGame(slug), { recursive: true });
  await writeFile(rtpFilePath(slug), JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Look up the game's logic_name + current version (tag) from RG's lookup
 *  API — the AUTHORITATIVE source for both trigger fields:
 *    GET https://ex-logic.dev.revenge-games.com
 *    body { env, game_code } → { logic_name, version }
 *  NOTE: their API is a GET **with a JSON body** — Node's fetch forbids that,
 *  so this uses node:https directly to mirror the curl faithfully. Returns
 *  null on any failure (network, non-JSON, missing fields) — callers fall
 *  back to the capture-derived/guessed chain. Endpoint/env overridable via
 *  RG_LOGIC_LOOKUP_URL / RG_LOGIC_ENV. */
export async function lookupLogicInfo(gameCode: string): Promise<{ logicName: string; version: string } | null> {
  const endpoint = process.env.RG_LOGIC_LOOKUP_URL || "https://ex-logic.dev.revenge-games.com";
  const envName = process.env.RG_LOGIC_ENV || "sandbox";
  try {
    const { request } = await import("node:https");
    const u = new URL(endpoint);
    const body = JSON.stringify({ env: envName, game_code: gameCode });
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: (u.pathname || "/") + u.search,
          method: "GET",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("lookup timeout (10s)")));
      req.write(body);
      req.end();
    });
    const j = JSON.parse(text) as { logic_name?: string; version?: string };
    if (typeof j.logic_name === "string" && j.logic_name) {
      return { logicName: j.logic_name, version: typeof j.version === "string" ? j.version : "" };
    }
    console.warn(`[rtp] logic lookup for "${gameCode}": response missing logic_name — ${text.slice(0, 200)}`);
    return null;
  } catch (err) {
    console.warn(`[rtp] logic lookup for "${gameCode}" failed (falling back to capture/guess): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Derive the game's logic service name from captured network traffic. Some
 *  envs embed it in spin responses (`debug.logic = http://.../logic-<x>-clonedpp...`);
 *  when absent, fall back to the conventional `logic-<slug>-clonedpp` and mark
 *  it guessed — the dashboard input is editable so QA can correct it. */
export async function deriveLogicName(slug: string): Promise<{ logicName: string; derived: boolean }> {
  const pattern = /logic-[a-z0-9-]*cloned[a-z0-9]*/i;
  const candidates: string[] = [];
  const tryScan = async (file: string) => {
    try {
      const txt = await readFile(file, "utf8");
      const m = txt.match(pattern);
      if (m) candidates.push(m[0]);
    } catch { /* absent file — skip */ }
  };
  await tryScan(path.join(dirForGame(slug), "network", "network.jsonl"));
  try {
    const evDir = path.join(dirForGame(slug), "case-evidence");
    for (const f of (await readdir(evDir)).filter((f) => f.endsWith(".network.jsonl")).slice(0, 10)) {
      if (candidates.length > 0) break;
      await tryScan(path.join(evDir, f));
    }
  } catch { /* no case-evidence dir */ }
  if (candidates.length > 0) return { logicName: candidates[0]!, derived: true };
  return { logicName: `logic-${slug}-clonedpp`, derived: false };
}

/** Fire the RG e2e API for one command. Returns the run record (also when the
 *  HTTP call fails — the failure is recorded in triggerResponse, fail-loud). */
async function triggerOne(args: {
  gameSlug: string;
  logicName: string;
  tag: string;
  command: string;
  psVariant: boolean;
}): Promise<RtpRun> {
  const endpoint = process.env.RG_E2E_URL || DEFAULT_ENDPOINT;
  const apiKey = process.env.RG_E2E_API_KEY;
  const run: RtpRun = {
    id: `rtp-${Date.now()}-${args.psVariant ? "ps" : "base"}`,
    gameSlug: args.gameSlug,
    logicName: args.logicName,
    tag: args.tag,
    command: args.command,
    psVariant: args.psVariant,
    triggeredAt: new Date().toISOString(),
  };
  if (!apiKey) {
    run.triggerStatus = 0;
    run.triggerResponse = "RG_E2E_API_KEY env var not set — trigger NOT sent. Set it and restart the server.";
    return run;
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ logic_name: args.logicName, command: args.command, tag: args.tag }),
    });
    run.triggerStatus = res.status;
    run.triggerResponse = (await res.text()).slice(0, 4000);
  } catch (err) {
    run.triggerStatus = 0;
    run.triggerResponse = `trigger failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return run;
}

/** Trigger BOTH commands (base + --ps=true) for a game and persist the runs.
 *  logicName/tag resolution: explicit args win (QA edited the fields), else
 *  the RG lookup API (authoritative), else capture-scan/convention for the
 *  name — and a hard error for the tag, since a guessed version would silently
 *  test the wrong build. */
export async function triggerRtpRuns(args: {
  gameSlug: string;
  tag?: string;
  command?: string;
  logicName?: string;
}): Promise<{ ok: boolean; runs: RtpRun[]; logicName: string; derived: boolean; tag?: string; reason?: string }> {
  const base = (args.command ?? DEFAULT_RTP_COMMAND).trim();
  const needLookup = !args.logicName || !args.tag?.trim();
  const looked = needLookup ? await lookupLogicInfo(args.gameSlug) : null;
  const derived = args.logicName
    ? { logicName: args.logicName, derived: true }
    : looked
      ? { logicName: looked.logicName, derived: true }
      : await deriveLogicName(args.gameSlug);
  const tag = args.tag?.trim() || looked?.version || "";
  if (!tag) {
    return { ok: false, runs: [], logicName: derived.logicName, derived: derived.derived, reason: "tag (game version) unknown: lookup API gave no version and none was provided — enter it manually" };
  }
  const psCommand = /\s--ps=true\b/.test(base) ? base : `${base} --ps=true`;
  const runs = [
    await triggerOne({ gameSlug: args.gameSlug, logicName: derived.logicName, tag, command: base, psVariant: false }),
    await triggerOne({ gameSlug: args.gameSlug, logicName: derived.logicName, tag, command: psCommand, psVariant: true }),
  ];
  const file = await loadRtpRuns(args.gameSlug);
  file.runs.push(...runs);
  file.lastTag = tag;
  file.lastCommand = base;
  file.lastLogicName = derived.logicName;
  await saveRtpRuns(args.gameSlug, file);
  const failed = runs.filter((r) => !r.triggerStatus || r.triggerStatus >= 400);
  return {
    ok: failed.length === 0,
    runs,
    logicName: derived.logicName,
    derived: derived.derived,
    tag,
    reason: failed.length > 0 ? `trigger failed for ${failed.length}/2 command(s) — see triggerResponse` : undefined,
  };
}

/** Parse whatever shape the callback event arrives in (JSON object or the
 *  plain-text `TAG: ... SERVICE: ... COMMAND: ... OUTPUT_URL: ...` block) into
 *  match keys. Pure — exported for tests. */
export function parseRtpEvent(raw: string): { tag?: string; service?: string; command?: string } {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = j[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return undefined;
    };
    const tag = pick("tag", "TAG", "version");
    const service = pick("service", "SERVICE", "logic_name", "logicName");
    const command = pick("command", "COMMAND");
    if (tag || service || command) return { tag, service, command };
  } catch { /* not JSON — fall through to text parse */ }
  const line = (label: string): string | undefined =>
    raw.match(new RegExp(`${label}\\s*:\\s*(.+)`, "i"))?.[1]?.trim();
  return { tag: line("TAG"), service: line("SERVICE"), command: line("COMMAND") };
}

/** Record an incoming RG callback. Every event is appended verbatim to the
 *  global inbox (audit — nothing is ever silently dropped); when its
 *  SERVICE/TAG/COMMAND match a pending run, the raw payload is attached to
 *  that run so the dashboard shows it under the right game. */
export async function recordCallback(raw: string): Promise<{
  matched: boolean;
  gameSlug?: string;
  runId?: string;
}> {
  // 1. Always append to the inbox first.
  const inboxDir = dirForGame(INBOX_DIR);
  await mkdir(inboxDir, { recursive: true });
  await appendFile(
    path.join(inboxDir, "events.jsonl"),
    JSON.stringify({ receivedAt: new Date().toISOString(), raw }) + "\n",
    "utf8",
  );

  // 2. Try to match a pending run by SERVICE (+ tag, + ps-variant from command).
  const ev = parseRtpEvent(raw);
  if (!ev.service) return { matched: false };
  const registryRoot = path.dirname(dirForGame("x"));
  let slugs: string[] = [];
  try {
    slugs = (await readdir(registryRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name);
  } catch { return { matched: false }; }

  for (const slug of slugs) {
    const file = await loadRtpRuns(slug);
    if (file.runs.length === 0) continue;
    const evPs = ev.command ? /--ps=true\b/.test(ev.command) : null;
    // Newest-first: re-runs with the same tag should attach to the latest.
    const candidates = [...file.runs].reverse().filter((r) =>
      !r.callback &&
      r.logicName === ev.service &&
      (ev.tag == null || r.tag === ev.tag) &&
      (evPs == null || r.psVariant === evPs),
    );
    const run = candidates[0];
    if (run) {
      run.callback = { receivedAt: new Date().toISOString(), raw };
      await saveRtpRuns(slug, file);
      return { matched: true, gameSlug: slug, runId: run.id };
    }
  }
  return { matched: false };
}
