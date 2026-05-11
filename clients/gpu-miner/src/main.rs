//! Equium GPU miner — v0.
//!
//! Scope today: GPU-accelerated leaf generation (the BLAKE2b-heavy
//! ~70% of solver time), with Wagner rounds still on the CPU. This is
//! a hybrid path; pure-GPU Wagner is a separate effort.
//!
//! Subcommands:
//!   * `verify`  — generate leaves on both GPU and CPU for a fixed
//!                 (input, nonce) pair and assert they match. Run this
//!                 once on a new machine to confirm the shader is
//!                 correct for your driver/backend.
//!   * `bench`   — measure GPU leaf-generation throughput.
//!   * `mine`    — run the full hybrid mining loop. (Not yet wired up
//!                 in v0; falls back to a message until next session.)

use anchor_lang::prelude::AccountMeta;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use crossbeam_channel::bounded;
use equihash_core::challenge::{build_input, solution_hash, I_LEN};
use equihash_core::solver::{leaf_bytes, n_init_leaves, try_nonce_with_leaves};
use equihash_core::target::hash_under_target;
use equium::state::{EquiumConfig, CONFIG_SEED, VAULT_SEED};
use solana_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair, Signer};
use solana_sdk::system_program;
use solana_sdk::sysvar;
use solana_sdk::transaction::Transaction;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod gpu;
mod shader_ref;

#[derive(Parser, Debug)]
#[command(version, about = "Equium GPU miner")]
struct Args {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Verify GPU leaf output matches the CPU reference for a fixed
    /// input/nonce. Use this to validate your driver before mining.
    Verify {
        /// How many leaves to verify. Default 2048 keeps the test fast
        /// (~ms) while still catching most byte-level shader bugs.
        #[arg(long, default_value_t = 2048u32)]
        leaves: u32,
    },
    /// Validate the shader *logic* without needing a GPU. Runs the
    /// pure-Rust port of leaves.wgsl against blake2b_simd byte-for-byte.
    /// If this fails, the WGSL kernel is wrong; if it passes, you can
    /// trust the GPU path to be correct barring a driver bug.
    VerifyCpu {
        #[arg(long, default_value_t = 8192u32)]
        leaves: u32,
    },
    /// Benchmark GPU leaf-generation throughput at full Equihash 96,5
    /// width (2^17 = 131,072 leaves).
    Bench {
        #[arg(long, default_value_t = 200u32)]
        iterations: u32,
    },
    /// Hybrid GPU/CPU mining. GPU does BLAKE2b leaf generation, CPU
    /// runs Wagner rounds, off-chain target check + tx submit happen
    /// per-attempt.
    Mine {
        /// RPC endpoint. Bring your own — public mainnet rate-limits.
        #[arg(long, default_value = "https://api.mainnet-beta.solana.com")]
        rpc_url: String,

        /// Solana keypair file to mine with.
        #[arg(long)]
        keypair: PathBuf,

        /// Stop after N successful blocks (0 = run forever).
        #[arg(long, default_value_t = 0u64)]
        max_blocks: u64,

        /// Compute-unit limit per `mine` tx.
        #[arg(long, default_value_t = 1_400_000u32)]
        cu_limit: u32,

        /// CPU worker threads. Default = num_cpus. Each thread requests
        /// leaves from the GPU and runs its own Wagner pass.
        #[arg(long, short = 't', default_value_t = 0)]
        threads: usize,
    },
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args = Args::parse();
    match args.cmd {
        Cmd::Verify { leaves } => verify(leaves),
        Cmd::VerifyCpu { leaves } => verify_cpu(leaves),
        Cmd::Bench { iterations } => bench(iterations),
        Cmd::Mine {
            rpc_url,
            keypair,
            max_blocks,
            cu_limit,
            threads,
        } => mine(rpc_url, keypair, max_blocks, cu_limit, threads),
    }
}

/// Build a deterministic (input, nonce) pair for verification. Doesn't
/// have to be a real chain challenge — we just want both code paths to
/// chew on identical bytes.
fn fixed_test_input() -> ([u8; I_LEN], [u8; 32]) {
    let mut input = [0u8; I_LEN];
    input[..9].copy_from_slice(b"Equium-v1");
    for i in 9..I_LEN {
        input[i] = (i as u8).wrapping_mul(7).wrapping_add(13);
    }
    let mut nonce = [0u8; 32];
    for i in 0..32 {
        nonce[i] = (i as u8).wrapping_mul(31).wrapping_add(2);
    }
    (input, nonce)
}

