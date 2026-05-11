# Equium server scripts

## indexer.ts — explorer data sync

Continuously syncs the Equium program's full block history into Upstash
Redis so the explorer can serve all-time stats without ever touching
chain on a page load.

### Why a server-side daemon

The previous design used a Vercel cron route to incrementally
aggregate stats. Two problems:

1. Vercel's Hobby tier rate-limits cron frequency. Pro tier is
   reliable but we want this to work regardless of plan.
2. First-run scan was capped at the most recent 1000 signatures.
   Anything older was invisible to the explorer.

This script runs persistently on the same box that holds the rest of
the project, walks every program signature from genesis on first run,
then polls for new ones every 10 seconds. The explorer reads
pre-aggregated values out of Redis — no chain scans per page.

### Setup

```bash
cd /home/ubuntu/Equium

# Sanity check (loads env from clients/website/.env.local automatically):
npx tsx scripts/indexer.ts
# Ctrl-C once you see "index ready · N unique miners".

# Wipe + full backfill (only after schema changes or recovery):
REINDEX=1 npx tsx scripts/indexer.ts

# Install as a system service:
sudo cp scripts/indexer.service /etc/systemd/system/equium-indexer.service
sudo systemctl daemon-reload
sudo systemctl enable --now equium-indexer.service

# Watch:
sudo journalctl -u equium-indexer -f
```

### Env vars

The script reads from process env, falling back to
`clients/website/.env.local`. Required:

| var | purpose |
|---|---|
| `SOLANA_RPC_URL` | Helius (or other) mainnet RPC URL with API key |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash write token |
| `PROGRAM_ID` | Equium program (defaults to mainnet `ZKGMUfxiRCXFPnqz9zgqAnuqJy15jk7fKbR4o6FuEQM`) |
| `POLL_INTERVAL_MS` | Steady-state poll cadence (default 10000) |
| `BATCH_SIZE` | getTransaction parallelism (default 10) |
| `REINDEX` | Set to `1` to wipe + backfill from genesis |

### Redis schema

Documented in the indexer source. Read path lives in
`clients/website/src/lib/rpc.ts` (`fetchAllTimeLeaderboard`).

## Other scripts

- `init-localnet.ts` — bootstrap a fresh program on localnet.
- `deploy-devnet.sh` — devnet deploy pipeline.
- `seed-target.ts` — set initial difficulty target post-init.
- `verify-bench` — bench/run helper.
