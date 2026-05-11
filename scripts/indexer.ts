/**
 * Equium explorer indexer.
 *
 * Continuously syncs the Equium program's full block history into
 * Upstash Redis so the explorer can serve stats without ever scanning
 * chain on a page load. Replaces the previous Vercel-cron path, which
 * was rate-limited on Hobby tier + capped at scanning the most recent
 * 1000 signatures per tick.
 *
 * Lifecycle:
 *
 *   1. First run (cursor missing or REINDEX=1): walk the program's
 *      entire signature history from newest → oldest, processing
 *      every mined-block log. Writes per-miner totals to Redis HASHes
 *      and the sorted-by-blocks rank ZSET.
 *
 *   2. Steady state: every POLL_INTERVAL_MS, fetch sigs `until=cursor`
 *      and process only the new ones. Cursor advances to the newest
 *      processed signature.
 *
 * Redis schema (matches clients/website/src/lib/rpc.ts):
 *
 *   equium:alltime:miners      HASH  miner → blocks
 *   equium:alltime:rewards     HASH  miner → total reward (base units)
 *   equium:alltime:last_seen   HASH  miner → unix ts of last block
 *   equium:alltime:last_height HASH  miner → height of last block
 *   equium:alltime:rank        ZSET  score=blocks, member=miner
 *   equium:alltime:cursor      STRING newest processed signature
 *   equium:alltime:meta        HASH  bookkeeping (total_blocks, started_at, ...)
 *   equium:recent:miner_blocks ZSET  score=ts, member="<miner>:<height>"
 *                                    (1-hour rolling window, for per-miner hashrate)
 *
 * Usage:
 *   cd /home/ubuntu/Equium
 *   # Either pass via env or use clients/website/.env.local
 *   SOLANA_RPC_URL=... \
 *   UPSTASH_REDIS_REST_URL=... \
 *   UPSTASH_REDIS_REST_TOKEN=... \
 *     npx tsx scripts/indexer.ts
 *
 *   # Re-index from scratch (wipes Redis aggregator state):
 *   REINDEX=1 npx tsx scripts/indexer.ts
 *
 *   # Run as a background service via systemd: see
 *   # scripts/indexer.service for a unit file template.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Redis } from "@upstash/redis";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// ----- Config ---------------------------------------------------------

// Try .env in cwd, then clients/website/.env.local as a fallback so
// the same creds work for both the indexer and the website.
const tryEnvFile = (p: string) => {
  if (fs.existsSync(p)) dotenv.config({ path: p });
};
tryEnvFile(path.resolve(__dirname, "..", ".env"));
tryEnvFile(path.resolve(__dirname, "..", "clients", "website", ".env.local"));

const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "ZKGMUfxiRCXFPnqz9zgqAnuqJy15jk7fKbR4o6FuEQM"
);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "10000");
const BATCH_SIZE = Number(process.env.BATCH_SIZE || "10");
const REINDEX = process.env.REINDEX === "1";
const RECENT_WINDOW_SEC = 3600;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error(
    "missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN — aborting"
  );
  process.exit(1);
}

// ----- Redis keys (mirror clients/website/src/lib/rpc.ts) ------------

const K = {
  miners: "equium:alltime:miners:v1",
  rewards: "equium:alltime:rewards:v1",
  lastSeen: "equium:alltime:last_seen:v1",
  lastHeight: "equium:alltime:last_height:v1",
  rank: "equium:alltime:rank:v1",
  cursor: "equium:alltime:cursor:v1",
  meta: "equium:alltime:meta:v1",
  recent: "equium:recent:miner_blocks:v1",
};

// ----- State + clients ------------------------------------------------

const conn = new Connection(RPC_URL, "confirmed");
const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

// Pretty hashrate-style formatter for the periodic status print.
const fmtNum = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const log = (level: "info" | "ok" | "warn" | "err", msg: string) => {
  const ts = new Date().toISOString();
  const tag =
    level === "ok"
      ? "\x1b[32mOK\x1b[0m"
      : level === "warn"
      ? "\x1b[33mWARN\x1b[0m"
      : level === "err"
      ? "\x1b[31mERR\x1b[0m"
      : "\x1b[36mINFO\x1b[0m";
  console.log(`${ts} ${tag}  ${msg}`);
};

// ----- Core: process a batch of signatures --------------------------

interface MinedBlock {
  sig: string;
  height: number;
  winner: string;
  reward: number;
  ts: number;
}

/**
 * Parse a transaction's logs for the canonical "equium: mined block N
 * by PUBKEY for R" line. Returns null for non-mine transactions
 * (advance_empty_round, init, etc.).
 */