fn verify(n_leaves: u32) -> Result<()> {
    let gpu = gpu::GpuLeafGen::new()?;
    println!("GPU backend: {}", gpu.adapter_name);

    let (input, nonce) = fixed_test_input();

    let mut gpu_out = vec![0u8; (n_leaves as usize) * gpu::LEAF_BYTES];
    let t0 = Instant::now();
    gpu.generate(&input, &nonce, n_leaves, &mut gpu_out)?;
    let gpu_ms = t0.elapsed().as_millis();

    let t1 = Instant::now();
    let cpu_out = cpu_leaves_reference(&input, &nonce, n_leaves);
    let cpu_ms = t1.elapsed().as_millis();

    let mut mismatches = 0usize;
    let mut first_mismatch_at = None;
    for i in 0..(n_leaves as usize) {
        let g = &gpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
        let c = &cpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
        if g != c {
            mismatches += 1;
            if first_mismatch_at.is_none() {
                first_mismatch_at = Some(i);
            }
        }
    }

    println!(
        "leaves: {}   gpu: {:>5}ms   cpu: {:>5}ms   match: {}/{}",
        n_leaves,
        gpu_ms,
        cpu_ms,
        n_leaves as usize - mismatches,
        n_leaves
    );

    if mismatches == 0 {
        println!("✓ GPU output matches CPU reference byte-for-byte.");
        Ok(())
    } else {
        if let Some(i) = first_mismatch_at {
            let g = &gpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
            let c = &cpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
            println!("first mismatch at leaf {i}:");
            println!("  gpu: {}", hex::encode(g));
            println!("  cpu: {}", hex::encode(c));
        }
        bail!("{} leaves differ between GPU and CPU", mismatches);
    }
}

/// CPU-only validation. Compares the Rust port of the shader logic
/// (src/shader_ref.rs) against the canonical blake2b_simd output. Catches
/// shader-logic bugs (arithmetic, packing, control flow) without
/// needing a GPU at all.
fn verify_cpu(n_leaves: u32) -> Result<()> {
    let (input, nonce) = fixed_test_input();

    let t_ref = Instant::now();
    let cpu_out = cpu_leaves_reference(&input, &nonce, n_leaves);
    let cpu_ms = t_ref.elapsed().as_millis();

    let t_shader = Instant::now();
    let shader_out = shader_ref::leaves(&input, &nonce, n_leaves);
    let shader_ms = t_shader.elapsed().as_millis();

    let mut mismatches = 0usize;
    let mut first_mismatch_at = None;
    for i in 0..(n_leaves as usize) {
        let g = &shader_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
        let c = &cpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
        if g != c {
            mismatches += 1;
            if first_mismatch_at.is_none() {
                first_mismatch_at = Some(i);
            }
        }
    }

    println!(
        "leaves: {}   shader-port: {:>4}ms   blake2b_simd ref: {:>4}ms   match: {}/{}",
        n_leaves,
        shader_ms,
        cpu_ms,
        n_leaves as usize - mismatches,
        n_leaves
    );

    if mismatches == 0 {
        println!("✓ shader logic matches BLAKE2b reference byte-for-byte.");
        println!("  GPU path should be correct on real hardware (subject to driver).");
        Ok(())
    } else {
        if let Some(i) = first_mismatch_at {
            let g = &shader_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
            let c = &cpu_out[i * gpu::LEAF_BYTES..(i + 1) * gpu::LEAF_BYTES];
            println!("first mismatch at leaf {i}:");
            println!("  shader-port: {}", hex::encode(g));
            println!("  blake2b ref: {}", hex::encode(c));
        }
        bail!("{} leaves differ between shader logic and BLAKE2b reference", mismatches);
    }
}

fn bench(iterations: u32) -> Result<()> {
    let gpu = gpu::GpuLeafGen::new()?;
    println!("GPU backend: {}", gpu.adapter_name);

    let (input, nonce) = fixed_test_input();
    let n_leaves: u32 = 1 << 17; // 131,072 — full Equihash 96,5 width
    let mut out = vec![0u8; (n_leaves as usize) * gpu::LEAF_BYTES];

    // Warm-up dispatch (shader compile, pipeline cache).
    gpu.generate(&input, &nonce, n_leaves, &mut out)?;

    let t0 = Instant::now();
    for _ in 0..iterations {
        gpu.generate(&input, &nonce, n_leaves, &mut out)?;
    }
    let elapsed = t0.elapsed();
    let total_leaves = (iterations as u64) * (n_leaves as u64);
    let leaves_per_sec = total_leaves as f64 / elapsed.as_secs_f64();
    let hashes_per_sec = leaves_per_sec / (gpu::LEAVES_PER_CALL as f64);

    println!(
        "{} iterations × {} leaves in {:.2}s",
        iterations,
        n_leaves,
        elapsed.as_secs_f64()
    );
    println!(
        "leaf throughput:    {:>12.0} leaves/sec  ({:.1} MLeaves/s)",
        leaves_per_sec,
        leaves_per_sec / 1_000_000.0
    );
    println!(
        "BLAKE2b throughput: {:>12.0} hashes/sec  ({:.1} MH/s)",
        hashes_per_sec,
        hashes_per_sec / 1_000_000.0
    );

    Ok(())
}

