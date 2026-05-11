/**
 * Thin Upstash Redis wrapper used by the explorer / state endpoints.
 *
 * Design: the heavy chain reads (state, leaderboard, recent blocks,
 * hashrate series) are expensive — getSignaturesForAddress + N
 * getTransaction calls — and they don't need to be perfectly fresh.
 * Cache them in Redis with short TTLs so:
 *
 *   - One Helius call per cache miss feeds ALL connected users.
 *   - Page renders in ~10ms instead of ~5s.
 *   - Helius quota scales O(time), not O(users × time).
 *
 * If `UPSTASH_REDIS_REST_URL` is unset, the helpers degrade to a
 * no-op (every call hits chain directly). Lets us deploy this code
 * before the env vars are wired without breaking anything.
 */

import { Redis } from "@upstash/redis";

let _redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    _redis = null;
    return null;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Read-through cache. Returns the cached value if present + fresh,
 * otherwise calls `fn`, writes the result, returns it.
 *
 *   const state = await cached("state:v1", 30, () => fetchStateFromChain());
 *
 * If Redis is unavailable or any operation fails, we silently fall
 * back to calling `fn` directly — chain stays the source of truth.
 */
export async function cached<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  if (!redis) return fn();

  try {
    const hit = await redis.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch {
    // Redis unreachable — fall through to a chain fetch.
  }

  const fresh = await fn();
  try {
    await redis.set(key, fresh, { ex: ttlSec });
  } catch {
    // Best-effort write. A failed cache write is just a missed
    // optimization, not a failure of the request.
  }
  return fresh;
}

/** Force-refresh a cached entry. Used by the cron pre-warm route. */
export async function warm<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>
): Promise<T> {
  const fresh = await fn();
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, fresh, { ex: ttlSec });
    } catch {}
  }
  return fresh;
}
