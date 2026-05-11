/**
 * One-shot inspector for the indexer's Redis state. Useful for
 * verifying the all-time aggregator looks right without going through
 * the explorer UI.
 */
import { Redis } from "@upstash/redis";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

const tryEnv = (p: string) => fs.existsSync(p) && dotenv.config({ path: p });
tryEnv(path.resolve(__dirname, "..", ".env"));
tryEnv(path.resolve(__dirname, "..", "clients", "website", ".env.local"));

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

async function main() {
  const [miners, totalBlocks, rank10, cursor, recentCount] = await Promise.all([
    redis.hlen("equium:alltime:miners:v1"),
    redis.hgetall<Record<string, number>>("equium:alltime:miners:v1"),
    redis.zrange<string[]>("equium:alltime:rank:v1", 0, 9, {
      rev: true,
      withScores: true,
    }),
    redis.get<string>("equium:alltime:cursor:v1"),
    redis.zcard("equium:recent:miner_blocks:v1"),
  ]);

  const totalSum = totalBlocks
    ? Object.values(totalBlocks).reduce((a, b) => a + Number(b), 0)
    : 0;

  console.log("=".repeat(60));
  console.log("Equium aggregator state");
  console.log("=".repeat(60));
  console.log(`unique miners:    ${miners}`);
  console.log(`total blocks:     ${totalSum}`);
  console.log(`recent (1h):      ${recentCount}`);
  console.log(`cursor:           ${cursor ? cursor.slice(0, 16) + "…" : "<none>"}`);
  console.log("");
  console.log("Top 10 miners:");
  for (let i = 0; i < (rank10 || []).length; i += 2) {
    const miner = String(rank10[i]);
    const blocks = Number(rank10[i + 1]);
    const rank = i / 2 + 1;
    console.log(`  #${rank.toString().padStart(2)} ${miner}  ${blocks} blocks`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
