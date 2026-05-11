import { useEffect, useState } from "react";
import { walletStatus, type WalletStatus } from "./lib/api";
import SetupWizard from "./components/SetupWizard";
import UnlockScreen from "./components/UnlockScreen";
import MineDashboard from "./components/MineDashboard";
import TopBar from "./components/TopBar";

export default function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);

  const refresh = async () => {
    try {
      const s = await walletStatus();
      setStatus(s);
    } catch (e) {
      console.error("wallet_status failed", e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!status) {
    return (
      <div className="app">
        <TopBar />
        <div className="main">
          <div className="empty">loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar status={status} onLocked={refresh} />
      <div className="main">
        {status.status === "needs-setup" && (
          <SetupWizard onDone={refresh} />
        )}
        {status.status === "needs-unlock" && (
          <UnlockScreen pubkey={status.pubkey} onUnlocked={refresh} />
        )}
        {status.status === "unlocked" && (
          <MineDashboard pubkey={status.pubkey} />
        )}
      </div>
    </div>
  );
}
