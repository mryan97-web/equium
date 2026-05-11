import { useState } from "react";
import { lockWallet, type WalletStatus } from "../lib/api";
import { shortPk } from "../lib/format";
import SettingsModal from "./SettingsModal";

type Props = {
  status?: WalletStatus;
  onLocked?: () => void;
};

export default function TopBar({ status, onLocked }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onLock = async () => {
    await lockWallet();
    onLocked?.();
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Equium</span>
          <span className="brand-tag">miner</span>
        </div>
        <div className="topbar-right">
          {status?.status === "unlocked" && (
            <span className="pill pill-ok">
              <span className="dot dot-ok" />
              {shortPk(status.pubkey, 4, 4)}
            </span>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            Settings
          </button>
          {status?.status === "unlocked" && (
            <button className="btn" onClick={onLock}>
              Lock
            </button>
          )}
        </div>
      </header>
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}
