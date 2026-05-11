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
import { fetchAllTimeLeaderboardUncached } from "@/lib/rpc";

// The indexer (scripts/indexer.ts) is the source of truth for state +
// recent blocks + leaderboard + hashrate — those reads are now
// straight ZRANGE/HGET against keys the daemon maintains, no cron
// warming needed. The only remaining derived view is the all-time
// top-50, which still does a small ZREVRANGE + HMGET fan-out; we
// keep that one warm so concurrent /api/state requests share one
// assembly.

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
    // Pre-render the all-time top-50 from whatever the indexer has
    // populated. No history is written here.
    warm("equium:alltime:top:50:v1", TTL, () =>
      fetchAllTimeLeaderboardUncached(50)
    ),
  ]);

  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    alltime_top: results[0].status,
  });
}
