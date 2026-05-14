import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type ManifestEntry = {
  n: number;
  filename: string;
  label: string;
  scope: string | null;
  caseScope: string | null;
  timestamp: string;
};

/**
 * Persistent screenshot store. Mọi screenshot được lưu vào cùng folder với
 * filename `{NNN}-{scope?}-{label}.png`. Nhiều subprocess (rules, auto, test)
 * có thể share cùng folder — counter TỰ RESUME từ files đang có, không overwrite.
 *
 * Folder được quyết định bởi resolveScreenshotDir():
 * - QA_SCREENSHOT_DIR env var (server set)
 * - fixtures/tasks/{QA_TASK_ID}/screenshots (khi chạy qua dashboard)
 * - fixtures/test-runs/{timestamp}/screenshots (khi chạy standalone)
 *
 * Scope (tuỳ chọn): QA_SCREENSHOT_SCOPE env var thêm prefix vào filename để
 * phân biệt rules/auto/test trong cùng folder.
 */
export class ScreenshotStore {
  private counter = 0;
  readonly dir: string;
  private readonly scope: string | null;
  private caseScope: string | null = null;
  private caseCounters = new Map<string, number>();
  private manifest: ManifestEntry[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });

    this.scope = process.env.QA_SCREENSHOT_SCOPE?.trim() || null;

    // Resume counter từ số file đang có để nhiều subprocess không overwrite nhau.
    try {
      const existing = readdirSync(dir).filter((f) => /^\d+-/.test(f));
      if (existing.length > 0) {
        const nums = existing
          .map((f) => parseInt(f.match(/^(\d+)/)?.[1] ?? "0", 10))
          .filter((n) => Number.isFinite(n));
        if (nums.length > 0) this.counter = Math.max(...nums);
      }
    } catch {}

    // Load existing manifest nếu có, để tiếp tục đúng thứ tự
    try {
      const manifestPath = join(dir, "manifest.json");
      if (existsSync(manifestPath)) {
        const data = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (Array.isArray(data)) this.manifest = data;
      }
    } catch {}
  }

  /**
   * Set scope theo test case. Mọi screenshot sau đó sẽ vào subfolder
   * `{dir}/{caseScope}/`. Truyền null để clear (về root dir).
   * Counter riêng per-case để filename trong subfolder bắt đầu từ 001.
   */
  setCaseScope(caseId: string | null): void {
    this.caseScope = caseId
      ? caseId.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || null
      : null;
  }

  async take(page: Page, label: string): Promise<string> {
    const safeLabel =
      label
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 60) || "shot";
    const scopeChunk = this.scope ? `${this.scope}-` : "";

    let targetDir = this.dir;
    let n: number;
    if (this.caseScope) {
      // Per-case counter — mỗi case bắt đầu từ 001
      n = (this.caseCounters.get(this.caseScope) ?? 0) + 1;
      this.caseCounters.set(this.caseScope, n);
      targetDir = join(this.dir, this.caseScope);
      mkdirSync(targetDir, { recursive: true });
    } else {
      n = ++this.counter;
    }
    const padded = String(n).padStart(3, "0");
    const filename = `${padded}-${scopeChunk}${safeLabel}.png`;
    const path = join(targetDir, filename);
    try {
      await page.screenshot({ path });
    } catch {
      // page có thể đang chuyển trạng thái; bỏ qua
    }
    const entry: ManifestEntry = {
      n,
      filename,
      label,
      scope: this.scope,
      caseScope: this.caseScope,
      timestamp: new Date().toISOString(),
    };
    this.manifest.push(entry);
    this.saveManifest();
    return path;
  }

  private saveManifest() {
    try {
      writeFileSync(
        join(this.dir, "manifest.json"),
        JSON.stringify(this.manifest, null, 2),
      );
    } catch {}
  }

  get count(): number {
    return this.counter;
  }
}

export function resolveScreenshotDir(): string {
  const override = process.env.QA_SCREENSHOT_DIR;
  if (override) return resolve(override);
  const taskId = process.env.QA_TASK_ID;
  if (taskId) return resolve(`fixtures/tasks/${taskId}/screenshots`);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(`fixtures/test-runs/${ts}/screenshots`);
}

let _store: ScreenshotStore | null = null;
export function getScreenshotStore(): ScreenshotStore {
  if (!_store) _store = new ScreenshotStore(resolveScreenshotDir());
  return _store;
}
