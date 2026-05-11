import { useEffect, useRef, useState } from "react";
import {
  getProgramState,
  getWalletBalances,
  startMining,
  stopMining,
  minerStatus,
  exportSecret,
  onMinerLog,
  onMinerAttempt,
  onMinerBlock,
  onMinerRound,
  onMinerStatus,
  type Balances,
  type ProgramState,
  type LogEvent,
  type MinerStats,
} from "../lib/api";
import {
  EQM_DECIMALS,
  fmtHashrate,
  fmtUptime,
  formatEqm,
  formatSol,
  shortPk,
} from "../lib/format";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

type Props = {
  pubkey: string;
};

type DashLog = LogEvent & { ts: number };

const MAX_LOGS = 200;

export default function MineDashboard({ pubkey }: Props) {
  const [program, setProgram] = useState<ProgramState | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [stats, setStats] = useState<MinerStats | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<DashLog[]>([]);
  const [hashrate, setHashrate] = useState(0);
  const [secretVisible, setSecretVisible] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Initial fetch + periodic refresh of read-only state.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [p, b, s] = await Promise.all([
          getProgramState().catch(() => null),
          getWalletBalances().catch(() => null),
          minerStatus().catch(() => null),
        ]);
        if (!alive) return;
        if (p) setProgram(p);
        if (b) setBalances(b);
        if (s) {
          setRunning(s.running);
          setStats(s.stats);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Wire up event subscriptions.
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    onMinerLog((e) => {
      setLogs((prev) => {
        const next = [...prev, { ...e, ts: Date.now() }];
        if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
        return next;
      });
    }).then((u) => unlistens.push(u));
    onMinerAttempt((e) => {
      setHashrate(e.hashrate_hs);
      setStats((s) =>
        s
          ? {
              ...s,
              try_in_round: e.try_in_round,
              cumulative_nonces: e.cumulative_nonces,
            }
          : s
      );
    }).then((u) => unlistens.push(u));
    onMinerBlock((e) => {
      setStats((s) =>
        s
          ? {
              ...s,
              blocks_mined: e.blocks_mined,
              total_earned_base: e.total_earned_base,
              last_log: `mined #${e.height}`,
            }
          : s
      );
      // refresh balances soon-ish after a block
      setTimeout(() => {
        getWalletBalances().then(setBalances).catch(() => {});
      }, 1500);
    }).then((u) => unlistens.push(u));
    onMinerRound(() => {
      // No-op; round info is captured via attempts/logs.
    }).then((u) => unlistens.push(u));
    onMinerStatus((e) => setRunning(e.running)).then((u) =>
      unlistens.push(u)
    );
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  // Auto-scroll log box.
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const onStart = async () => {
    try {
      const s = await startMining();
      setRunning(s.running);
      setStats(s.stats);
    } catch (e: any) {
      setLogs((prev) => [
        ...prev,
        { ts: Date.now(), level: "err", message: String(e) },
      ]);
    }
  };
  const onStop = async () => {
    try {
      const s = await stopMining();
      setRunning(s.running);
      setStats(s.stats);
    } catch (e: any) {
      setLogs((prev) => [
        ...prev,
        { ts: Date.now(), level: "err", message: String(e) },
      ]);
    }
  };

  const revealSecret = async () => {
    if (secret) {
      setSecretVisible(!secretVisible);
      return;
    }
    try {
      const s = await exportSecret();
      setSecret(s);
      setSecretVisible(true);
    } catch (e) {
      console.error(e);
    }
  };

  const insufficientSol = (balances?.sol_lamports ?? 0) < 5_000_000; // 0.005 SOL
  const miningOpen = program?.mining_open ?? false;
  const startedAt = stats?.started_at_unix_ms ?? 0;
  const uptime = running && startedAt > 0 ? Date.now() - startedAt : 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <HeroPanel
        running={running}
        miningOpen={miningOpen}
        insufficientSol={insufficientSol}
        onStart={onStart}
        onStop={onStop}
      />

      <div className="grid-3">
        <StatCard
          label="Blocks mined"
          value={stats?.blocks_mined ?? 0}
          sub={running ? "session in progress" : "since last start"}
        />
        <StatCard
          label="Total earned"
          value={`${formatEqm(stats?.total_earned_base ?? 0, EQM_DECIMALS)} EQM`}
          sub={`balance: ${formatEqm(balances?.eqm_base ?? 0, EQM_DECIMALS)} EQM`}
        />
        <StatCard
          label="Hashrate"
          value={fmtHashrate(hashrate)}
          sub={`uptime ${fmtUptime(uptime)}`}
        />
      </div>

      <div className="grid-2">
        <div className="card stack">
          <h3>Wallet</h3>
          <div className="row-between">
            <div className="mono" style={{ fontSize: 13 }}>
              {shortPk(pubkey, 6, 6)}
            </div>
            <button className="copybtn" onClick={() => writeText(pubkey)}>
              Copy address
            </button>
          </div>
          <div className="divider" />
          <div className="row-between">
            <div>
              <div className="stat-label">SOL</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {balances ? formatSol(balances.sol_lamports) : "—"}
              </div>
            </div>
            <div>
              <div className="stat-label">EQM</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {balances
                  ? formatEqm(balances.eqm_base, EQM_DECIMALS)
                  : "—"}
              </div>
            </div>
          </div>
          {insufficientSol && (
            <div className="alert alert-warn">
              Fund this wallet with a small amount of SOL to cover mining tx
              fees (~0.005 SOL covers ~30 attempts).
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={revealSecret}>
              {secretVisible ? "Hide secret" : "Export secret"}
            </button>
            {secret && secretVisible && (
              <button
                className="copybtn"
                onClick={() => writeText(secret)}
              >
                Copy
              </button>
            )}
          </div>
          {secret && secretVisible && (
            <div className="secret-box mono">{secret}</div>
          )}
        </div>

        <div className="card stack">
          <h3>Network</h3>
          {program ? (
            <>
              <Row k="Mining open" v={
                program.mining_open ? (
                  <span className="pill pill-ok">
                    <span className="dot dot-ok" /> live
                  </span>
                ) : (
                  <span className="pill pill-warn">
                    <span className="dot dot-warn" /> not yet
                  </span>
                )
              } />
              <Row k="Block height" v={program.block_height} />
              <Row
                k="Reward"
                v={`${formatEqm(program.epoch_reward, EQM_DECIMALS)} EQM / block`}
              />
              <Row
                k="Target prefix"
                v={
                  <span className="mono dim" style={{ fontSize: 12 }}>
                    0x{program.current_target_hex.slice(0, 8)}…
                  </span>
                }
              />
              <Row
                k="Equihash"
                v={
                  <span className="mono">
                    ({program.equihash_n}, {program.equihash_k})
                  </span>
                }
              />
              <Row
                k="Mint"
                v={
                  <button
                    className="copybtn mono"
                    onClick={() => writeText(program.mint)}
                    title="Click to copy"
                  >
                    {shortPk(program.mint, 6, 6)}
                  </button>
                }
              />
            </>
          ) : (
            <div className="muted">Reading on-chain state…</div>
          )}
          <div className="divider" />
          <button
            className="btn btn-ghost"
            onClick={() => openUrl("https://equium.xyz/docs/rpc")}
            style={{ alignSelf: "flex-start" }}
          >
            Set up your own RPC →
          </button>
        </div>
      </div>

      <div className="card stack">
        <div className="row-between">
          <h3>Activity</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            try #{stats?.try_in_round ?? 0} · {(stats?.cumulative_nonces ?? 0).toLocaleString()} nonces
          </span>
        </div>
        <div className="log" ref={logBoxRef}>
          {logs.length === 0 && (
            <div className="dim">
              No activity yet. Click Start to begin mining.
            </div>
          )}
          {logs.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>
              {fmtTime(l.ts)} {l.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeroPanel({
  running,
  miningOpen,
  insufficientSol,
  onStart,
  onStop,
}: {
  running: boolean;
  miningOpen: boolean;
  insufficientSol: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const status = running
    ? { label: "Mining", className: "pill pill-ok", dot: "dot-ok" }
    : miningOpen
      ? { label: "Idle", className: "pill", dot: "dot-warn" }
      : { label: "Network not open", className: "pill pill-bad", dot: "dot-bad" };

  return (
    <div className="card">
      <div className="row-between">
        <div>
          <h1>
            {running ? "Mining Equium" : "Ready to mine"}
          </h1>
          <p className="muted" style={{ marginTop: 6 }}>
            {running
              ? "Your CPU is solving Equihash puzzles and submitting solutions to Solana."
              : miningOpen
                ? "Click Start. Each block found mints 25 EQM into your wallet."
                : "The protocol vault hasn't been funded yet — check back soon."}
          </p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className={status.className}>
            <span className={`dot ${status.dot}`} />
            {status.label}
          </span>
          {running ? (
            <button className="btn btn-danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={onStart}
              disabled={!miningOpen || insufficientSol}
              title={
                !miningOpen
                  ? "Mining not open yet"
                  : insufficientSol
                    ? "Wallet needs SOL for fees"
                    : ""
              }
            >
              Start mining
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-num">{value}</div>
      {sub && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="row-between">
      <span className="muted" style={{ fontSize: 13 }}>
        {k}
      </span>
      <span>{v}</span>
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
