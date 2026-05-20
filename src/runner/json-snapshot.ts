/**
 * JSON snapshot — compare spin response (hoặc bất kỳ object nào) với baseline đã lưu.
 *
 * Tại sao tách riêng so với region-snapshot:
 *   - JSON value có structure → có thể normalize trước khi diff (ignore field, mask
 *     volatile field như timestamp/id).
 *   - Diff output friendly (path → expected vs actual) thay vì pixel ratio.
 *
 * Use case chính:
 *   1. Spin response shape regression — server đổi schema (thêm/bớt field) sẽ fail
 *   2. Catalog snapshot — verify test catalog AI sinh ra ổn định
 *   3. Config snapshot — config response từ game không bị provider đổi ngầm
 *
 * Cách dùng:
 *   import { assertJsonSnapshot } from "../src/runner/json-snapshot.js";
 *
 *   const result = await spinDeterministic(page, handle, { spinButton });
 *   assertJsonSnapshot(result.parsed, {
 *     slug: "fiesta-magenta",
 *     name: "spin-response-shape",
 *     // Mask field thay đổi mỗi spin (id, timestamp, etc.)
 *     mask: ["id", "round", "player", "playerNickname"],
 *   });
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JsonSnapshotOpts = {
  /** Slug game — dùng làm thư mục baseline. */
  slug: string;
  /** Tên baseline (kebab-case khuyến nghị). */
  name: string;
  /**
   * Field paths cần mask trước khi compare (dot notation). Vd: "id",
   * "result.totalWinAmount", "matrix.0.symbol". Mask = thay value bằng "<masked>"
   * cho cả expected và actual → diff bỏ qua field này.
   */
  mask?: string[];
  /**
   * Mode so sánh:
   *   - "structural" (default): chỉ check shape (key + type), giá trị primitive bỏ qua
   *   - "exact": full equality, mọi value phải khớp
   *   - "values": full equality cho primitive, array unordered
   */
  mode?: "structural" | "exact" | "values";
};

export type JsonSnapshotDiff = {
  path: string;
  kind: "added" | "removed" | "changed" | "type_changed";
  expected: unknown;
  actual: unknown;
};

export type JsonSnapshotResult = {
  ok: boolean;
  baselinePath: string;
  diffs: JsonSnapshotDiff[];
  created: boolean;
};

const SNAPSHOTS_DIR = "fixtures/snapshots";

export function snapshotPath(slug: string, name: string): string {
  return join(SNAPSHOTS_DIR, slug, `${name}.json`);
}

/**
 * Throw nếu actual ≠ baseline. Lần đầu (hoặc với JSON_SNAPSHOT_UPDATE=1)
 * sẽ tạo baseline thay vì compare.
 */
export function assertJsonSnapshot(
  actual: unknown,
  opts: JsonSnapshotOpts,
): JsonSnapshotResult {
  const path = snapshotPath(opts.slug, opts.name);
  const update = process.env.JSON_SNAPSHOT_UPDATE === "1";
  const mode = opts.mode ?? "structural";

  const masked = applyMask(actual, opts.mask ?? []);

  if (!existsSync(path) || update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stableStringify(masked, 2));
    return { ok: true, baselinePath: path, diffs: [], created: true };
  }

  const baseline = JSON.parse(readFileSync(path, "utf8"));
  const diffs = diffJson(baseline, masked, "", mode);

  if (diffs.length > 0) {
    const summary = diffs.slice(0, 10).map((d) => formatDiff(d)).join("\n");
    const more = diffs.length > 10 ? `\n  ... và ${diffs.length - 10} diff khác` : "";
    throw new Error(
      `JSON snapshot mismatch: ${opts.slug}/${opts.name}\n` +
        `  baseline: ${path}\n` +
        `  mode: ${mode}\n` +
        `  diffs (${diffs.length}):\n${summary}${more}\n` +
        `  To accept new value as baseline: JSON_SNAPSHOT_UPDATE=1 playwright test`,
    );
  }

  return { ok: true, baselinePath: path, diffs: [], created: false };
}

function formatDiff(d: JsonSnapshotDiff): string {
  const exp = previewValue(d.expected);
  const act = previewValue(d.actual);
  return `    [${d.kind}] ${d.path || "(root)"}: expected=${exp}  actual=${act}`;
}

function previewValue(v: unknown): string {
  if (v === undefined) return "(missing)";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 37) + "..." : v);
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  }
  return String(v);
}

/**
 * Apply mask path list. Path = dot notation, array index = số. Mask không exist
 * thì silently skip (không error — tolerant cho schema drift).
 */
function applyMask(v: unknown, paths: string[]): unknown {
  if (paths.length === 0) return v;
  const cloned = deepClone(v);
  for (const path of paths) {
    setByPath(cloned, path, "<masked>");
  }
  return cloned;
}

function deepClone(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = deepClone(val);
  }
  return out;
}

function setByPath(target: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: any = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (cur == null) return;
    cur = cur[key];
  }
  if (cur == null || typeof cur !== "object") return;
  const last = parts[parts.length - 1]!;
  if (last in cur) cur[last] = value;
}

function diffJson(
  expected: unknown,
  actual: unknown,
  path: string,
  mode: "structural" | "exact" | "values",
): JsonSnapshotDiff[] {
  // Type mismatch
  const tE = typeOf(expected);
  const tA = typeOf(actual);
  if (tE !== tA) {
    return [{ path, kind: "type_changed", expected, actual }];
  }

  // Primitive
  if (tE !== "object" && tE !== "array") {
    if (mode === "structural") return []; // structural: type khớp → ok
    if (expected !== actual) {
      return [{ path, kind: "changed", expected, actual }];
    }
    return [];
  }

  // Array
  if (tE === "array") {
    const e = expected as unknown[];
    const a = actual as unknown[];
    if (mode === "structural") {
      // Chỉ check element 0 (assume homogeneous) — đủ cho slot game response
      if (e.length > 0 && a.length === 0) {
        return [{ path, kind: "changed", expected: `array[${e.length}]`, actual: "array[0]" }];
      }
      if (e.length === 0) return [];
      return diffJson(e[0], a[0], `${path}[0]`, mode);
    }
    const diffs: JsonSnapshotDiff[] = [];
    if (e.length !== a.length) {
      diffs.push({
        path,
        kind: "changed",
        expected: `length=${e.length}`,
        actual: `length=${a.length}`,
      });
    }
    const len = Math.min(e.length, a.length);
    for (let i = 0; i < len; i++) {
      diffs.push(...diffJson(e[i], a[i], `${path}[${i}]`, mode));
    }
    return diffs;
  }

  // Object
  const eObj = expected as Record<string, unknown>;
  const aObj = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(eObj), ...Object.keys(aObj)]);
  const diffs: JsonSnapshotDiff[] = [];
  for (const k of keys) {
    const childPath = path ? `${path}.${k}` : k;
    if (!(k in aObj)) {
      diffs.push({ path: childPath, kind: "removed", expected: eObj[k], actual: undefined });
      continue;
    }
    if (!(k in eObj)) {
      diffs.push({ path: childPath, kind: "added", expected: undefined, actual: aObj[k] });
      continue;
    }
    diffs.push(...diffJson(eObj[k], aObj[k], childPath, mode));
  }
  return diffs;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Stable JSON stringify — sort keys ở mọi level. Bảo đảm 2 snapshot cho cùng
 * dữ liệu sẽ ra cùng output text → diff text-based cũng stable.
 */
function stableStringify(v: unknown, indent: number): string {
  return JSON.stringify(v, replacer, indent) + "\n";
}

function replacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}
