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

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use equihash_core::challenge::I_LEN;
use std::time::Instant;

mod gpu;

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
    /// Benchmark GPU leaf-generation throughput at full Equihash 96,5
    /// width (2^17 = 131,072 leaves).
    Bench {
        #[arg(long, default_value_t = 200u32)]
        iterations: u32,
    },
    /// Hybrid GPU/CPU mining loop. Not wired in v0 — see README for
    /// the roadmap.
    Mine,
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args = Args::parse();
    match args.cmd {
        Cmd::Verify { leaves } => verify(leaves),
        Cmd::Bench { iterations } => bench(iterations),
        Cmd::Mine => {
            println!("mining loop not wired up yet. v0 only covers leaf generation —");
            println!("use `cargo run -p equium-cli-miner` for actual mining today, or");
            println!("`equium-gpu-miner verify` / `bench` to exercise the GPU path.");
            Ok(())
        }
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
