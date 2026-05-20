/**
 * Prisma client singleton — env-gated by DATABASE_URL.
 *
 * If DATABASE_URL is missing, `getDb()` returns null. All repository
 * functions accept a nullable client and become no-ops, so the rest of the
 * codebase keeps working with filesystem-only persistence.
 */

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null | undefined;

export function getDb(): PrismaClient | null {
  if (client !== undefined) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = new PrismaClient({ log: ["warn", "error"] });
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/** True nếu DB layer được kích hoạt. */
export function isDbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
