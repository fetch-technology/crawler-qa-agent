// INVARIANT — discovery snapshot storage round-trips correctly.
//
// Snapshots are the visual ground truth QA reviews after AI discovery: the
// dashboard reads each manifest + image to render markers over a screenshot.
// If save/load drift (wrong path encoding, manifest field name change, lost
// element coords) the panel either misses states or draws markers in the
// wrong place — silently misleading the QA verifier. Pin the contract.

import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  saveDiscoverySnapshot,
  listDiscoverySnapshots,
  loadDiscoverySnapshotImage,
  type SnapshotElement,
} from "../../src/pipeline/registry/discovery-snapshots.js";

// The store derives paths from dirForGame(slug) which captures CWD at module
// load — so per-test isolation comes from per-test UNIQUE slugs, with a
// finally-block cleanup to keep fixtures/ tidy.
function uniqSlug(label: string): string {
  return `__test-snap-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function cleanup(slug: string): Promise<void> {
  const dir = path.resolve(process.cwd(), "fixtures", "registry", slug);
  await rm(dir, { recursive: true, force: true });
}

// A 1x1 transparent PNG — small but valid.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const ELEMENTS: SnapshotElement[] = [
  { key: "spinButton", x: 100, y: 200, confidence: 0.9, role: "spin" },
  { key: "menu__closeButton", x: 50, y: 50, role: "close" },
];

test("save -> list -> loadImage round-trips with full manifest", async () => {
  const slug = uniqSlug("roundtrip");
  try {
    await saveDiscoverySnapshot(slug, "main", TINY_PNG, ELEMENTS, "explore-graph-main");
    const all = await listDiscoverySnapshots(slug);
    expect(all).toHaveLength(1);
    const m = all[0]!;
    expect(m.stateId).toBe("main");
    expect(m.source).toBe("explore-graph-main");
    expect(m.elementCount).toBe(2);
    expect(m.elements[0]).toMatchObject({ key: "spinButton", x: 100, y: 200, confidence: 0.9, role: "spin" });
    expect(typeof m.capturedAt).toBe("string");
    const img = await loadDiscoverySnapshotImage(slug, "main");
    expect(img).not.toBeNull();
    expect(img!.length).toBe(TINY_PNG.length);
  } finally {
    await cleanup(slug);
  }
});

test("re-saving same stateId OVERWRITES (latest wins)", async () => {
  const slug = uniqSlug("overwrite");
  try {
    await saveDiscoverySnapshot(slug, "menu", TINY_PNG, [{ key: "a", x: 1, y: 2 }], "discover-substate");
    await saveDiscoverySnapshot(slug, "menu", TINY_PNG, [{ key: "a", x: 1, y: 2 }, { key: "b", x: 3, y: 4 }], "discover-substate");
    const all = await listDiscoverySnapshots(slug);
    expect(all).toHaveLength(1);
    expect(all[0]!.elementCount).toBe(2);
  } finally {
    await cleanup(slug);
  }
});

test("multiple states stored independently; list sorted newest-first", async () => {
  const slug = uniqSlug("multi");
  try {
    await saveDiscoverySnapshot(slug, "menu", TINY_PNG, [], "discover-substate");
    await new Promise((r) => setTimeout(r, 10));
    await saveDiscoverySnapshot(slug, "paytable", TINY_PNG, [], "discover-substate");
    const all = await listDiscoverySnapshots(slug);
    expect(all.map((m) => m.stateId)).toEqual(["paytable", "menu"]);
  } finally {
    await cleanup(slug);
  }
});

test("unsafe stateId chars are sanitized (no path traversal, no separator)", async () => {
  const slug = uniqSlug("sanitize");
  try {
    await saveDiscoverySnapshot(slug, "../../etc/passwd", TINY_PNG, [], "discover-substate");
    const all = await listDiscoverySnapshots(slug);
    expect(all).toHaveLength(1);
    expect(all[0]!.stateId).not.toContain("/");
    expect(all[0]!.stateId).not.toContain("..");
  } finally {
    await cleanup(slug);
  }
});

test("listDiscoverySnapshots on game with no snapshots returns []", async () => {
  const slug = uniqSlug("empty");
  // No save → directory doesn't exist → list should return [] (not throw).
  expect(await listDiscoverySnapshots(slug)).toEqual([]);
});

test("loadDiscoverySnapshotImage returns null when missing", async () => {
  const slug = uniqSlug("missing");
  try {
    await saveDiscoverySnapshot(slug, "main", TINY_PNG, [], "discover-substate");
    expect(await loadDiscoverySnapshotImage(slug, "nope")).toBeNull();
  } finally {
    await cleanup(slug);
  }
});
