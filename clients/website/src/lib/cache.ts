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

/** Public accessor for callers that need direct HASH / ZSET ops
 * (currently the all-time miner aggregator). Returns null when Redis
 * isn't configured — callers should degrade gracefully. */
export function getRedisClient(): Redis | null {
  return getRedis();
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
  // Don't cache obviously-failed results. The fetchers in lib/rpc.ts
  // swallow RPC errors and return null / [] so the API surface stays
  // simple, but writing those to Redis under a 10s+ TTL would lock in
  // a broken explorer page until the entry expired. Treat null as
  // skip-cache; treat empty arrays as cacheable only briefly.
  if (fresh === null || fresh === undefined) return fresh;
  try {
    const isEmptyArray = Array.isArray(fresh) && fresh.length === 0;
    await redis.set(key, fresh, { ex: isEmptyArray ? 3 : ttlSec });
  } catch {
    // Best-effort write.
  }
  return fresh;
}

/** Force-refresh a cached entry. Used by the cron pre-warm route.
 * Mirrors the skip-on-null / short-TTL-on-empty rules from `cached()`. */
export async function warm<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>
): Promise<T> {
  const fresh = await fn();
  if (fresh === null || fresh === undefined) return fresh;
  const redis = getRedis();
  if (redis) {
    try {
      const isEmptyArray = Array.isArray(fresh) && fresh.length === 0;
      await redis.set(key, fresh, { ex: isEmptyArray ? 3 : ttlSec });
    } catch {}
  }
  return fresh;
}
