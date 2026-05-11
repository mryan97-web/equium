/**
 * Paginated mined-block history.
 *
 * Walks `getSignaturesForAddress` with a `before=<sig>` cursor so the
 * client can keep loading older blocks until the user hits the genesis
 * round.
 *
 * Query params:
 *   - before: signature to start fetching before (optional; defaults
 *     to "newest"). Pass the sig of the last block from the previous
 *     page to get the next page.
 *   - limit: how many *mined blocks* to return (default 20). Note
 *     that scanning is denser than this — most program txs aren't
 *     "mine" instructions.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchBlocksPage } from "@/lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const before = url.searchParams.get("before") || undefined;
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 20));

  const { blocks, nextCursor } = await fetchBlocksPage(before, limit);
  return NextResponse.json(
    { blocks, nextCursor },
    {
      headers: {
        // Each page is keyed by its `before` cursor and is effectively
        // immutable (history doesn't rewrite itself), so cache at the
        // edge for 5 minutes.
        "cache-control":
          "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
