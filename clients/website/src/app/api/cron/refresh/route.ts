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

  const t0 = Date.now();
  const results = await Promise.allSettled([
    warm("equium:state:v1", 10, fetchStateUncached),
    warm("equium:blocks:12:v1", 20, () => fetchRecentBlocksUncached(12)),
    warm("equium:leaderboard:200:20:v1", 60, () =>
      fetchLeaderboardUncached(200, 20)
    ),
    warm("equium:hashrate:200:30:v1", 30, () =>
      fetchHashrateSeriesUncached(200, 30)
    ),
  ]);

  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    state: results[0].status,
    blocks: results[1].status,
    leaderboard: results[2].status,
    hashrate: results[3].status,
  });
}