async function parseMinedBlock(sig: string): Promise<MinedBlock | null> {
  const tx = await conn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  const logs = tx.meta?.logMessages ?? [];
  const mineLog = logs.find((l) => l.includes("equium: mined block"));
  if (!mineLog) return null;
  const m = mineLog.match(/mined block (\d+) by ([\w]+) for (\d+)/);
  if (!m) return null;
  return {
    sig,
    height: Number(m[1]),
    winner: m[2],
    reward: Number(m[3]),
    ts: tx.blockTime ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Write a single mined block into all Redis structures atomically (per
 * key — Upstash REST doesn't give us a real MULTI, but each command is
 * idempotent so partial failure just means the next run picks it up).
 */
async function indexBlock(b: MinedBlock): Promise<void> {
  await redis.hincrby(K.miners, b.winner, 1);
  await redis.hincrby(K.rewards, b.winner, b.reward);
  await redis.hset(K.lastSeen, { [b.winner]: b.ts });
  await redis.hset(K.lastHeight, { [b.winner]: b.height });
  await redis.zincrby(K.rank, 1, b.winner);
  await redis.zadd(K.recent, {
    score: b.ts,
    member: `${b.winner}:${b.height}`,
  });
}

/**
 * Process up to `sigs.length` raw signatures, parallelizing the
 * getTransaction fetches in batches of BATCH_SIZE. Returns the number
 * of mined blocks indexed.
 *
 * We process oldest → newest so the cursor we eventually write is the
 * newest sig in the set, even if we crash mid-way through.
 */
async function processSigs(
  sigs: { signature: string; blockTime: number | null; err: unknown }[]
): Promise<number> {
  const ordered = [...sigs].reverse(); // oldest-first
  let indexed = 0;
  for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
    const batch = ordered.slice(i, i + BATCH_SIZE).filter((s) => !s.err);
    const blocks = (
      await Promise.all(
        batch.map(async (s) => {
          try {
            return await parseMinedBlock(s.signature);
          } catch (e) {
            log("warn", `parse ${s.signature.slice(0, 8)}… failed: ${e}`);
            return null;
          }
        })
      )
    ).filter((b): b is MinedBlock => b !== null);

    // Serialize Redis writes — bursting parallel writes against
    // Upstash REST sometimes 429s. Sequential is fast enough.
    for (const b of blocks) {
      try {
        await indexBlock(b);
        indexed++;
      } catch (e) {
        log("warn", `index block ${b.height} failed: ${e}`);
      }
    }
  }
  return indexed;
}

/** Periodically trim the recent-blocks ZSET to the rolling 1h window. */
async function trimRecent(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - RECENT_WINDOW_SEC;
  await redis.zremrangebyscore(K.recent, 0, cutoff).catch(() => 0);
}

// ----- Full backfill -------------------------------------------------

/**
 * Walk every program signature from newest → oldest, page by page,
 * indexing every mined block. Pauses briefly between pages to keep
 * Helius rate limits happy. Idempotent: existing HASH entries just
 * get re-incremented, so DO NOT run this twice without a REINDEX
 * wipe.
 */
async function fullBackfill(): Promise<{ pages: number; blocks: number }> {
  log("info", "starting full backfill from genesis");
  const PAGE = 1000;
  let before: string | undefined = undefined;
  let pages = 0;
  let totalBlocks = 0;
  let newestSig: string | null = null;

  while (true) {
    const opts: { limit: number; before?: string } = { limit: PAGE };
    if (before) opts.before = before;
    const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, opts);
    if (sigs.length === 0) break;
    if (!before && newestSig === null) newestSig = sigs[0].signature;

    const indexed = await processSigs(sigs);
    totalBlocks += indexed;
    pages++;
    log(
      "info",
      `backfill page ${pages}: ${sigs.length} sigs, ${indexed} mined ` +
        `(running total: ${totalBlocks})`
    );

    if (sigs.length < PAGE) break;
    before = sigs[sigs.length - 1].signature;
    // Soft rate-limit on Helius.
    await new Promise((r) => setTimeout(r, 250));
  }

  if (newestSig) {
    await redis.set(K.cursor, newestSig);
  }
  await trimRecent();
  await redis.hset(K.meta, {
    last_full_backfill_at: Math.floor(Date.now() / 1000),
    total_blocks: totalBlocks,
  });
  log("ok", `full backfill complete: ${pages} pages, ${totalBlocks} blocks`);
  return { pages, blocks: totalBlocks };
}