// ============================================================================
// Mining loop
// ============================================================================

const EQUIHASH_N: u32 = 96;
const EQUIHASH_K: u32 = 5;

struct RaceWinner {
    nonce: [u8; 32],
    soln_indices: Vec<u8>,
}

fn mine(
    rpc_url: String,
    keypair_path: PathBuf,
    max_blocks: u64,
    cu_limit: u32,
    threads: usize,
) -> Result<()> {
    let gpu = Arc::new(gpu::GpuLeafGen::new()?);
    println!("GPU backend: {}", gpu.adapter_name);

    let miner_kp = read_keypair_file(&keypair_path)
        .map_err(|e| anyhow!("read keypair {}: {}", keypair_path.display(), e))?;
    let miner = miner_kp.pubkey();

    let program_id = equium::ID;
    let rpc = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], &program_id);
    let (vault_pda, _) = Pubkey::find_program_address(&[VAULT_SEED], &program_id);

    let token_program_id = {
        let cfg = fetch_config(&rpc, &config_pda)?;
        let mint = rpc.get_account(&cfg.mint).context("fetch mint")?;
        mint.owner
    };

    let thread_count = if threads == 0 { num_cpus::get().max(1) } else { threads };
    println!(
        "miner   {}\nprogram {}\nrpc     {}\nthreads {} CPU + 1 shared GPU\n",
        short_pk(&miner),
        short_pk(&program_id),
        truncate(&rpc_url, 60),
        thread_count
    );

    let mut current_height: u64 = u64::MAX;
    let mut try_in_round: u32 = 0;
    let mut blocks_mined: u64 = 0;
    let mut total_nonces: u64 = 0;
    let started_at = Instant::now();

    loop {
        let cfg = fetch_config(&rpc, &config_pda)?;
        if !cfg.mining_open {
            println!("mining not open yet — sleeping 5s");
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        let miner_ata = get_associated_token_address_with_program_id(&miner, &cfg.mint, &token_program_id);

        if cfg.block_height != current_height {
            current_height = cfg.block_height;
            try_in_round = 0;
            println!(
                "\nround #{}  prize {} EQM  target 0x{}…",
                cfg.block_height,
                format_reward(cfg.current_epoch_reward),
                hex::encode(&cfg.current_target[..4])
            );
        }

        let input = build_input(&cfg.current_challenge, &miner.to_bytes(), cfg.block_height);
        let race_started = Instant::now();
        let race_result = race_for_solution_gpu(
            gpu.clone(),
            &input,
            &cfg.current_target,
            thread_count,
            // Per-thread nonce budget. Smaller than the CPU miner's because
            // each attempt costs a GPU round-trip; we'd rather refetch
            // config more often to avoid stale-challenge waste.
            64,
        );

        let elapsed = race_started.elapsed();
        match race_result {
            Some((winner, nonces_tried)) => {
                total_nonces = total_nonces.saturating_add(nonces_tried);
                try_in_round += 1;
                let session_secs = started_at.elapsed().as_secs_f64().max(0.001);
                let hashrate = total_nonces as f64 / session_secs;

                // Re-verify off-chain.
                let cand_hash = solution_hash(&winner.soln_indices, &input);
                if !hash_under_target(&cand_hash, &cfg.current_target) {
                    // This shouldn't happen — the race already checked target.
                    eprintln!("internal: winner above target, skipping");
                    continue;
                }

                match submit_mine(
                    &rpc,
                    &miner_kp,
                    &program_id,
                    &config_pda,
                    &cfg,
                    &vault_pda,
                    &miner_ata,
                    &token_program_id,
                    &winner.nonce,
                    winner.soln_indices.clone(),
                    cu_limit,
                ) {
                    Ok(sig) => {
                        blocks_mined += 1;
                        println!(
                            "  ✓ MINED  +{} EQM  try #{}  {}ms  {}",
                            format_reward(cfg.current_epoch_reward),
                            try_in_round,
                            elapsed.as_millis(),
                            fmt_hashrate(hashrate)
                        );
                        println!("    sig {}", short_sig(&sig));

                        if max_blocks > 0 && blocks_mined >= max_blocks {
                            println!("\nsession complete · {} blocks · {}", blocks_mined, fmt_hashrate(hashrate));
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        let reason = classify_submit_err(&e.to_string());
                        println!("  · submit failed: {}  ({}ms)", reason, elapsed.as_millis());
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
            None => {
                let n = (thread_count as u64) * 64;
                total_nonces = total_nonces.saturating_add(n);
                try_in_round += 1;
                let session_secs = started_at.elapsed().as_secs_f64().max(0.001);
                let hashrate = total_nonces as f64 / session_secs;
                println!(
                    "  · try #{}  exhausted  {}ms  {}",
                    try_in_round,
                    elapsed.as_millis(),
                    fmt_hashrate(hashrate)
                );
            }
        }
    }
}

/// Spawn `threads` CPU workers; each grinds nonces, dispatching leaf
/// generation to the shared GPU and running Wagner CPU-side. First
/// thread to find a below-target solution wins.
fn race_for_solution_gpu(
    gpu: Arc<gpu::GpuLeafGen>,
    input: &[u8; I_LEN],
    target: &[u8; 32],
    threads: usize,
    max_per_thread: u64,
) -> Option<(RaceWinner, u64)> {
    let stop = Arc::new(AtomicBool::new(false));
    let total_nonces = Arc::new(AtomicU64::new(0));
    let (tx, rx) = bounded::<RaceWinner>(1);

    let n_leaves = n_init_leaves(EQUIHASH_N, EQUIHASH_K) as u32;
    let leaf_size = leaf_bytes(EQUIHASH_N);

    let mut handles = Vec::with_capacity(threads);
    for _ in 0..threads {
        let gpu = gpu.clone();
        let input = *input;
        let target = *target;
        let stop = stop.clone();
        let total = total_nonces.clone();
        let tx = tx.clone();
        handles.push(std::thread::spawn(move || {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            let mut leaves_buf = vec![0u8; (n_leaves as usize) * leaf_size];
            let mut tried = 0u64;
            while tried < max_per_thread && !stop.load(Ordering::Relaxed) {
                let mut nonce = [0u8; 32];
                rng.fill(&mut nonce);
                tried += 1;

                // GPU: generate leaves for this nonce. Errors here are
                // logged but don't crash the worker — usually transient
                // (device timeout, driver hiccup); we just try the next nonce.
                if gpu.generate(&input, &nonce, n_leaves, &mut leaves_buf).is_err() {
                    continue;
                }

                if let Some(soln) =
                    try_nonce_with_leaves(EQUIHASH_N, EQUIHASH_K, &input, &nonce, &leaves_buf)
                {
                    let h = solution_hash(&soln, &input);
                    if hash_under_target(&h, &target) {
                        let _ = tx.send(RaceWinner { nonce, soln_indices: soln });
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
            total.fetch_add(tried, Ordering::Relaxed);
        }));
    }
    drop(tx);

    let winner = rx.recv_timeout(Duration::from_secs(600)).ok();
    stop.store(true, Ordering::Relaxed);
    for h in handles {
        let _ = h.join();
    }
    let nonces_tried = total_nonces.load(Ordering::Relaxed);
    winner.map(|w| (w, nonces_tried))
}

// ============================================================================
// Solana RPC + helpers (mostly mirroring cli-miner)
// ============================================================================

fn fetch_config(rpc: &RpcClient, config_pda: &Pubkey) -> Result<EquiumConfig> {
    let acct = rpc.get_account(config_pda)?;
    let mut data = acct.data.as_slice();
    let cfg = EquiumConfig::try_deserialize(&mut data)?;
    Ok(cfg)
}

#[allow(clippy::too_many_arguments)]
fn submit_mine(
    rpc: &RpcClient,
    miner_kp: &Keypair,
    program_id: &Pubkey,
    config_pda: &Pubkey,
    cfg: &EquiumConfig,
    vault_pda: &Pubkey,
    miner_ata: &Pubkey,
    token_program_id: &Pubkey,
    nonce: &[u8; 32],
    soln_indices: Vec<u8>,
    cu_limit: u32,
) -> Result<String> {
    let miner = miner_kp.pubkey();
    let accounts = equium::accounts::Mine {
        miner,
        config: *config_pda,
        mint: cfg.mint,
        mineable_vault: *vault_pda,
        miner_ata: *miner_ata,
        token_program: *token_program_id,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: system_program::ID,
        slot_hashes: sysvar::slot_hashes::ID,
    }
    .to_account_metas(None);
    let accounts: Vec<AccountMeta> = accounts
        .into_iter()
        .map(|m| AccountMeta {
            pubkey: m.pubkey,
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect();
    let data = equium::instruction::Mine { nonce: *nonce, soln_indices }.data();
    let ix = Instruction { program_id: *program_id, accounts, data };
    let cu_ix = ComputeBudgetInstruction::set_compute_unit_limit(cu_limit);

    let recent = rpc.get_latest_blockhash()?;
    let tx = Transaction::new_signed_with_payer(&[cu_ix, ix], Some(&miner), &[miner_kp], recent);
    let sig = rpc.send_and_confirm_transaction(&tx)?;
    Ok(sig.to_string())
}

fn classify_submit_err(s: &str) -> &'static str {
    if s.contains("0x1773") || s.contains("AboveTarget") {
        "above target"
    } else if s.contains("0x1772") || s.contains("InvalidEquihash") {
        "invalid equihash"
    } else if s.contains("0x1774") || s.contains("StaleChallenge") {
        "stale challenge"
    } else if s.contains("BlockhashNotFound") {
        "blockhash expired"
    } else {
        "submit error"
    }
}

fn format_reward(base: u64) -> String {
    let whole = base / 1_000_000;
    let frac = base % 1_000_000;
    if frac == 0 {
        whole.to_string()
    } else {
        format!("{}.{:06}", whole, frac).trim_end_matches('0').to_string()
    }
}

fn fmt_hashrate(h: f64) -> String {
    if h >= 1000.0 {
        format!("{:.1} kH/s", h / 1000.0)
    } else {
        format!("{:.1} H/s", h)
    }
}

fn short_pk(pk: &Pubkey) -> String {
    let s = pk.to_string();
    format!("{}…{}", &s[..4], &s[s.len() - 4..])
}

fn short_sig(s: &str) -> String {
    if s.len() <= 12 { s.to_string() } else { format!("{}…{}", &s[..6], &s[s.len() - 6..]) }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() > n { format!("{}…", &s[..n]) } else { s.to_string() }
}

// silence Pubkey::from_str unused warning if any
const _: fn() = || {
    let _ = Pubkey::from_str;
};

// ============================================================================
// CPU reference (for verify, verify-cpu, bench)
// ============================================================================

/// CPU reference: replicate exactly what `equihash_core::solver::solve`
/// does to generate the first `n_leaves` leaves. Uses the upstream
/// `blake2b_simd` directly so the comparison is at the byte level.
fn cpu_leaves_reference(input: &[u8; I_LEN], nonce: &[u8; 32], n_leaves: u32) -> Vec<u8> {
    use blake2b_simd::Params;

    let mut personal = [0u8; 16];
    personal[..8].copy_from_slice(b"ZcashPoW");
    personal[8..12].copy_from_slice(&96u32.to_le_bytes());
    personal[12..16].copy_from_slice(&5u32.to_le_bytes());

    let base_state = Params::new()
        .hash_length(60)
        .personal(&personal)
        .to_state();

    let mut state_with_input = base_state.clone();
    state_with_input.update(input);
    state_with_input.update(nonce);

    let mut out = Vec::with_capacity((n_leaves as usize) * gpu::LEAF_BYTES);
    // Same loop as the shader: one BLAKE2b call per index, yields
    // gpu::LEAVES_PER_CALL leaves of LEAF_BYTES each.
    let n_calls = (n_leaves + gpu::LEAVES_PER_CALL - 1) / gpu::LEAVES_PER_CALL;
    for call_idx in 0..n_calls {
        let mut s = state_with_input.clone();
        s.update(&call_idx.to_le_bytes());
        let h = s.finalize();
        let bytes = h.as_bytes(); // 60 bytes
        for k in 0..(gpu::LEAVES_PER_CALL as usize) {
            let leaf_idx = (call_idx * gpu::LEAVES_PER_CALL) as usize + k;
            if leaf_idx >= n_leaves as usize {
                break;
            }
            out.extend_from_slice(&bytes[k * gpu::LEAF_BYTES..(k + 1) * gpu::LEAF_BYTES]);
        }
    }
    out
}
