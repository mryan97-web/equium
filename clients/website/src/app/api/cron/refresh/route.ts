/**
 * Pre-warm the explorer cache in Redis. Idempotent; running it more often
 * than the TTLs just keeps the cache fresh, which means users never wait
 * for a cold chain read.
 *
 * Wire this to a Vercel cron job (vercel.json) or any external scheduler
 * (cron-job.org, GitHub Actions, etc.). If `CRON_SECRET` is set, the
 * caller must send `Authorization: Bearer <secret>`.
 */

import { NextRequest, NextResponse } from "next/server";
import { warm } from "@/lib/cache";
import {
  fetchStateUncached,
  fetchRecentBlocksUncached,
  fetchLeaderboardUncached,
  fetchHashrateSeriesUncached,
  fetchAllTimeLeaderboardUncached,
  updateAllTimeAggregator,
} from "@/lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = req.headers.get("authorization");
    if (got !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // TTLs match `cached()` in lib/rpc.ts. They're intentionally longer
  // than the cron interval (60s, see vercel.json) so the cache always
  // outlives one refresh cycle — even if cron misses or runs late, the
  // next user request still hits a warm Redis entry instead of paying
  // a multi-second Helius round trip.
  const TTL = 90;
  const t0 = Date.now();
  const results = await Promise.allSettled([
    warm("equium:state:v1", TTL, fetchStateUncached),
    warm("equium:blocks:12:v1", TTL, () => fetchRecentBlocksUncached(12)),
    warm("equium:leaderboard:200:20:v1", TTL, () =>
      fetchLeaderboardUncached(200, 20)
    ),
    warm("equium:hashrate:200:30:v1", TTL, () =>
      fetchHashrateSeriesUncached(200, 30)
    ),
    // Incrementally extend the all-time miner aggregator. First run
    // scans the recent 1000 signatures and seeds the HASHes; later
    // runs only process new ones (via the saved cursor) so the chain
    // cost per tick stays cheap.
    updateAllTimeAggregator(),
  ]);

  // After the aggregator has run, pre-render the cached top-50 from
  // the freshly-updated Redis state. Subsequent /api/state requests
  // read this cached blob instead of redoing the ZREVRANGE + HMGET
  // assembly per request.
  const topResult = await warm(
    "equium:alltime:top:50:v1",
    TTL,
    () => fetchAllTimeLeaderboardUncached(50)
  );

  const allTime = results[4];
  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    state: results[0].status,
    blocks: results[1].status,
    leaderboard: results[2].status,
    hashrate: results[3].status,
    alltime:
      allTime.status === "fulfilled"
        ? { processed: allTime.value.processed, newest: allTime.value.newest }
        : { error: String((allTime as PromiseRejectedResult).reason) },
    alltime_top:
      topResult && Array.isArray(topResult) ? topResult.length : 0,
  });
}
