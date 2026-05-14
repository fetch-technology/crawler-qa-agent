import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { GameSpec } from "./authoring.js";
import type { TestCase, TestCaseCatalog } from "./test-catalog.js";

export type SnapshotMode = "fresh" | "update" | "accept" | "ci";

const FIELDS_TRACKED: Array<keyof TestCase> = [
  "category",
  "severity",
  "setup_instructions",
  "expected_bet",
  "expected_config",
  "spin_count",
  "expected_feature",
  "invariant_ids",
  "custom_assertions",
];

export type CatalogDiff = {
  added: TestCase[];
  removed: TestCase[];
  changed: Array<{
    id: string;
    fields_changed: string[];
    before: TestCase;
    after: TestCase;
  }>;
  unchanged: number;
  spec_changed: boolean;
  spec_hash_before: string | null;
  spec_hash_after: string;
};

function hashSpec(spec: GameSpec): string {
  const sorted = JSON.stringify(spec, Object.keys(spec).sort());
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function caseKey(c: TestCase): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS_TRACKED) {
    out[f as string] = (c as Record<string, unknown>)[f as string] ?? null;
  }
  return out;
}

function fieldsDiffer(a: TestCase, b: TestCase): string[] {
  const changed: string[] = [];
  const aKey = caseKey(a);
  const bKey = caseKey(b);
  for (const f of FIELDS_TRACKED) {
    const av = JSON.stringify(aKey[f as string]);
    const bv = JSON.stringify(bKey[f as string]);
    if (av !== bv) changed.push(f as string);
  }
  return changed;
}

export function diffCatalog(args: {
  before: TestCaseCatalog | null;
  after: TestCaseCatalog;
  specHashBefore: string | null;
  specHashAfter: string;
}): CatalogDiff {
  const beforeMap = new Map<string, TestCase>();
  for (const c of args.before?.cases ?? []) beforeMap.set(c.id, c);
  const afterMap = new Map<string, TestCase>();
  for (const c of args.after.cases) afterMap.set(c.id, c);

  const added: TestCase[] = [];
  const removed: TestCase[] = [];
  const changed: CatalogDiff["changed"] = [];
  let unchanged = 0;

  for (const [id, after] of afterMap) {
    const before = beforeMap.get(id);
    if (!before) {
      added.push(after);
      continue;
    }
    const fc = fieldsDiffer(before, after);
    if (fc.length === 0) {
      unchanged++;
    } else {
      changed.push({ id, fields_changed: fc, before, after });
    }
  }
  for (const [id, before] of beforeMap) {
    if (!afterMap.has(id)) removed.push(before);
  }

  return {
    added,
    removed,
    changed,
    unchanged,
    spec_changed: args.specHashBefore !== null && args.specHashBefore !== args.specHashAfter,
    spec_hash_before: args.specHashBefore,
    spec_hash_after: args.specHashAfter,
  };
}

export function formatDiff(diff: CatalogDiff): string {
  const lines: string[] = [];
  lines.push(
    `spec_hash: ${diff.spec_hash_before ?? "<none>"} → ${diff.spec_hash_after}` +
      (diff.spec_changed ? " (changed)" : diff.spec_hash_before ? " (unchanged)" : ""),
  );
  lines.push(
    `cases: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.changed.length} changed, =${diff.unchanged} unchanged`,
  );
  if (diff.added.length > 0) {
    lines.push("ADDED:");
    for (const c of diff.added) lines.push(`  + ${c.id} (${c.category}, ${c.severity})`);
  }
  if (diff.removed.length > 0) {
    lines.push("REMOVED:");
    for (const c of diff.removed) lines.push(`  - ${c.id} (${c.category}, ${c.severity})`);
  }
  if (diff.changed.length > 0) {
    lines.push("CHANGED:");
    for (const ch of diff.changed) {
      lines.push(`  ~ ${ch.id} fields=[${ch.fields_changed.join(", ")}]`);
    }
  }
  if (!diff.spec_changed && diff.spec_hash_before !== null && (diff.added.length || diff.removed.length || diff.changed.length)) {
    lines.push(
      "⚠ spec hash unchanged but catalog drifted — likely LLM non-determinism. Review carefully before accepting.",
    );
  }
  return lines.join("\n");
}

export type ReconcileResult =
  | { kind: "fresh"; wrote: string; diff: CatalogDiff }
  | { kind: "no-change"; diff: CatalogDiff }
  | { kind: "pending"; pendingPath: string; diff: CatalogDiff }
  | { kind: "accepted"; wrote: string; diff: CatalogDiff }
  | { kind: "ci-fail"; diff: CatalogDiff };

export type ReconcileArgs = {
  catalog: TestCaseCatalog;
  spec: GameSpec;
  snapshotPath: string;
  mode: SnapshotMode;
};

export function reconcileSnapshot(args: ReconcileArgs): ReconcileResult {
  const { catalog, spec, snapshotPath, mode } = args;
  const pendingPath = snapshotPath.replace(/\.json$/, ".pending.json");
  const specHashAfter = hashSpec(spec);

  let before: TestCaseCatalog | null = null;
  let specHashBefore: string | null = null;
  if (existsSync(snapshotPath)) {
    try {
      const raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as TestCaseCatalog & {
        _snapshot_meta?: { spec_hash: string };
      };
      before = raw;
      specHashBefore = raw._snapshot_meta?.spec_hash ?? null;
    } catch {
      before = null;
    }
  }

  const diff = diffCatalog({
    before,
    after: catalog,
    specHashBefore,
    specHashAfter,
  });

  if (mode === "ci") {
    const drifted = diff.added.length + diff.removed.length + diff.changed.length > 0;
    if (drifted) return { kind: "ci-fail", diff };
    return { kind: "no-change", diff };
  }

  if (!before) {
    writeSnapshot(snapshotPath, catalog, specHashAfter);
    return { kind: "fresh", wrote: snapshotPath, diff };
  }

  const drifted = diff.added.length + diff.removed.length + diff.changed.length > 0;

  if (mode === "accept") {
    if (existsSync(pendingPath)) {
      try {
        const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as TestCaseCatalog;
        writeSnapshot(snapshotPath, pending, specHashAfter);
        return { kind: "accepted", wrote: snapshotPath, diff };
      } catch {
        writeSnapshot(snapshotPath, catalog, specHashAfter);
        return { kind: "accepted", wrote: snapshotPath, diff };
      }
    }
    writeSnapshot(snapshotPath, catalog, specHashAfter);
    return { kind: "accepted", wrote: snapshotPath, diff };
  }

  if (!drifted) return { kind: "no-change", diff };

  writeSnapshot(pendingPath, catalog, specHashAfter);
  return { kind: "pending", pendingPath, diff };
}

function writeSnapshot(path: string, catalog: TestCaseCatalog, specHash: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ...catalog,
    _snapshot_meta: {
      spec_hash: specHash,
      written_at: new Date().toISOString(),
    },
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}
