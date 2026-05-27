// Append-only history store. JSONL format (1 line = 1 entry) for streaming
// safety + cheap append. Trim when MAX_HISTORY_ENTRIES exceeded.

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { dirForGame } from "../../registry/paths.js";
import { MAX_HISTORY_ENTRIES, type HistoryEntry } from "./types.js";

function fileForCase(gameSlug: string, caseId: string): string {
  const safeId = caseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(dirForGame(gameSlug), "case-history", `${safeId}.jsonl`);
}

/** Append a new run entry to the case's history log. Creates directory if missing. */
export async function appendHistory(
  gameSlug: string,
  caseId: string,
  entry: HistoryEntry,
): Promise<void> {
  const file = fileForCase(gameSlug, caseId);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");

  // Trim if exceeded MAX_HISTORY_ENTRIES (keep most recent).
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > MAX_HISTORY_ENTRIES) {
      const trimmed = lines.slice(-MAX_HISTORY_ENTRIES);
      await writeFile(file, trimmed.join("\n") + "\n", "utf8");
    }
  } catch {
    // Best-effort trim — ignore failures
  }
}

/** Read the case's history log. Returns entries in chronological order
 *  (oldest first). Returns empty array if log missing. */
export async function loadHistory(
  gameSlug: string,
  caseId: string,
): Promise<HistoryEntry[]> {
  const file = fileForCase(gameSlug, caseId);
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}

/** Convenience: most recent N entries. */
export async function recentHistory(
  gameSlug: string,
  caseId: string,
  n: number,
): Promise<HistoryEntry[]> {
  const all = await loadHistory(gameSlug, caseId);
  return all.slice(-n);
}
