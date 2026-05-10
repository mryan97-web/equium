import { NextResponse } from "next/server";
import { fetchState, fetchRecentBlocks, fetchLeaderboard } from "@/lib/rpc";

export const dynamic = "force-dynamic";

export async function GET() {
  const [state, blocks, leaderboard] = await Promise.all([
    fetchState(),
    fetchRecentBlocks(12),
    fetchLeaderboard(200, 20),
  ]);
  return NextResponse.json({ state, blocks, leaderboard });
}
