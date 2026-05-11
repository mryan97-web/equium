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
} from "@/lib/rpc";

// NOTE: this route no longer calls `updateAllTimeAggregator`. The
// all-time miner index is owned by the standalone indexer process
// (scripts/indexer.ts) running continuously on the server — Vercel
// cron is unreliable for our use case (Hobby tier rate-limits, cold
// starts) and a server-side indexer can walk the entire history from
// genesis on first run. Cron is reduced to pre-warming the read-side
// caches so /api/state stays snappy.

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
    // Read-side: re-render the all-time top-50 from whatever the
    // indexer has populated. We don't write any new history here.
    warm(
      "equium:alltime:top:50:v1",
      TTL,
      () => fetchAllTimeLeaderboardUncached(50)
    ),
  ]);

  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    state: results[0].status,
    blocks: results[1].status,
    leaderboard: results[2].status,
    hashrate: results[3].status,
    alltime_top: results[4].status,
  });
}
