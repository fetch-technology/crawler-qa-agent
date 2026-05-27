import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NetworkRound } from "./types.js";

export async function persistRounds(outDir: string, rounds: NetworkRound[]): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "network.jsonl");
  const lines = rounds.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(file, lines, "utf8");
  return file;
}
