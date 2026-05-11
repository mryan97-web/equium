"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const STORAGE_KEY = "equium:rpc-override";

/** Mask `?api-key=…` segments so we don't accidentally render anyone's key
 * in the dashboard if they happen to share their screen. */
function maskUrl(url: string): string {
  try {
    return url.replace(/(api-key=)[^&]+/i, (_, k) => `${k}…`);
  } catch {
    return url;
  }
}

function isLikelyValidRpc(url: string): { ok: boolean; reason?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false };
  if (!/^https?:\/\//i.test(trimmed))
    return { ok: false, reason: "must start with https://" };
  if (trimmed.includes("api.mainnet-beta.solana.com"))
    return {
      ok: false,
      reason: "that's the public throttled endpoint — get a Helius key instead",
    };
  if (trimmed.includes("api.devnet.solana.com"))
    return { ok: false, reason: "that's devnet — we're on mainnet now" };
  return { ok: true };
}

interface Props {
  /** Called whenever the saved override changes. Lets the parent re-render
   * dependent state (e.g., un-disable the Start button). */
  onChange?: (url: string | null) => void;
}

export function RpcGate({ onChange }: Props) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      setSaved(v && v.length > 0 ? v : null);
      if (!v) setEditing(true);
    } catch {
      setEditing(true);
    }
  }, []);

  const validation = touched ? isLikelyValidRpc(draft) : { ok: true };

  const save = () => {
    setTouched(true);
    const v = isLikelyValidRpc(draft);
    if (!v.ok) return;
    try {
      localStorage.setItem(STORAGE_KEY, draft.trim());
    } catch {}
    setSaved(draft.trim());
    setDraft("");
    setEditing(false);
    onChange?.(draft.trim());
    // Force a fresh page-load so all callers pick up the new RPC_URL
    // (it's captured once at module load via clientRpcUrl()).
    window.location.reload();
  };

  const clear = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setSaved(null);
    setEditing(true);
    onChange?.(null);
    window.location.reload();
  };

  // Saved state — compact display with edit/remove
  if (saved && !editing) {
    return (
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-mint)] mb-1 font-semibold flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-mint)]" />
            Using your RPC
          </div>
          <div className="font-mono text-[12.5px] text-[var(--color-fg-soft)] truncate">
            {maskUrl(saved)}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => {
              setDraft(saved);
              setEditing(true);
            }}
            className="px-3 py-1.5 rounded-full text-[12px] font-mono font-semibold border border-[var(--color-border-bright)] text-[var(--color-fg-soft)] hover:bg-white/[0.04]"
          >
            Edit
          </button>
          <button
            onClick={clear}
            className="px-3 py-1.5 rounded-full text-[12px] font-mono font-semibold border border-[var(--color-border-bright)] text-[var(--color-fg-soft)] hover:bg-white/[0.04]"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  // Setup / edit state — gold-accented panel so it reads as a required step
  return (
    <div className="rounded-3xl border border-[var(--color-gold)]/40 bg-[var(--color-gold)]/[0.06] p-6 md:p-7">
      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--color-gold)] mb-2 font-semibold flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-gold)]" />
        Required to mine
      </div>
      <h3 className="text-[22px] md:text-[24px] font-black tracking-[-0.015em] mb-2">
        Plug in your RPC.
      </h3>
      <p className="text-[14px] leading-[1.6] text-[var(--color-fg-dim)] mb-4 max-w-2xl">
        Mining in the browser needs a Solana RPC endpoint for transaction
        submission and live state polling. We can't share ours — one
        miner saturates a free tier in minutes.{" "}
        <Link
          href="/docs/rpc"
          className="text-[var(--color-rose)] font-semibold hover:underline"
        >
          Grab a free Helius key here
        </Link>{" "}
        — 5 minutes, no credit card, 100k requests/day.
      </p>

      <div className="space-y-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (!touched) setTouched(true);
          }}
          placeholder="https://mainnet.helius-rpc.com/?api-key=…"
          spellCheck={false}
          className={`w-full rounded-2xl bg-[var(--color-bg)] border px-4 py-3 font-mono text-[13px] text-[var(--color-fg)] outline-none ${
            touched && !validation.ok
              ? "border-[var(--color-rose)]"
              : "border-[var(--color-border-bright)] focus:border-[var(--color-rose)]"
          }`}
        />
        {touched && !validation.ok && validation.reason && (
          <p className="text-[12px] text-[var(--color-rose)] font-mono">
            {validation.reason}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={save}
            disabled={!draft.trim()}
            className="px-5 py-2.5 rounded-full bg-[var(--color-rose)] text-[var(--color-bg)] text-[13px] font-bold hover:bg-[var(--color-rose-bright)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save RPC
          </button>
          {saved && (
            <button
              onClick={() => {
                setEditing(false);
                setDraft("");
                setTouched(false);
              }}
              className="px-4 py-2.5 rounded-full text-[13px] font-medium text-[var(--color-fg-soft)] hover:bg-white/[0.04]"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] font-mono text-[var(--color-fg-faint)] mt-4 leading-[1.6]">
        Stored only in this browser's localStorage. Never sent to us.
      </p>
    </div>
  );
}

/** Read the currently-saved override, if any. Used by the dashboard to
 * decide whether to enable the Start button. */
export function hasRpcOverride(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return !!(v && v.length > 0 && /^https?:\/\//i.test(v));
  } catch {
    return false;
  }
}
