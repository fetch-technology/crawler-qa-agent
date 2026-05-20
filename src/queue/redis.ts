/**
 * Redis connection singleton. Env-gated by REDIS_URL.
 *
 * Default localhost:6380 matches `docker-compose.yml`.
 */

import IORedis, { type Redis } from "ioredis";

let connection: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (connection !== undefined) return connection;
  const url = process.env.REDIS_URL;
  if (!url) {
    connection = null;
    return null;
  }
  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return connection;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}

export function isRedisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}
