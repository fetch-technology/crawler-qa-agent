import { readFile, writeFile, access } from "node:fs/promises";
import { ensureDir, fileForGame, REGISTRY_FILES } from "./paths.js";
import type { GameSlug } from "./types.js";

type Key = keyof typeof REGISTRY_FILES;

export async function loadJson<T>(slug: GameSlug, key: Key): Promise<T | null> {
  const file = fileForGame(slug, key);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function saveJson<T>(slug: GameSlug, key: Key, data: T): Promise<void> {
  await ensureDir(slug);
  const file = fileForGame(slug, key);
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function fileExists(slug: GameSlug, key: Key): Promise<boolean> {
  const file = fileForGame(slug, key);
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadText(slug: GameSlug, key: Key): Promise<string | null> {
  const file = fileForGame(slug, key);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function saveText(slug: GameSlug, key: Key, content: string): Promise<void> {
  await ensureDir(slug);
  const file = fileForGame(slug, key);
  await writeFile(file, content, "utf8");
}
