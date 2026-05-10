import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { ExplorerDashboard } from "@/components/ExplorerDashboard";
import {
  fetchState,
  fetchRecentBlocks,
  fetchLeaderboard,
} from "@/lib/rpc";

export const revalidate = 0;

export default async function ExplorerPage() {
  const [state, blocks, leaderboard] = await Promise.all([
    fetchState(),
    fetchRecentBlocks(12),
    fetchLeaderboard(200, 20),
  ]);

  return (
    <main>
      <Navbar />
      <div className="pt-32 pb-16 px-6">
        <div className="max-w-6xl mx-auto">
          <ExplorerDashboard
            initialState={state}
            initialBlocks={blocks}
            initialLeaderboard={leaderboard}
          />
        </div>
      </div>
      <Footer />
    </main>
  );
}
