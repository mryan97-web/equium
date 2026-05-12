//! Browser-side Equihash solver: thin wasm-bindgen wrapper around
//! `equihash_core::solver`. The host (JS) is responsible for nonce
//! randomness — we take a 4-byte seed and increment internally per attempt
//! so the solve loop is deterministic + replayable for debugging.

use equihash_core::challenge::{build_input, I_LEN};
use equihash_core::solver::{solve, try_nonce_with_leaves as core_try_nonce_with_leaves};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct EquihashSolution {
    nonce: Vec<u8>,
    soln_indices: Vec<u8>,
    attempts: u32,
}

#[wasm_bindgen]
impl EquihashSolution {
    #[wasm_bindgen(getter)]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn soln_indices(&self) -> Vec<u8> {
        self.soln_indices.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

/// Solve one Equihash block.
///
/// - `n`, `k`: Equihash parameters (must match the on-chain config)
/// - `challenge`: 32-byte current challenge from the config PDA
/// - `miner`: 32-byte miner pubkey (the wallet that will sign the mine ix)
/// - `height`: current block height
/// - `max_attempts`: cap on nonce iterations before giving up
/// - `seed`: 32-byte random seed (caller supplies via crypto.getRandomValues)
///
/// Returns `null` if no solution found within `max_attempts`.
#[wasm_bindgen]
pub fn solve_block(
    n: u32,
    k: u32,
    challenge: &[u8],
    miner: &[u8],
    height: u64,
    max_attempts: u32,
    seed: &[u8],
) -> Option<EquihashSolution> {
    if challenge.len() != 32 || miner.len() != 32 || seed.len() != 32 {
        return None;
    }
    let mut c = [0u8; 32];
    c.copy_from_slice(challenge);
    let mut m = [0u8; 32];
    m.copy_from_slice(miner);
    let mut s = [0u8; 32];
    s.copy_from_slice(seed);

    let input: [u8; I_LEN] = build_input(&c, &m, height);

    let mut counter: u32 = 0;
    let result = solve(n, k, &input, || {
        counter = counter.wrapping_add(1);
        if counter > max_attempts {
            return None;
        }
        // Nonce = seed XOR counter (placed at the front so each attempt
        // produces a distinct, well-mixed input). The high 28 bytes of
        // `seed` mix in user-supplied entropy.
        let mut nonce = s;
        let bytes = counter.to_le_bytes();
        nonce[0] ^= bytes[0];
        nonce[1] ^= bytes[1];
        nonce[2] ^= bytes[2];
        nonce[3] ^= bytes[3];
        Some(nonce)
    })
    .ok()?;

    Some(EquihashSolution {
        nonce: result.nonce.to_vec(),
        soln_indices: result.soln_indices,
        attempts: counter,
    })
}

/// Hash candidate solution off-chain to check it falls under the on-chain
/// target — saves an RPC roundtrip if the solver returns an "above target"
/// solution. Mirrors `equihash_core::challenge::solution_hash`.
#[wasm_bindgen]
pub fn solution_hash(soln_indices: &[u8], input: &[u8]) -> Vec<u8> {
    equihash_core::challenge::solution_hash(soln_indices, input).to_vec()
}

/// Build the Equium I-block (`Equium-v1 || challenge || miner || height_le`).
/// Exposed so the JS side can pre-hash candidate solutions for the target
/// check above without re-implementing the layout.
#[wasm_bindgen]
pub fn build_input_block(challenge: &[u8], miner: &[u8], height: u64) -> Option<Vec<u8>> {
    if challenge.len() != 32 || miner.len() != 32 {
        return None;
    }
    let mut c = [0u8; 32];
    c.copy_from_slice(challenge);
    let mut m = [0u8; 32];
    m.copy_from_slice(miner);
    Some(build_input(&c, &m, height).to_vec())
}

/// Compress 32 raw u32 indices into the SPL-side packed format
/// (cbits+1 bits per index, packed big-endian). Equihash 96,5 ⇒
/// 17 bits × 32 indices = 544 bits = 68 bytes.
fn compress_indices_internal(n: u32, k: u32, indices: &[u32]) -> Vec<u8> {
    let cbits = (n / (k + 1)) as usize;
    let bits_per = cbits + 1;
    let total_bits = bits_per * indices.len();
    let total_bytes = total_bits.div_ceil(8);
    let mut out = vec![0u8; total_bytes];
    let mut pos = 0usize;
    for &idx in indices {
        for b in (0..bits_per).rev() {
            let bit = (idx >> b) & 1;
            let byte = pos / 8;
            let shift = 7 - (pos % 8);
            out[byte] |= (bit as u8) << shift;
            pos += 1;
        }
    }
    out
}

/// Full-GPU path (v0.4): the browser miner runs the entire Wagner
/// pipeline in WebGPU and hands a candidate solution (raw u32
/// indices) back here for the cheap CPU re-validation + compression
/// to the SPL submission format.
///
/// Returns the compressed solution bytes if the candidate passes the
/// upstream `is_valid_solution` check, `null` otherwise. Mirrors the
/// native miner's defense-in-depth before each `mine` tx.
#[wasm_bindgen]
pub fn validate_gpu_solution(
    n: u32,
    k: u32,
    input: &[u8],
    nonce: &[u8],
    indices: &[u32],
) -> Option<Vec<u8>> {
    if input.len() != I_LEN || nonce.len() != 32 || indices.is_empty() {
        return None;
    }
    let mut i_arr = [0u8; I_LEN];
    i_arr.copy_from_slice(input);
    let mut n_arr = [0u8; 32];
    n_arr.copy_from_slice(nonce);
    let compressed = compress_indices_internal(n, k, indices);
    if equihash::is_valid_solution(n, k, &i_arr, &n_arr, &compressed).is_ok() {
        Some(compressed)
    } else {
        None
    }
}

/// WebGPU hybrid path (v0.3): the host generates leaves on the GPU,
/// then hands them in here so the CPU does only the cheap Wagner +
/// validation pass per nonce. `leaves` must be exactly
/// `n_init_leaves(n, k) * (n/8)` bytes, tightly packed (the same
/// layout the native `gpu-miner` Wagner pipeline expects).
///
/// Returns the compressed solution indices, or `null` if this nonce
/// produces no valid solution.
#[wasm_bindgen]
pub fn try_nonce_with_leaves(
    n: u32,
    k: u32,
    input: &[u8],
    nonce: &[u8],
    leaves: &[u8],
) -> Option<Vec<u8>> {
    if input.len() != I_LEN || nonce.len() != 32 {
        return None;
    }
    let mut i_arr = [0u8; I_LEN];
    i_arr.copy_from_slice(input);
    let mut n_arr = [0u8; 32];
    n_arr.copy_from_slice(nonce);
    core_try_nonce_with_leaves(n, k, &i_arr, &n_arr, leaves)
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
