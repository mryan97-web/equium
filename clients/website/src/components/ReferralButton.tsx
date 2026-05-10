"use client";

import { useState } from "react";

interface Props {
  pubkey: string;
}

export function ReferralButton({ pubkey }: Props) {
  const [copied, setCopied] = useState(false);

  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/mine?ref=${pubkey}`
      : `/mine?ref=${pubkey}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {}
  };

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-5">
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--color-fg-dim)] mb-1.5 font-semibold flex items-center gap-2">
            <RingIcon />
            Your mining link
          </div>
          <div className="text-[13px] font-mono text-[var(--color-fg-soft)] truncate">
            {link}
          </div>
          <div className="text-[12px] text-[var(--color-fg-dim)] mt-1">
            Share this link to invite others. We'll track who you brought in —
            and reward it when referral economics ship.
          </div>
        </div>
        <button
          onClick={copy}
          className="flex-shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-rose)] text-[var(--color-bg)] text-[13px] font-bold hover:bg-[var(--color-rose-bright)] transition-colors"
        >
          {copied ? "✓ Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

function RingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
