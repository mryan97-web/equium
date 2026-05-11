import { Connection, PublicKey } from "@solana/web3.js";
import {
  AnchorProvider,
  Program,
  setProvider,
} from "@coral-xyz/anchor";
import idl from "../idl.json";
import { CONFIG_PDA } from "./program";
import { cached, getRedisClient } from "./cache";

// Server-side RPC URL (full upstream URL with API key). Never sent to the
// browser; only used by server components, /api/state, /api/rpc, and OG
// image generators.
const SERVER_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

/** Client-facing RPC URL. Returns the user's override if one is stored,
 * otherwise the same-origin proxy as an absolute URL (Solana web3.js v2
 * rejects relative paths). Server-side returns the upstream URL. */
export function clientRpcUrl(): string {
  if (typeof window === "undefined") return SERVER_RPC_URL;
  try {
    const override = localStorage.getItem("equium:rpc-override");
    if (override && /^https?:\/\//.test(override)) return override;
  } catch {}
  return `${window.location.origin}/api/rpc`;
}

export const RPC_URL =
  typeof window !== "undefined" ? clientRpcUrl() : SERVER_RPC_URL;

export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER || "mainnet-beta";

export function readConnection(): Connection {
  return new Connection(SERVER_RPC_URL, "confirmed");
}

// Read-only program client. For server-side and read-only client use.
export function readProgram(connection: Connection): Program<any> {
  const dummyWallet = {
    publicKey: new PublicKey("11111111111111111111111111111112"),
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  const provider = new AnchorProvider(connection, dummyWallet as any, {
    commitment: "confirmed",
  });
  setProvider(provider);
  return new Program(idl as any, provider) as Program<any>;
}

export interface EquiumState {
  blockHeight: number;
  miningOpen: boolean;
  currentTargetHex: string;
  currentChallenge: string;
  epochReward: number;
  cumulativeMined: number;
  emptyRounds: number;
  equihashN: number;
  equihashK: number;
  mint: string;
  lastWinner: string;
  currentRoundOpenSlot: number;
  currentRoundOpenUnixTs: number;
  lastRetargetUnixTs: number;
  nextHalvingBlock: number;
  nextRetargetBlock: number;
}

const hex = (bytes: number[] | Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// TTLs are intentionally longer than the cron interval (60s, see
// vercel.json) so the cache always outlives one refresh cycle. If
// cron runs late or skips, users still hit a warm cache; if cron
// fires on time, it just overwrites a still-fresh value. The
// trade-off is data freshness: state can be up to ~90s stale, which
// is fine for an explorer (block height moves every ~1min anyway).
const CACHE_TTL_SEC = 90;

export async function fetchState(): Promise<EquiumState | null> {
  return cached("equium:state:v1", CACHE_TTL_SEC, fetchStateUncached);
}

export async function fetchStateUncached(): Promise<EquiumState | null> {
  try {
    const conn = readConnection();
    const program = readProgram(conn);
    const cfg: any = await (program.account as any).equiumConfig.fetch(CONFIG_PDA);
    return {
      blockHeight: Number(cfg.blockHeight.toString()),
      miningOpen: cfg.miningOpen,
      currentTargetHex: hex(cfg.currentTarget),
      currentChallenge: hex(cfg.currentChallenge),
      epochReward: Number(cfg.currentEpochReward.toString()),
      cumulativeMined: Number(cfg.cumulativeMined.toString()),
      emptyRounds: Number(cfg.emptyRounds.toString()),
      equihashN: cfg.equihashN,
      equihashK: cfg.equihashK,
      mint: cfg.mint.toBase58(),
      lastWinner: cfg.lastWinner.toBase58(),
      currentRoundOpenSlot: Number(cfg.currentRoundOpenSlot.toString()),
      currentRoundOpenUnixTs: Number(cfg.currentRoundOpenUnixTs.toString()),
      lastRetargetUnixTs: Number(cfg.lastRetargetUnixTs.toString()),
      nextHalvingBlock: Number(cfg.nextHalvingBlock.toString()),
      nextRetargetBlock: Number(cfg.nextRetargetBlock.toString()),
    };
  } catch (e) {
    console.error("fetchState failed", e);
    return null;
  }
}

export interface MinedBlock {
  sig: string;
  height: number;
  winner: string;
  reward: number;
  ts: number;
  newChallenge: string;
}

/**
 * Fetch recent BlockMined events by scanning the program's recent signatures.
 * Returns up to `limit` mined blocks ordered newest-first.
 */
export async function fetchRecentBlocks(limit = 12): Promise<MinedBlock[]> {
  return cached(`equium:blocks:${limit}:v1`, CACHE_TTL_SEC, () =>
    fetchRecentBlocksUncached(limit)
  );
}

export async function fetchRecentBlocksUncached(
  limit: number
): Promise<MinedBlock[]> {
  try {
    const conn = readConnection();
    const PROGRAM_ID = new PublicKey(idl.address);
    const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, {
      limit: 60,
    });
    const out: MinedBlock[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const logs = tx.meta?.logMessages ?? [];
      const isMined = logs.some((l) => l.includes("equium: mined block"));
      if (!isMined) continue;

      // Parse height + winner from log
      const mineLog = logs.find((l) => l.includes("equium: mined block"));
      const m = mineLog?.match(/mined block (\d+) by ([\w]+) for (\d+)/);
      const height = m ? Number(m[1]) : -1;
      const winner = m ? m[2] : "";
      const reward = m ? Number(m[3]) : 0;
      out.push({
        sig: s.signature,
        height,
        winner,
        reward,
        ts: s.blockTime ?? 0,
        newChallenge: "",
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.error("fetchRecentBlocks failed", e);
    return [];
  }
}

export interface LeaderboardEntry {
  miner: string;
  blocks: number;
  totalRewardBase: number;
  lastSeen: number;
  lastHeight: number;
}

/**
 * Aggregate the last N program signatures into a top-miners leaderboard.
 * Sorts by block count desc, returns up to `take` rows.
 */
export async function fetchLeaderboard(
  scan = 200,
  take = 20
): Promise<LeaderboardEntry[]> {
  return cached(`equium:leaderboard:${scan}:${take}:v1`, CACHE_TTL_SEC, () =>
    fetchLeaderboardUncached(scan, take)
  );
}

export async function fetchLeaderboardUncached(
  scan: number,
  take: number
): Promise<LeaderboardEntry[]> {
  const blocks = await fetchAllMinedInRange(scan);
  const map = new Map<string, LeaderboardEntry>();
  for (const b of blocks) {
    const existing = map.get(b.winner);
    if (existing) {
      existing.blocks += 1;
      existing.totalRewardBase += b.reward;
      if (b.ts > existing.lastSeen) existing.lastSeen = b.ts;
      if (b.height > existing.lastHeight) existing.lastHeight = b.height;
    } else {
      map.set(b.winner, {
        miner: b.winner,
        blocks: 1,
        totalRewardBase: b.reward,
        lastSeen: b.ts,
        lastHeight: b.height,
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.blocks - a.blocks)
    .slice(0, take);
}

// ============================================================================
// All-time miner aggregator (Redis-backed, incrementally updated by cron)
// ============================================================================

/** All-time leaderboard row. `hashratePerSec` is the per-miner
 * hashrate derived from blocks in the last hour + current difficulty
 * — 0 if the miner hasn't found a block recently. */
export interface AllTimeEntry {
  miner: string;
  blocks: number;
  totalRewardBase: number;
  lastSeen: number;
  lastHeight: number;
  /** Hashrate in H/s, calculated from blocks in the last hour. 0 if
   * the miner has been inactive recently. */
  hashratePerSec: number;
}

// Aggregator schema (Redis):
//
//   alltime:miners      HASH  miner_pubkey → total blocks
//   alltime:rewards     HASH  miner_pubkey → total reward (base units)
//   alltime:last_seen   HASH  miner_pubkey → unix ts of last block
//   alltime:last_height HASH  miner_pubkey → height of last block
//   alltime:rank        ZSET  score = total blocks, member = miner pubkey
//                              ← gives O(log N + take) top-N reads
//                                regardless of total unique miner count.
//   alltime:cursor      STRING newest program signature processed
//   recent:miner_blocks ZSET  score = ts, member = "<miner>:<height>"
//                              (last hour, used for per-miner hashrate)
//
// The HASH+ZSET pair is intentionally redundant: HGET'ing per-field
// data after a ZREVRANGE gives ranked reads without a sort step, but
// the HASHes still carry the per-miner side data we'd otherwise need
// to walk separately.
const ALLTIME_MINERS = "equium:alltime:miners:v1";
const ALLTIME_REWARDS = "equium:alltime:rewards:v1";
const ALLTIME_LAST_SEEN = "equium:alltime:last_seen:v1";
const ALLTIME_LAST_HEIGHT = "equium:alltime:last_height:v1";
const ALLTIME_RANK = "equium:alltime:rank:v1";
const ALLTIME_CURSOR = "equium:alltime:cursor:v1";
const RECENT_MINER_BLOCKS = "equium:recent:miner_blocks:v1";
const RECENT_WINDOW_SEC = 3600; // 1 hour

/**
 * Walk new program signatures since the last cursor, accumulate
 * per-miner block counts + rewards into Redis HASHes, and update the
 * recent-blocks ZSET used for per-miner hashrate calculation.
 *
 * Idempotent in steady state: each cron tick processes only the
 * signatures strictly newer than the saved cursor. The first run with
 * no cursor scans up to MAX_SIGS most recent signatures (capped to fit
 * in the cron's 60s budget).
 */
export async function updateAllTimeAggregator(): Promise<{
  processed: number;
  newest: string | null;
}> {
  const redis = getRedisClient();
  if (!redis) return { processed: 0, newest: null };

  try {
    const conn = readConnection();
    const PROGRAM_ID = new PublicKey(idl.address);
    const cursor = await redis.get<string>(ALLTIME_CURSOR).catch(() => null);

    // One-time migration: if the rank ZSET is empty but the per-miner
    // HASH already has data (e.g. we just deployed the indexed read
    // path against an existing aggregator), rebuild the ZSET from the
    // HASH so the fast `ZREVRANGE` read path lights up immediately.
    // Idempotent — subsequent ticks short-circuit on the ZCARD check.
    const rankCount = await redis.zcard(ALLTIME_RANK).catch(() => 0);
    if (rankCount === 0) {
      const all = await redis
        .hgetall<Record<string, number>>(ALLTIME_MINERS)
        .catch(() => null);
      if (all && Object.keys(all).length > 0) {
        for (const [miner, blocks] of Object.entries(all)) {
          await redis
            .zadd(ALLTIME_RANK, { score: Number(blocks), member: miner })
            .catch(() => null);
        }
      }
    }

    // First run: scan up to MAX_SIGS most recent signatures and treat
    // them as the historical baseline. After this, future ticks use
    // `until=cursor` for cheap incrementals.
    const MAX_SIGS = 1000;
    const opts: { limit: number; until?: string } = { limit: MAX_SIGS };
    if (cursor) opts.until = cursor;

    const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, opts);
    if (sigs.length === 0) return { processed: 0, newest: cursor ?? null };

    // sigs are newest-first; reverse to process oldest-first so the
    // cursor we save at the end is the newest (sigs[0]) and last_seen
    // ends up monotonic.
    const ordered = [...sigs].reverse();
    const nowSec = Math.floor(Date.now() / 1000);

    const BATCH = 10;
    let processed = 0;
    for (let i = 0; i < ordered.length; i += BATCH) {
      const batch = ordered.slice(i, i + BATCH).filter((s) => !s.err);
      const txs = await Promise.all(
        batch.map((s) =>
          conn.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        )
      );
      for (let j = 0; j < txs.length; j++) {
        const tx = txs[j];
        if (!tx) continue;
        const sig = batch[j];
        const logs = tx.meta?.logMessages ?? [];
        const mineLog = logs.find((l) => l.includes("equium: mined block"));
        if (!mineLog) continue;
        const m = mineLog.match(/mined block (\d+) by ([\w]+) for (\d+)/);
        if (!m) continue;

        const height = Number(m[1]);
        const winner = m[2];
        const reward = Number(m[3]);
        const ts = sig.blockTime ?? nowSec;

        // Update aggregator HASHes. All ops are await'd individually
        // rather than in a pipeline to keep error handling clean —
        // Upstash REST is fast enough that the parallelism we'd gain
        // from a pipeline isn't worth the complexity here.
        await redis.hincrby(ALLTIME_MINERS, winner, 1);
        await redis.hincrby(ALLTIME_REWARDS, winner, reward);
        await redis.hset(ALLTIME_LAST_SEEN, { [winner]: ts });
        await redis.hset(ALLTIME_LAST_HEIGHT, { [winner]: height });
        // Keep the sorted-by-blocks index in lockstep. ZINCRBY adds
        // the score to whatever's already there (or seeds it from 0
        // for a first-time miner), so a top-N read is a single
        // ZREVRANGE — no full HGETALL + sort needed.
        await redis.zincrby(ALLTIME_RANK, 1, winner);

        // Track this block in the recent-blocks ZSET (score = ts,
        // member = miner:height so duplicates are impossible).
        await redis.zadd(RECENT_MINER_BLOCKS, {
          score: ts,
          member: `${winner}:${height}`,
        });

        processed++;
      }
    }

    // Trim recent-blocks ZSET to the rolling window.
    await redis
      .zremrangebyscore(RECENT_MINER_BLOCKS, 0, nowSec - RECENT_WINDOW_SEC)
      .catch(() => 0);

    const newest = sigs[0].signature;
    await redis.set(ALLTIME_CURSOR, newest);
    return { processed, newest };
  } catch (e) {
    console.error("updateAllTimeAggregator failed", e);
    return { processed: 0, newest: null };
  }
}

/**
 * Read the top-N all-time miners. Cached so concurrent requests don't
 * each spin up a Redis pipeline; the per-miner aggregator HASHes only
 * change when the cron runs, so a short cache is invisible.
 */
export async function fetchAllTimeLeaderboard(
  take = 50
): Promise<AllTimeEntry[]> {
  return cached(
    `equium:alltime:top:${take}:v1`,
    CACHE_TTL_SEC,
    () => fetchAllTimeLeaderboardUncached(take)
  );
}

export async function fetchAllTimeLeaderboardUncached(
  take = 50
): Promise<AllTimeEntry[]> {
  const redis = getRedisClient();
  if (!redis) return [];

  try {
    // Fast path: ZREVRANGE the rank ZSET — O(log N + take) — to get
    // the top-N miners by block count in sorted order, then HMGET the
    // side data per row. No full HGETALL, no in-memory sort.
    const ranked = (await redis
      .zrange<string[]>(ALLTIME_RANK, 0, take - 1, {
        rev: true,
        withScores: true,
      })
      .catch(() => [] as string[])) ?? [];

    // Upstash's withScores returns a flat [member, score, member,
    // score, ...] array. Split it.
    const miners: string[] = [];
    const blockCounts: number[] = [];
    for (let i = 0; i < ranked.length; i += 2) {
      miners.push(String(ranked[i]));
      blockCounts.push(Number(ranked[i + 1]));
    }

    // Transition fallback: if the rank ZSET hasn't been populated yet
    // (running the new code against an old cache snapshot), fall back
    // to the legacy HGETALL+sort path. One cron tick later the ZSET
    // is live and we never hit this branch again.
    let useFallback = miners.length === 0;
    if (useFallback) {
      const all = await redis
        .hgetall<Record<string, number>>(ALLTIME_MINERS)
        .catch(() => null);
      if (all) {
        const entries = Object.entries(all)
          .map(([m, b]) => [m, Number(b)] as const)
          .sort((a, b) => b[1] - a[1])
          .slice(0, take);
        for (const [m, b] of entries) {
          miners.push(m);
          blockCounts.push(b);
        }
      }
    }

    if (miners.length === 0) return [];

    // Pull the side data we need only for the rows we're returning.
    const [rewards, lastSeen, lastHeight, state, recent] = await Promise.all([
      redis.hmget<Record<string, number>>(ALLTIME_REWARDS, ...miners),
      redis.hmget<Record<string, number>>(ALLTIME_LAST_SEEN, ...miners),
      redis.hmget<Record<string, number>>(ALLTIME_LAST_HEIGHT, ...miners),
      fetchState().catch(() => null),
      // Recent-1hr block members are "<miner>:<height>" tuples.
      redis.zrange<string[]>(
        RECENT_MINER_BLOCKS,
        Math.floor(Date.now() / 1000) - RECENT_WINDOW_SEC,
        "+inf",
        { byScore: true }
      ),
    ]);

    // Per-miner block count over the recent window.
    const recentCount = new Map<string, number>();
    for (const member of recent || []) {
      const colon = (member as string).indexOf(":");
      if (colon < 0) continue;
      const m = (member as string).slice(0, colon);
      recentCount.set(m, (recentCount.get(m) ?? 0) + 1);
    }

    const targetHex = state?.currentTargetHex ?? "";
    const rows: AllTimeEntry[] = miners.map((m, i) => {
      const recentBlocks = recentCount.get(m) ?? 0;
      const bpm = (recentBlocks / RECENT_WINDOW_SEC) * 60;
      return {
        miner: m,
        blocks: blockCounts[i],
        totalRewardBase: Number(rewards?.[m] ?? 0),
        lastSeen: Number(lastSeen?.[m] ?? 0),
        lastHeight: Number(lastHeight?.[m] ?? 0),
        hashratePerSec: estimateNetworkHashrate(bpm, targetHex),
      };
    });

    return rows;
  } catch (e) {
    console.error("fetchAllTimeLeaderboard failed", e);
    return [];
  }
}

/**
 * Paginated mined-block history. Walks `getSignaturesForAddress` with
 * `before=<cursor>` until it has accumulated `take` mined blocks (or
 * exhausts the program's signature history). Returns the next cursor
 * so the UI can keep loading.
 *
 * `nextCursor` is the signature of the OLDEST block returned in this
 * page; pass it back as `before` on the next call.
 */
export async function fetchBlocksPage(
  before: string | undefined,
  take: number
): Promise<{ blocks: MinedBlock[]; nextCursor: string | null }> {
  try {
    const conn = readConnection();
    const PROGRAM_ID = new PublicKey(idl.address);
    const blocks: MinedBlock[] = [];
    let cursor: string | undefined = before;
    let exhausted = false;

    // Cap iterations so a long history of empty rounds can't make a
    // single page hang for minutes. After this many batches we hand
    // back what we've got and let the client paginate further.
    const MAX_BATCHES = 5;
    let batchesTried = 0;

    while (blocks.length < take && !exhausted && batchesTried < MAX_BATCHES) {
      batchesTried++;
      const opts: { limit: number; before?: string } = { limit: 200 };
      if (cursor) opts.before = cursor;
      const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, opts);
      if (sigs.length === 0) {
        exhausted = true;
        break;
      }

      const BATCH = 10;
      for (let i = 0; i < sigs.length; i += BATCH) {
        const batch = sigs.slice(i, i + BATCH).filter((s) => !s.err);
        const txs = await Promise.all(
          batch.map((s) =>
            conn.getTransaction(s.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            })
          )
        );
        for (let j = 0; j < txs.length; j++) {
          const tx = txs[j];
          if (!tx) continue;
          const sig = batch[j];
          const logs = tx.meta?.logMessages ?? [];
          const mineLog = logs.find((l) => l.includes("equium: mined block"));
          if (!mineLog) continue;
          const m = mineLog.match(/mined block (\d+) by ([\w]+) for (\d+)/);
          if (!m) continue;
          blocks.push({
            sig: sig.signature,
            height: Number(m[1]),
            winner: m[2],
            reward: Number(m[3]),
            ts: sig.blockTime ?? 0,
            newChallenge: "",
          });
          if (blocks.length >= take) break;
        }
        if (blocks.length >= take) break;
      }

      // If we hit the take limit, the next cursor is the last mined
      // block's signature. Otherwise advance the cursor past the
      // current batch's oldest sig and keep scanning.
      cursor = sigs[sigs.length - 1].signature;
    }

    const nextCursor =
      blocks.length > 0
        ? blocks[blocks.length - 1].sig
        : exhausted
        ? null
        : cursor ?? null;
    return {
      blocks,
      nextCursor: exhausted && blocks.length === 0 ? null : nextCursor,
    };
  } catch (e) {
    console.error("fetchBlocksPage failed", e);
    return { blocks: [], nextCursor: null };
  }
}

/** Scan up to `scan` recent program signatures and parse every mined block. */
async function fetchAllMinedInRange(scan: number): Promise<MinedBlock[]> {
  try {
    const conn = readConnection();
    const PROGRAM_ID = new PublicKey(idl.address);
    const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, { limit: scan });
    const out: MinedBlock[] = [];
    const BATCH = 10;
    for (let i = 0; i < sigs.length; i += BATCH) {
      const batch = sigs.slice(i, i + BATCH).filter((s) => !s.err);
      const txs = await Promise.all(
        batch.map((s) =>
          conn.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        )
      );
      for (let j = 0; j < txs.length; j++) {
        const tx = txs[j];
        if (!tx) continue;
        const sig = batch[j];
        const logs = tx.meta?.logMessages ?? [];
        const mineLog = logs.find((l) => l.includes("equium: mined block"));
        if (!mineLog) continue;
        const m = mineLog.match(/mined block (\d+) by ([\w]+) for (\d+)/);
        if (!m) continue;
        out.push({
          sig: sig.signature,
          height: Number(m[1]),
          winner: m[2],
          reward: Number(m[3]),
          ts: sig.blockTime ?? 0,
          newChallenge: "",
        });
      }
    }
    return out;
  } catch (e) {
    console.error("fetchAllMinedInRange failed", e);
    return [];
  }
}

export interface HashrateSeries {
  /** Blocks mined in each 1-minute bucket, oldest → newest. */
  blocksPerMinute: number[];
  /** Bucket start timestamps (unix seconds), oldest → newest. */
  bucketTimestamps: number[];
  /** EWMA-current rate (blocks/min). */
  currentBpm: number;
  /** Window-average rate (blocks/min). */
  averageBpm: number;
  /** % change of second half vs first half of the window. */
  trendPct: number;
  /** Network hashrate estimate in H/s, derived from currentBpm + current
   * difficulty target. Each Wagner attempt produces a hash; the probability
   * it lands under the target is target / 2^256. */
  estimatedHps: number;
  /** Window-average network hashrate (H/s). */
  averageHps: number;
}

/**
 * Estimate network hashrate from a block-arrival rate and the current target.
 *
 * Each Wagner solve produces a SHA-256 candidate; the probability it falls
 * under the target is `target / 2^256`. So `network_attempts/sec =
 * blocks/sec * 2^256 / target`. Returns hashes per second.
 */
export function estimateNetworkHashrate(
  blocksPerMinute: number,
  targetHex: string
): number {
  if (blocksPerMinute <= 0 || !targetHex) return 0;
  try {
    const target = BigInt("0x" + targetHex);
    if (target === 0n) return 0;
    const twoTo256 = 1n << 256n;
    // bpm / 60 → blocks per second
    // multiply by (2^256 / target) → attempts per second
    // Stage the math so we don't lose precision: divide BigInt first,
    // then convert to Number for the multiply.
    const inverse = twoTo256 / target;
    return (blocksPerMinute / 60) * Number(inverse);
  } catch {
    return 0;
  }
}

/**
 * Bucket recent mined-block timestamps into per-minute counts for charting.
 * Returns `bucketCount` minutes of data ending at "now".
 */
export async function fetchHashrateSeries(
  scan = 200,
  bucketCount = 30
): Promise<HashrateSeries> {
  return cached(`equium:hashrate:${scan}:${bucketCount}:v1`, CACHE_TTL_SEC, () =>
    fetchHashrateSeriesUncached(scan, bucketCount)
  );
}

export async function fetchHashrateSeriesUncached(
  scan: number,
  bucketCount: number
): Promise<HashrateSeries> {
  const [blocks, state] = await Promise.all([
    fetchAllMinedInRange(scan),
    fetchState().catch(() => null),
  ]);
  const targetHex = state?.currentTargetHex ?? "";
  const nowSec = Math.floor(Date.now() / 1000);
  const lastBucketStart = Math.floor(nowSec / 60) * 60;
  const buckets: number[] = new Array(bucketCount).fill(0);
  const stamps: number[] = new Array(bucketCount).fill(0);
  for (let i = 0; i < bucketCount; i++) {
    stamps[i] = lastBucketStart - (bucketCount - 1 - i) * 60;
  }
  for (const b of blocks) {
    if (!b.ts) continue;
    const offsetMin = Math.floor((lastBucketStart - b.ts) / 60);
    if (offsetMin < 0 || offsetMin >= bucketCount) continue;
    buckets[bucketCount - 1 - offsetMin] += 1;
  }

  const sum = buckets.reduce((a, b) => a + b, 0);
  const averageBpm = sum / bucketCount;

  let weight = 0;
  let weighted = 0;
  for (let i = 0; i < buckets.length; i++) {
    const w = Math.pow(0.85, buckets.length - 1 - i);
    weighted += buckets[i] * w;
    weight += w;
  }
  const currentBpm = weight > 0 ? weighted / weight : 0;

  const half = Math.floor(bucketCount / 2);
  const firstHalf =
    buckets.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
  const secondHalf =
    buckets.slice(half).reduce((a, b) => a + b, 0) /
    Math.max(1, bucketCount - half);
  const trendPct =
    firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;

  return {
    blocksPerMinute: buckets,
    bucketTimestamps: stamps,
    currentBpm,
    averageBpm,
    trendPct,
    estimatedHps: estimateNetworkHashrate(currentBpm, targetHex),
    averageHps: estimateNetworkHashrate(averageBpm, targetHex),
  };
}
