// Per-state snapshot store for AI-driven UI discovery. For every state AI
// labels (main, sub-state popups, deep-recursive states), we persist (a) the
// raw PNG that the AI saw and (b) a manifest of the elements it returned with
// their coords + role + confidence. The dashboard renders the PNG with SVG
// overlays so QA can spot-check "what AI thinks is on this screen" visually
// at every level — no need to navigate the live browser.
//
// Storage:
//   fixtures/registry/<slug>/discovery-snapshots/<safeStateId>.png
//   fixtures/registry/<slug>/discovery-snapshots/<safeStateId>.json
// Re-discovering a state OVERWRITES its prior snapshot (latest wins).

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "./paths.js";

export type SnapshotElement = {
  key: string;
  x: number;
  y: number;
  confidence?: number;
  role?: string;
};

export type SnapshotManifest = {
  stateId: string;
  capturedAt: string;
  /** Source flow that produced the snapshot — useful when filtering or
   *  diagnosing (e.g. why a state appeared from the recursive explorer vs a
   *  one-off QA-triggered discover). */
  source: "discover-substate" | "explore-graph" | "explore-graph-main";
  imageWidth?: number;
  imageHeight?: number;
  elementCount: number;
  elements: SnapshotElement[];
};

const SUBDIR = "discovery-snapshots";

function safeId(stateId: string): string {
  return stateId
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    // Defense-in-depth: even within the allowed charset, collapse any `..`
    // run so a stateId can never look like a parent-dir traversal.
    .replace(/\.\.+/g, "_")
    .slice(0, 200) || "unnamed";
}

function pathsFor(slug: string, stateId: string): { dir: string; png: string; json: string } {
  const dir = path.join(dirForGame(slug), SUBDIR);
  const id = safeId(stateId);
  return { dir, png: path.join(dir, `${id}.png`), json: path.join(dir, `${id}.json`) };
}

/** Persist a state snapshot (PNG + manifest). Idempotent per stateId. */
export async function saveDiscoverySnapshot(
  slug: string,
  stateId: string,
  pngBuf: Buffer,
  elements: SnapshotElement[],
  source: SnapshotManifest["source"],
  imageDims?: { width: number; height: number },
): Promise<void> {
  const { dir, png, json } = pathsFor(slug, stateId);
  await mkdir(dir, { recursive: true });
  await writeFile(png, pngBuf);
  const manifest: SnapshotManifest = {
    stateId: safeId(stateId),
    capturedAt: new Date().toISOString(),
    source,
    imageWidth: imageDims?.width,
    imageHeight: imageDims?.height,
    elementCount: elements.length,
    elements,
  };
  await writeFile(json, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** List all snapshots for a game (newest-first by capturedAt). Returns []
 *  when none exist. Manifests with malformed JSON are skipped. */
export async function listDiscoverySnapshots(slug: string): Promise<SnapshotManifest[]> {
  const { dir } = pathsFor(slug, "_");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const manifests: SnapshotManifest[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      manifests.push(JSON.parse(raw) as SnapshotManifest);
    } catch {
      /* skip malformed */
    }
  }
  manifests.sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""));
  return manifests;
}

/** Load the raw PNG bytes for one snapshot. Returns null when missing. */
export async function loadDiscoverySnapshotImage(slug: string, stateId: string): Promise<Buffer | null> {
  const { png } = pathsFor(slug, stateId);
  try {
    return await readFile(png);
  } catch {
    return null;
  }
}