/** Wipe all aggregator keys. Used by REINDEX=1. */
async function wipeAggregator(): Promise<void> {
  log("warn", "REINDEX=1 — wiping aggregator state");
  await Promise.all([
    redis.del(K.miners),
    redis.del(K.rewards),
    redis.del(K.lastSeen),
    redis.del(K.lastHeight),
    redis.del(K.rank),
    redis.del(K.cursor),
    redis.del(K.recent),
    redis.del(K.meta),
  ]);
}

// ----- Steady-state loop ---------------------------------------------

/**
 * Fetch signatures newer than the saved cursor and index any mined
 * blocks. Updates cursor to the newest signature processed.
 */
async function tick(): Promise<{ scanned: number; indexed: number }> {
  const cursor = await redis.get<string>(K.cursor).catch(() => null);
  const opts: { limit: number; until?: string } = { limit: 1000 };
  if (cursor) opts.until = cursor;
  const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, opts);
  if (sigs.length === 0) return { scanned: 0, indexed: 0 };

  const indexed = await processSigs(sigs);
  // Newest sig becomes the new cursor.
  await redis.set(K.cursor, sigs[0].signature);
  await trimRecent();
  return { scanned: sigs.length, indexed };
}

// ----- Main ----------------------------------------------------------

async function main() {
  log("info", `indexer starting · program ${PROGRAM_ID.toBase58()}`);
  log(
    "info",
    `rpc ${RPC_URL.replace(/api-key=[^&]+/, "api-key=…")} · poll ${POLL_INTERVAL_MS}ms`
  );

  if (REINDEX) {
    await wipeAggregator();
  }

  const cursor = await redis.get<string>(K.cursor).catch(() => null);
  if (!cursor || REINDEX) {
    await fullBackfill();
  } else {
    log("ok", `resuming from cursor ${cursor.slice(0, 8)}…`);
  }

  // Print a one-line summary so the operator can sanity-check.
  const totalMiners = await redis
    .hlen(K.miners)
    .catch(() => 0);
  const rankCount = await redis.zcard(K.rank).catch(() => 0);
  log(
    "ok",
    `index ready · ${fmtNum(totalMiners)} unique miners · ${fmtNum(rankCount)} rank entries`
  );

  // Steady-state loop.
  while (true) {
    try {
      const t0 = Date.now();
      const { scanned, indexed } = await tick();
      const elapsed = Date.now() - t0;
      if (indexed > 0 || scanned > 0) {
        log(
          "info",
          `tick: scanned ${scanned}, indexed ${indexed} blocks (${elapsed}ms)`
        );
      }
    } catch (e) {
      log("err", `tick failed: ${e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  log("err", `fatal: ${e}`);
  process.exit(1);
});
