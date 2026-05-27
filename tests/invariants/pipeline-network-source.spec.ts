// INVARIANT — pipeline → legacy HttpEntry adapter
//
// The statistical simulator originally read flat `http.jsonl` entries from
// `fixtures/recordings/<slug>__<ts>/`. The pipeline writes grouped
// `network.jsonl` (one NetworkRound per spin) to a different path. This
// adapter flattens pipeline rounds into the legacy entry shape so
// simulate.ts works on pipeline data without rewriting the template logic.

import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pipelineCapturePath,
  readNetworkRounds,
  adaptPipelineCaptureToEntries,
} from "../../src/statistical/pipeline-network-source.ts";

function withSlug(slug: string, networkJsonl: string, fn: () => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "pipe-net-"));
  const cwd = process.cwd();
  try {
    process.chdir(tmp);
    mkdirSync(join("fixtures", "registry", slug, "network"), { recursive: true });
    writeFileSync(
      join("fixtures", "registry", slug, "network", "network.jsonl"),
      networkJsonl,
    );
    fn();
  } finally {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("pipelineCapturePath: returns null when missing", () => {
  expect(pipelineCapturePath("nonexistent-slug-zzz")).toBeNull();
});

test("pipelineCapturePath: returns absolute path when exists", () => {
  withSlug("test-game-1", '{"index":0,"requests":[],"responses":[],"wsFrames":[],"screenshots":[]}\n', () => {
    const p = pipelineCapturePath("test-game-1");
    expect(p).not.toBeNull();
    expect(p).toMatch(/fixtures\/registry\/test-game-1\/network\/network\.jsonl$/);
  });
});

test("readNetworkRounds: parses NetworkRound array", () => {
  const jsonl = [
    JSON.stringify({ index: 0, requests: [{ url: "https://x/spin", method: "POST", headers: {}, body: "a=doSpin&c=0.5", timestamp: 100 }], responses: [{ url: "https://x/spin", status: 200, headers: {}, body: "tw=0&bb=100&ba=99.5", timing: { startedAt: 100, finishedAt: 150 } }], wsFrames: [], screenshots: [] }),
    JSON.stringify({ index: 1, requests: [{ url: "https://x/spin", method: "POST", headers: {}, body: "a=doSpin&c=0.5", timestamp: 200 }], responses: [{ url: "https://x/spin", status: 200, headers: {}, body: "tw=1&bb=99.5&ba=100", timing: { startedAt: 200, finishedAt: 250 } }], wsFrames: [], screenshots: [] }),
  ].join("\n");
  withSlug("test-game-2", jsonl, () => {
    const rounds = readNetworkRounds("test-game-2");
    expect(rounds.length).toBe(2);
    expect(rounds[0]!.requests[0]!.body).toBe("a=doSpin&c=0.5");
  });
});

test("readNetworkRounds: returns [] for missing slug", () => {
  expect(readNetworkRounds("nonexistent-zzz-yyy")).toEqual([]);
});

test("readNetworkRounds: tolerates malformed jsonl lines", () => {
  withSlug("test-game-3", '{"index":0,"requests":[],"responses":[],"wsFrames":[],"screenshots":[]}\nNOT_JSON\n{"index":1,"requests":[],"responses":[],"wsFrames":[],"screenshots":[]}\n', () => {
    const rounds = readNetworkRounds("test-game-3");
    expect(rounds.length).toBe(2);
  });
});

test("adaptPipelineCaptureToEntries: flattens request+response pairs in order", () => {
  const jsonl = JSON.stringify({
    index: 0,
    requests: [{ url: "https://x/spin", method: "POST", headers: { "user-agent": "ua" }, body: "a=doSpin", timestamp: 1000 }],
    responses: [{ url: "https://x/spin", status: 200, headers: { "content-type": "text/plain" }, body: "tw=0", timing: { startedAt: 1000, finishedAt: 1050 } }],
    wsFrames: [],
    screenshots: [],
  }) + "\n";
  withSlug("test-game-4", jsonl, () => {
    const entries = adaptPipelineCaptureToEntries("test-game-4");
    expect(entries.length).toBe(2);
    expect(entries[0]!.phase).toBe("request");
    expect(entries[0]!.method).toBe("POST");
    expect(entries[0]!.url).toBe("https://x/spin");
    expect(entries[0]!.postData).toBe("a=doSpin");
    expect(entries[1]!.phase).toBe("response");
    expect(entries[1]!.status).toBe(200);
    expect(entries[1]!.body).toBe("tw=0");
    // Regression: response MUST carry method copied from matching request,
    // otherwise simulate's findSpinTemplate can't pair request↔response.
    expect(entries[1]!.method).toBe("POST");
  });
});

test("adaptPipelineCaptureToEntries: response method copied from matching request URL", () => {
  const jsonl = JSON.stringify({
    index: 0,
    requests: [
      { url: "https://x/spin", method: "POST", headers: {}, body: "a=doSpin", timestamp: 1000 },
      { url: "https://x/assets/sound.ogg", method: "GET", headers: {}, body: null, timestamp: 1010 },
    ],
    responses: [
      { url: "https://x/spin", status: 200, headers: {}, body: "tw=0", timing: { startedAt: 1000, finishedAt: 1050 } },
      { url: "https://x/assets/sound.ogg", status: 200, headers: {}, body: "ogg-bytes", timing: { startedAt: 1010, finishedAt: 1030 } },
    ],
    wsFrames: [],
    screenshots: [],
  }) + "\n";
  withSlug("test-game-pairing", jsonl, () => {
    const entries = adaptPipelineCaptureToEntries("test-game-pairing");
    const responses = entries.filter((e) => e.phase === "response");
    expect(responses.length).toBe(2);
    const spinResp = responses.find((r) => r.url === "https://x/spin");
    const assetResp = responses.find((r) => r.url === "https://x/assets/sound.ogg");
    expect(spinResp?.method).toBe("POST"); // copied from POST spin request
    expect(assetResp?.method).toBe("GET"); // copied from GET asset request
  });
});

test("adaptPipelineCaptureToEntries: orphan response (no matching request) defaults to POST", () => {
  const jsonl = JSON.stringify({
    index: 0,
    requests: [],
    responses: [{ url: "https://x/spin", status: 200, headers: {}, body: "tw=0", timing: { startedAt: 1000, finishedAt: 1050 } }],
    wsFrames: [],
    screenshots: [],
  }) + "\n";
  withSlug("test-game-orphan", jsonl, () => {
    const entries = adaptPipelineCaptureToEntries("test-game-orphan");
    expect(entries.length).toBe(1);
    expect(entries[0]!.method).toBe("POST"); // safe default for spin endpoints
  });
});

test("adaptPipelineCaptureToEntries: empty array when slug missing", () => {
  const entries = adaptPipelineCaptureToEntries("does-not-exist");
  expect(entries).toEqual([]);
});

test("adaptPipelineCaptureToEntries: handles round with no requests OR responses gracefully", () => {
  const jsonl = JSON.stringify({ index: 0, requests: [], responses: [], wsFrames: [], screenshots: [] }) + "\n";
  withSlug("test-game-5", jsonl, () => {
    const entries = adaptPipelineCaptureToEntries("test-game-5");
    expect(entries).toEqual([]);
  });
});

test("adaptPipelineCaptureToEntries: preserves per-round order (all reqs of N before resps of N before round N+1)", () => {
  const r0 = JSON.stringify({
    index: 0,
    requests: [
      { url: "/a", method: "POST", headers: {}, body: "r0a", timestamp: 1 },
      { url: "/b", method: "POST", headers: {}, body: "r0b", timestamp: 2 },
    ],
    responses: [
      { url: "/a", status: 200, headers: {}, body: "resp-r0a", timing: { startedAt: 1, finishedAt: 3 } },
      { url: "/b", status: 200, headers: {}, body: "resp-r0b", timing: { startedAt: 2, finishedAt: 4 } },
    ],
    wsFrames: [], screenshots: [],
  });
  const r1 = JSON.stringify({
    index: 1,
    requests: [{ url: "/a", method: "POST", headers: {}, body: "r1a", timestamp: 10 }],
    responses: [{ url: "/a", status: 200, headers: {}, body: "resp-r1a", timing: { startedAt: 10, finishedAt: 12 } }],
    wsFrames: [], screenshots: [],
  });
  withSlug("test-game-6", `${r0}\n${r1}\n`, () => {
    const entries = adaptPipelineCaptureToEntries("test-game-6");
    expect(entries.map((e) => `${e.phase}:${e.postData ?? e.body}`)).toEqual([
      "request:r0a",
      "request:r0b",
      "response:resp-r0a",
      "response:resp-r0b",
      "request:r1a",
      "response:resp-r1a",
    ]);
  });
});
