"use client";

// Reads `?ref=<pubkey>` from the URL, persists it to localStorage so the
// banner survives a wallet-connect redirect, and shows a subtle banner.
// Purely cosmetic for now — no on-chain referral protocol exists yet,
// but this primes the data so we can wire one in later.

import { useEffect, useState } from "react";

const STORAGE_KEY = "equium:referrer";

export function ReferralBanner() {
  const [ref, setRef] = useState<string | null>(null);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get("ref");
      const stored = localStorage.getItem(STORAGE_KEY);
      const value = fromUrl ?? stored;
      if (fromUrl && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(fromUrl)) {
        localStorage.setItem(STORAGE_KEY, fromUrl);
      }
      if (value && value.length >= 32) setRef(value);
    } catch {}
  }, []);

  if (!ref) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-rose-soft)] bg-[var(--color-rose-soft)]/30 px-5 py-3 flex items-center gap-3 mb-6">
      <span className="text-[18px]">🤝</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--color-rose-bright)] font-semibold">
          Invited
        </div>
        <div className="text-[13px] text-[var(--color-fg-soft)] truncate">
          You arrived via a referral from{" "}
          <a
            href={`https://explorer.solana.com/address/${ref}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-semibold text-[var(--color-rose-bright)] hover:underline"
          >
            {short(ref)}
          </a>
        </div>
      </div>
    </div>
  );
}

function short(s: string): string {
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}
