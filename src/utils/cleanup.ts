import { rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Những folder KHÔNG bao giờ touch (hardcode để tránh xóa nhầm)
 */
const SAFE_BASES = [
  "fixtures/recordings",
  "fixtures/rules",
  "fixtures/options",
  "fixtures/specs",
  "fixtures/test-runs",
  "fixtures/tasks",
  "tests/generated",
  "reports",
  "test-results",
  "playwright-report",
];

function safeRm(path: string) {
  // Extra safety: path phải trong 1 trong SAFE_BASES
  const normalized = path.replace(/\\/g, "/");
  if (!SAFE_BASES.some((b) => normalized === b || normalized.startsWith(b + "/"))) {
    throw new Error(`Refusing to delete path outside safe bases: ${path}`);
  }
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export type CleanGameResult = {
  slug: string;
  removed: string[];
  notFound: string[];
};

/**
 * Xóa toàn bộ artifact của 1 game theo slug:
 * - fixtures/recordings/{slug}__* (auto + manual)
 * - fixtures/rules/{slug}__*
 * - fixtures/options/{slug}__*
 * - fixtures/specs/{slug}/ (GameSpec, test-cases, network-hints)
 * - tests/generated/{slug}.spec.ts
 *
 * KHÔNG động: fixtures/tasks/ (task history, xóa qua dashboard retry)
 */
export function cleanGame(slug: string): CleanGameResult {
  const removed: string[] = [];
  const notFound: string[] = [];

  const folderBases = ["fixtures/recordings", "fixtures/rules", "fixtures/options"];
  for (const base of folderBases) {
    if (!existsSync(base)) {
      notFound.push(base);
      continue;
    }
    for (const name of readdirSync(base)) {
      if (!name.includes(slug + "__")) continue;
      const full = join(base, name);
      if (statSync(full).isDirectory()) {
        safeRm(full);
        removed.push(full);
      }
    }
  }

  // Per-slug specs folder
  const specDir = join("fixtures/specs", slug);
  if (existsSync(specDir)) {
    safeRm(specDir);
    removed.push(specDir);
  }

  // Generated test file
  const testFile = join("tests/generated", `${slug}.spec.ts`);
  if (existsSync(testFile)) {
    safeRm(testFile);
    removed.push(testFile);
  }

  return { slug, removed, notFound };
}

/**
 * Xóa toàn bộ data của mọi game (wipe tất cả fixtures + generated tests +
 * reports + test-results). KHÔNG xóa: src/, public/, node_modules/, .env, .git
 */
export function cleanAll(): { removed: string[] } {
  const removed: string[] = [];
  for (const base of SAFE_BASES) {
    if (!existsSync(base)) continue;
    safeRm(base);
    removed.push(base);
  }
  return { removed };
}

/**
 * Xóa riêng folder của 1 task (screenshots + logs + events của task đó).
 * KHÔNG động fixtures/tasks/index.json — index được queue giữ.
 */
export function cleanTaskFolder(taskId: string): void {
  const dir = join("fixtures/tasks", taskId);
  safeRm(dir);
}

/**
 * Xóa các thư mục output GLOBAL của Playwright (reports + traces + .last-run.json).
 * Dùng khi retry để bảo đảm UI/HTML report mới hoàn toàn không lẫn run cũ.
 */
export function cleanGlobalReports(): { removed: string[] } {
  const removed: string[] = [];
  for (const base of ["reports", "test-results", "playwright-report"]) {
    if (existsSync(base)) {
      safeRm(base);
      removed.push(base);
    }
  }
  return { removed };
}
