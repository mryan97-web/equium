/**
 * Aggregated explorer state endpoint. Backed by Redis (lib/cache.ts);
 * the fetch* functions each go through cached() so this route's actual
 * cost is one Redis round-trip per field, not one Helius round-trip.
 *
 * We add edge HTTP caching on top: many users polling every 10s will
 * land within the same 5-second window, and Vercel's edge cache lets
 * them all share one rendered response. `stale-while-revalidate` keeps
 * things snappy when Redis expires entries.
 */

import { NextResponse } from "next/server";
import {
  fetchState,
  fetchRecentBlocks,
  fetchLeaderboard,
  fetchHashrateSeries,
  fetchAllTimeLeaderboard,
} from "@/lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [state, blocks, leaderboard, series, alltime] = await Promise.all([
    fetchState(),
    fetchRecentBlocks(12),
    fetchLeaderboard(200, 20),
    fetchHashrateSeries(200, 30),
    fetchAllTimeLeaderboard(50),
  ]);

  // If state is null we're in a degraded read (Redis empty + chain
  // failing). Don't cache that at the edge — let the next request try
  // a fresh fetch immediately instead of stamping `null` for 5 seconds.
  const cacheControl = state
    ? "public, max-age=0, s-maxage=5, stale-while-revalidate=30"
    : "no-store";

  return NextResponse.json(
    { state, blocks, leaderboard, series, alltime },
    { headers: { "cache-control": cacheControl } }
  );
}
