//! Pure-Rust port of `shaders/leaves.wgsl`, line-by-line.
//!
//! Lets us verify the shader's *logic* (BLAKE2b math, byte packing,
//! initialization, output extraction) without an actual GPU. If the
//! Rust port produces the same bytes as `blake2b_simd`, the WGSL
//! shader will too — barring a driver bug, which is rare for compute
//! shaders this simple.
//!
//! This module mirrors the WGSL one-to-one so changes to either side
//! must be reflected in the other. If they ever diverge, `verify-cpu`
//! catches it.

type U64 = (u32, u32); // (lo, hi), like vec2<u32> in WGSL

fn u64_add(a: U64, b: U64) -> U64 {
    let lo = a.0.wrapping_add(b.0);
    let carry = if lo < a.0 { 1 } else { 0 };
    let hi = a.1.wrapping_add(b.1).wrapping_add(carry);
    (lo, hi)
}

fn u64_xor(a: U64, b: U64) -> U64 {
    (a.0 ^ b.0, a.1 ^ b.1)
}

fn u64_rotr(a: U64, n: u32) -> U64 {
    if n == 32 {
        return (a.1, a.0);
    }
    if n < 32 {
        let lo = (a.0 >> n) | (a.1 << (32 - n));
        let hi = (a.1 >> n) | (a.0 << (32 - n));
        return (lo, hi);
    }
    let m = n - 32;
    let swapped = (a.1, a.0);
    let lo = (swapped.0 >> m) | (swapped.1 << (32 - m));
    let hi = (swapped.1 >> m) | (swapped.0 << (32 - m));
    (lo, hi)
}

const IV: [U64; 8] = [
    (0xf3bcc908, 0x6a09e667),
    (0x84caa73b, 0xbb67ae85),
    (0xfe94f82b, 0x3c6ef372),
    (0x5f1d36f1, 0xa54ff53a),
    (0xade682d1, 0x510e527f),
    (0x2b3e6c1f, 0x9b05688c),
    (0xfb41bd6b, 0x1f83d9ab),
    (0x137e2179, 0x5be0cd19),
];

#[rustfmt::skip]
const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

fn compress(h: &mut [U64; 8], block: &[U64; 16], t: U64, f: u32) {
    let mut v: [U64; 16] = [(0, 0); 16];
    v[..8].copy_from_slice(h);
    v[8] = IV[0];
    v[9] = IV[1];
    v[10] = IV[2];
    v[11] = IV[3];
    v[12] = u64_xor(IV[4], t);
    v[13] = IV[5];
    v[14] = (IV[6].0 ^ f, IV[6].1 ^ f);
    v[15] = IV[7];

    for r in 0..12 {
        let s = &SIGMA[r];

        macro_rules! g {
            ($a:expr, $b:expr, $c:expr, $d:expr, $x:expr, $y:expr) => {{
                v[$a] = u64_add(u64_add(v[$a], v[$b]), block[s[$x]]);
                v[$d] = u64_rotr(u64_xor(v[$d], v[$a]), 32);
                v[$c] = u64_add(v[$c], v[$d]);
                v[$b] = u64_rotr(u64_xor(v[$b], v[$c]), 24);
                v[$a] = u64_add(u64_add(v[$a], v[$b]), block[s[$y]]);
                v[$d] = u64_rotr(u64_xor(v[$d], v[$a]), 16);
                v[$c] = u64_add(v[$c], v[$d]);
                v[$b] = u64_rotr(u64_xor(v[$b], v[$c]), 63);
            }};
        }

        g!(0, 4, 8, 12, 0, 1);
        g!(1, 5, 9, 13, 2, 3);
        g!(2, 6, 10, 14, 4, 5);
        g!(3, 7, 11, 15, 6, 7);
        g!(0, 5, 10, 15, 8, 9);
        g!(1, 6, 11, 12, 10, 11);
        g!(2, 7, 8, 13, 12, 13);
        g!(3, 4, 9, 14, 14, 15);
    }

    for i in 0..8 {
        h[i] = u64_xor(u64_xor(h[i], v[i]), v[i + 8]);
    }
}

/// Compute the 60-byte BLAKE2b digest for one (input, nonce, call_idx)
/// triple, exactly as the WGSL kernel would.
pub fn kernel_digest(
    personalization: &[u8; 16],
    digest_len: u32,
    input: &[u8; 81],
    nonce: &[u8; 32],
    call_idx: u32,
) -> [u8; 60] {
    // h_init = IV ^ param_block
    let mut h = IV;
    let p0_lo = digest_len | (1u32 << 16) | (1u32 << 24);
    h[0].0 ^= p0_lo;
    h[6] = u64_xor(
        h[6],
        (
            u32::from_le_bytes(personalization[0..4].try_into().unwrap()),
            u32::from_le_bytes(personalization[4..8].try_into().unwrap()),
        ),
    );
    h[7] = u64_xor(
        h[7],
        (
            u32::from_le_bytes(personalization[8..12].try_into().unwrap()),
            u32::from_le_bytes(personalization[12..16].try_into().unwrap()),
        ),
    );

    // Build the 128-byte block as 32 LE u32 words. Layout:
    //   bytes 0..81   : input
    //   bytes 81..113 : nonce
    //   bytes 113..117: call_idx LE
    //   bytes 117..128: zero pad
    let mut block_bytes = [0u8; 128];
    block_bytes[0..81].copy_from_slice(input);
    block_bytes[81..113].copy_from_slice(nonce);
    block_bytes[113..117].copy_from_slice(&call_idx.to_le_bytes());

    let mut block: [U64; 16] = [(0, 0); 16];
    for i in 0..16 {
        let lo = u32::from_le_bytes(block_bytes[i * 8..i * 8 + 4].try_into().unwrap());
        let hi = u32::from_le_bytes(block_bytes[i * 8 + 4..i * 8 + 8].try_into().unwrap());
        block[i] = (lo, hi);
    }

    // t = 117 bytes processed (81 + 32 + 4); f = 0xFFFFFFFF (final block).
    let t = (117u32, 0u32);
    compress(&mut h, &block, t, 0xFFFFFFFF);

    // Extract first digest_len bytes.
    let mut out = [0u8; 60];
    for i in 0..8 {
        let bytes = [
            h[i].0.to_le_bytes(),
            h[i].1.to_le_bytes(),
        ]
        .concat();
        for (j, b) in bytes.iter().enumerate() {
            let pos = i * 8 + j;
            if pos < out.len() {
                out[pos] = *b;
            }
        }
    }
    out
}

// ============================================================================
// Wagner round port (v0.2: full-GPU pipeline)
// ============================================================================
//
// Mirrors what the `rounds.wgsl` compute shader does, one-to-one, so we
// can validate the algorithm without an actual GPU. Equihash 96,5 has
// cbits=16, cbytes=2, n_init = 2^17, and runs 5 rounds; after the last
// round, surviving rows with an all-zero hash and 32 indices are
// candidate solutions.
//
// The GPU shape we mirror:
//   * Fixed-size rows: 3 hash words (u32 LE) + 32 indices (u32) = 35 u32
//     per row, padded to 36 for vec4 alignment.
//   * Counting sort over 2^16 = 65,536 buckets, capped at MAX_PER_BUCKET
//     entries (rare overflow loses pairs but does not corrupt state).
//   * Pair emission: each input row scans its bucket for higher-indexed
//     peers, applies distinct_indices, XOR-trim, canonical concat.

pub const HASH_WORDS: usize = 3;
pub const INDICES_MAX: usize = 32;
pub const NUM_BUCKETS: usize = 1 << 16;
pub const MAX_PER_BUCKET: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowFixed {
    pub hash: [u32; HASH_WORDS],
    pub indices: [u32; INDICES_MAX],
}

impl RowFixed {
    pub fn zero() -> Self {
        Self { hash: [0; HASH_WORDS], indices: [0; INDICES_MAX] }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RoundParams {
    /// Number of u32 indices used in the input rows (1, 2, 4, 8, 16).
    pub indices_count_in: u32,
}

/// Pack 12 bytes of leaf into a `RowFixed` with `indices = [leaf_idx]`.
pub fn pack_initial_row(leaf: &[u8], leaf_idx: u32) -> RowFixed {
    assert_eq!(leaf.len(), 12);
    let mut row = RowFixed::zero();
    for w in 0..HASH_WORDS {
        row.hash[w] = u32::from_le_bytes(leaf[w * 4..(w + 1) * 4].try_into().unwrap());
    }
    row.indices[0] = leaf_idx;
    row
}

/// Bucket id = first 2 bytes of the hash. Encoding is byte0 in the high
/// half and byte1 in the low half — it just has to be consistent between
/// `bucket_count` and `pair_emit`. Matches the WGSL kernel.
fn extract_bucket(hash: &[u32; HASH_WORDS]) -> u32 {
    let w0 = hash[0];
    let b0 = w0 & 0xFFu32;
    let b1 = (w0 >> 8) & 0xFFu32;
    (b0 << 8) | b1
}

/// O(n²) disjoint check on indices, matching the upstream verifier and
/// `equihash_core::solver::distinct_indices`. Operates on the live prefix
/// of each row's indices array.
fn distinct_indices_kernel(a: &RowFixed, b: &RowFixed, count: u32) -> bool {
    let n = count as usize;
    for i in 0..n {
        let x = a.indices[i];
        for j in 0..n {
            if x == b.indices[j] {
                return false;
            }
        }
    }
    true
}

/// XOR the two hashes (u32-wise — equivalent to byte-wise since XOR is
/// independent of endian) and shift left by 2 bytes (cbytes=2 for
/// Equihash 96,5). Trailing bytes propagate zeros naturally as long as
/// the input rows had properly-masked trailing bytes (true by induction
/// starting from raw 12-byte leaves).
fn xor_and_trim(a: &[u32; HASH_WORDS], b: &[u32; HASH_WORDS]) -> [u32; HASH_WORDS] {
    let h0 = a[0] ^ b[0];
    let h1 = a[1] ^ b[1];
    let h2 = a[2] ^ b[2];
    [
        (h0 >> 16) | (h1 << 16),
        (h1 >> 16) | (h2 << 16),
        h2 >> 16,
    ]
}

/// Concatenate index lists in canonical tree order — smaller-by-first
/// goes first. Matches `equihash_core::solver::concat_canonical`. Writes
/// `2 * indices_count_in` u32s starting at index 0 of `out`.
fn canonical_concat(
    a: &RowFixed,
    b: &RowFixed,
    indices_count_in: u32,
    out: &mut [u32; INDICES_MAX],
) {
    let n = indices_count_in as usize;
    let (first, second) = if a.indices[0] < b.indices[0] { (a, b) } else { (b, a) };
    out[..n].copy_from_slice(&first.indices[..n]);
    out[n..2 * n].copy_from_slice(&second.indices[..n]);
}

/// Run one Wagner round in the GPU's shape:
///   1. Counting sort: histogram into NUM_BUCKETS, store row indices into
///      `bucket_slots[bucket * MAX_PER_BUCKET + slot]` (overflow silently
///      drops — astronomically rare for 131k/65k with MAX=16).
///   2. Pair emit: for each input row `i`, iterate its bucket; for each
///      peer `j` with `j > i` and disjoint indices, emit (XOR-trim hash,
///      canonical-concat indices).
///
/// The output order is *not* deterministic relative to the CPU's
/// sort-then-pair order, but the output *set* is identical (modulo
/// pair-permutation, which canonical_concat collapses). Callers should
/// sort by (hash, indices) before comparison if they care about order.
pub fn round_kernel(rows_in: &[RowFixed], params: RoundParams) -> Vec<RowFixed> {
    // Pass 1: histogram + scatter into bucket-head slots.
    let mut counts = vec![0u32; NUM_BUCKETS];
    let mut slots = vec![0u32; NUM_BUCKETS * MAX_PER_BUCKET];
    for (i, row) in rows_in.iter().enumerate() {
        let bucket = extract_bucket(&row.hash) as usize;
        let slot = counts[bucket] as usize;
        counts[bucket] += 1;
        if slot < MAX_PER_BUCKET {
            slots[bucket * MAX_PER_BUCKET + slot] = i as u32;
        }
    }

    // Pass 2: pair emit. Each row scans its bucket; emits only against
    // peers with strictly larger row index so each pair is emitted once.
    let mut out = Vec::new();
    for (i, row) in rows_in.iter().enumerate() {
        let i_u = i as u32;
        let bucket = extract_bucket(&row.hash) as usize;
        let cnt = (counts[bucket] as usize).min(MAX_PER_BUCKET);
        let base = bucket * MAX_PER_BUCKET;
        for s in 0..cnt {
            let j = slots[base + s];
            if j <= i_u {
                continue;
            }
            let other = &rows_in[j as usize];
            if !distinct_indices_kernel(row, other, params.indices_count_in) {
                continue;
            }
            let new_hash = xor_and_trim(&row.hash, &other.hash);
            let mut new_indices = [0u32; INDICES_MAX];
            canonical_concat(row, other, params.indices_count_in, &mut new_indices);
            out.push(RowFixed { hash: new_hash, indices: new_indices });
        }
    }
    out
}

/// Run the full 5-round Wagner pipeline on pre-generated leaves, then
/// scan for solutions (rows with all-zero hash and 32 indices). Returns
/// candidate compressed-indices solutions in the same order they were
/// discovered. The caller is responsible for the final
/// `equihash::is_valid_solution` re-check.
pub fn wagner_full(leaves: &[u8]) -> Vec<RowFixed> {
    let n_init = leaves.len() / 12;
    let mut rows: Vec<RowFixed> = (0..n_init)
        .map(|i| pack_initial_row(&leaves[i * 12..(i + 1) * 12], i as u32))
        .collect();

    // 5 rounds for (96, 5).
    for r in 0..5 {
        let indices_count_in = 1u32 << r; // 1, 2, 4, 8, 16
        rows = round_kernel(&rows, RoundParams { indices_count_in });
    }

    // Solutions: rows with all-zero hash after 5 rounds.
    rows.into_iter()
        .filter(|r| r.hash == [0, 0, 0])
        .collect()
}

/// Generate `n_leaves` leaves using the same kernel logic the WGSL
/// shader implements, for direct byte-level comparison.
pub fn leaves(input: &[u8; 81], nonce: &[u8; 32], n_leaves: u32) -> Vec<u8> {
    let mut personal = [0u8; 16];
    personal[..8].copy_from_slice(b"ZcashPoW");
    personal[8..12].copy_from_slice(&96u32.to_le_bytes());
    personal[12..16].copy_from_slice(&5u32.to_le_bytes());

    let mut out = Vec::with_capacity(n_leaves as usize * 12);
    let n_calls = n_leaves.div_ceil(5);
    for call_idx in 0..n_calls {
        let digest = kernel_digest(&personal, 60, input, nonce, call_idx);
        for k in 0..5 {
            let leaf_idx = call_idx * 5 + k;
            if leaf_idx >= n_leaves {
                break;
            }
            out.extend_from_slice(&digest[k as usize * 12..(k as usize + 1) * 12]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use blake2b_simd::Params;

    /// Mirror what the CPU solver does so we have a trusted reference.
    fn reference(input: &[u8; 81], nonce: &[u8; 32], call_idx: u32) -> [u8; 60] {
        let mut personal = [0u8; 16];
        personal[..8].copy_from_slice(b"ZcashPoW");
        personal[8..12].copy_from_slice(&96u32.to_le_bytes());
        personal[12..16].copy_from_slice(&5u32.to_le_bytes());

        let mut s = Params::new().hash_length(60).personal(&personal).to_state();
        s.update(input);
        s.update(nonce);
        s.update(&call_idx.to_le_bytes());

        let mut out = [0u8; 60];
        out.copy_from_slice(s.finalize().as_bytes());
        out
    }

    fn make_input(seed: u8) -> [u8; 81] {
        let mut input = [0u8; 81];
        input[..9].copy_from_slice(b"Equium-v1");
        for i in 9..81 {
            input[i] = (i as u8).wrapping_mul(seed).wrapping_add(seed);
        }
        input
    }

    fn make_nonce(seed: u8) -> [u8; 32] {
        let mut nonce = [0u8; 32];
        for i in 0..32 {
            nonce[i] = (i as u8).wrapping_mul(seed.wrapping_add(11)).wrapping_add(3);
        }
        nonce
    }

    #[test]
    fn u64_rotr_matches_native_for_blake2b_rotations() {
        // BLAKE2b only uses {32, 24, 16, 63}, but check a broader range
        // since the implementation handles n < 32 and n > 32 separately.
        for n in [16u32, 24, 32, 63, 1, 31, 33, 47] {
            for val in [0u64, 1, 0x0123456789ABCDEF, u64::MAX, 0xDEADBEEFCAFEBABE] {
                let port = u64_rotr((val as u32, (val >> 32) as u32), n);
                let port_u64 = (port.0 as u64) | ((port.1 as u64) << 32);
                let native = val.rotate_right(n);
                assert_eq!(port_u64, native, "rotr({val:#x}, {n}) port={port_u64:#x} native={native:#x}");
            }
        }
    }

    #[test]
    fn u64_add_carries_correctly() {
        let cases = [
            (0u64, 0u64),
            (1, 1),
            (u32::MAX as u64, 1),         // carry into hi
            (u64::MAX, 1),                // wrap around
            (0xFFFFFFFF, 0xFFFFFFFF),     // both u32::MAX
            (0x0123456789ABCDEF, 0xFEDCBA9876543210),
        ];
        for (a, b) in cases {
            let pa = (a as u32, (a >> 32) as u32);
            let pb = (b as u32, (b >> 32) as u32);
            let port = u64_add(pa, pb);
            let port_u64 = (port.0 as u64) | ((port.1 as u64) << 32);
            let native = a.wrapping_add(b);
            assert_eq!(port_u64, native, "{a:#x} + {b:#x} port={port_u64:#x} native={native:#x}");
        }
    }

    #[test]
    fn first_leaf_matches_blake2b_simd() {
        let input = make_input(7);
        let nonce = make_nonce(13);
        let mut personal = [0u8; 16];
        personal[..8].copy_from_slice(b"ZcashPoW");
        personal[8..12].copy_from_slice(&96u32.to_le_bytes());
        personal[12..16].copy_from_slice(&5u32.to_le_bytes());
        let got = kernel_digest(&personal, 60, &input, &nonce, 0);
        let want = reference(&input, &nonce, 0);
        assert_eq!(got, want, "call_idx=0 mismatch");
    }

    #[test]
    fn matches_across_many_call_indices() {
        let input = make_input(7);
        let nonce = make_nonce(13);
        let mut personal = [0u8; 16];
        personal[..8].copy_from_slice(b"ZcashPoW");
        personal[8..12].copy_from_slice(&96u32.to_le_bytes());
        personal[12..16].copy_from_slice(&5u32.to_le_bytes());
        // Spread coverage: low indices, mid, near u24 boundary (where
        // the upper byte of the index counter starts to mix in), and
        // near u32::MAX (one-shot finalization edge cases).
        for &idx in &[0u32, 1, 4, 5, 100, 65_535, 65_536, 26_213, 26_214, 1_000_000, u32::MAX - 1, u32::MAX] {
            let got = kernel_digest(&personal, 60, &input, &nonce, idx);
            let want = reference(&input, &nonce, idx);
            assert_eq!(got, want, "call_idx={idx} mismatch");
        }
    }

    #[test]
    fn matches_across_different_inputs() {
        let mut personal = [0u8; 16];
        personal[..8].copy_from_slice(b"ZcashPoW");
        personal[8..12].copy_from_slice(&96u32.to_le_bytes());
        personal[12..16].copy_from_slice(&5u32.to_le_bytes());
        for seed in 1u8..=20 {
            let input = make_input(seed);
            let nonce = make_nonce(seed.wrapping_add(50));
            for idx in [0u32, 1, 13, 999] {
                let got = kernel_digest(&personal, 60, &input, &nonce, idx);
                let want = reference(&input, &nonce, idx);
                assert_eq!(
                    got, want,
                    "seed={seed} idx={idx} mismatch"
                );
            }
        }
    }

    #[test]
    fn leaves_function_matches_reference_at_full_width() {
        let input = make_input(7);
        let nonce = make_nonce(13);
        let n_leaves: u32 = 1 << 17; // full Equihash 96,5 width
        let shader_out = leaves(&input, &nonce, n_leaves);
        // Compare leaf-by-leaf to the reference.
        for leaf_idx in (0..n_leaves).step_by(257) {
            let call_idx = leaf_idx / 5;
            let k = (leaf_idx % 5) as usize;
            let digest = reference(&input, &nonce, call_idx);
            let want = &digest[k * 12..(k + 1) * 12];
            let got = &shader_out[(leaf_idx as usize) * 12..((leaf_idx as usize) + 1) * 12];
            assert_eq!(got, want, "leaf {leaf_idx} mismatch");
        }
    }
}

#[cfg(test)]
mod wgsl_tests {
    //! WGSL syntax + type + uniformity validation, run in `cargo test`
    //! via the `naga` front-end (which is the same compiler wgpu uses
    //! internally). Catches structural shader bugs on machines without
    //! a GPU adapter.
    use naga::valid::{Capabilities, ValidationFlags, Validator};

    fn validate(source: &str, label: &str) {
        let module = naga::front::wgsl::parse_str(source)
            .unwrap_or_else(|e| panic!("{label}: WGSL parse failed:\n{}", e.emit_to_string(source)));
        let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
        validator
            .validate(&module)
            .unwrap_or_else(|e| panic!("{label}: WGSL validation failed: {e:?}"));
    }

    #[test]
    fn leaves_wgsl_validates() {
        validate(include_str!("shaders/leaves.wgsl"), "leaves.wgsl");
    }

    #[test]
    fn rounds_wgsl_validates() {
        validate(include_str!("shaders/rounds.wgsl"), "rounds.wgsl");
    }
}

#[cfg(test)]
mod round_tests {
    //! Round-by-round validation of the GPU-shape Wagner kernel.
    //!
    //! Strategy: generate real leaves at full (96, 5) width, then run
    //! both:
    //!   * `round_kernel` — the GPU-shape Rust port we ship to WGSL
    //!   * `cpu_round_reference` — an inline mirror of
    //!     `equihash_core::solver::round` operating on byte-slice hashes
    //!
    //! After each round the output rows are sorted by (hash, indices) and
    //! compared as multisets. If the two diverge at any round, the GPU
    //! port has an algorithm bug that WGSL would inherit.
    //!
    //! No actual GPU is involved — these tests run anywhere `cargo test`
    //! does.
    use super::*;

    /// Reference (byte-shape) Wagner round, mirroring
    /// `equihash_core::solver::round` exactly. Operates on `(hash_bytes,
    /// indices)` pairs and returns the same. Used only in tests.
    fn cpu_round_reference(
        rows: Vec<(Vec<u8>, Vec<u32>)>,
        cbits: usize,
    ) -> Vec<(Vec<u8>, Vec<u32>)> {
        let cbytes = cbits.div_ceil(8);
        let mut sorted = rows;
        sorted.sort_by(|a, b| a.0.cmp(&b.0));

        let first_cbits_eq = |a: &[u8], b: &[u8]| -> bool {
            let full = cbits / 8;
            if a[..full] != b[..full] {
                return false;
            }
            let rem = cbits % 8;
            if rem == 0 {
                return true;
            }
            let mask = 0xFFu8 << (8 - rem);
            (a[full] & mask) == (b[full] & mask)
        };
        let distinct = |a: &[u32], b: &[u32]| -> bool {
            for x in a {
                for y in b {
                    if x == y {
                        return false;
                    }
                }
            }
            true
        };

        let mut out = Vec::new();
        let mut i = 0;
        while i < sorted.len() {
            let mut j = i + 1;
            while j < sorted.len() && first_cbits_eq(&sorted[i].0, &sorted[j].0) {
                j += 1;
            }
            for ia in i..j {
                for ib in (ia + 1)..j {
                    let a = &sorted[ia];
                    let b = &sorted[ib];
                    if !distinct(&a.1, &b.1) {
                        continue;
                    }
                    let xored: Vec<u8> =
                        a.0.iter().zip(b.0.iter()).map(|(x, y)| x ^ y).collect();
                    let new_hash = if xored.len() <= cbytes {
                        Vec::new()
                    } else {
                        xored[cbytes..].to_vec()
                    };
                    let (first, second) =
                        if a.1[0] < b.1[0] { (&a.1, &b.1) } else { (&b.1, &a.1) };
                    let mut new_indices = Vec::with_capacity(first.len() + second.len());
                    new_indices.extend_from_slice(first);
                    new_indices.extend_from_slice(second);
                    out.push((new_hash, new_indices));
                }
            }
            i = j;
        }
        out
    }

    /// Convert RowFixed → byte-shape (hash bytes, indices) up to the
    /// indicated lengths so we can compare against the CPU reference.
    fn row_to_byte_shape(
        row: &RowFixed,
        hash_bytes: usize,
        indices_count: usize,
    ) -> (Vec<u8>, Vec<u32>) {
        let mut hash = Vec::with_capacity(hash_bytes);
        for b in 0..hash_bytes {
            let w = b / 4;
            let s = (b % 4) * 8;
            hash.push(((row.hash[w] >> s) & 0xFF) as u8);
        }
        (hash, row.indices[..indices_count].to_vec())
    }

    fn make_test_input() -> ([u8; 81], [u8; 32]) {
        let mut input = [0u8; 81];
        input[..9].copy_from_slice(b"Equium-v1");
        for i in 9..81 {
            input[i] = (i as u8).wrapping_mul(11).wrapping_add(7);
        }
        let mut nonce = [0u8; 32];
        for i in 0..32 {
            nonce[i] = (i as u8).wrapping_mul(19).wrapping_add(5);
        }
        (input, nonce)
    }

    #[test]
    fn extract_bucket_matches_first_two_hash_bytes() {
        // The exact scheme doesn't matter, but each unique (b0, b1) pair
        // must map to a unique bucket id — that's what makes the
        // counting sort correct.
        let mut seen = std::collections::HashSet::new();
        for b0 in 0u8..=255 {
            for b1 in 0u8..=255 {
                let w0 = (b0 as u32) | ((b1 as u32) << 8);
                let hash = [w0, 0, 0];
                let bucket = extract_bucket(&hash);
                assert!(seen.insert(bucket), "bucket collision for ({b0}, {b1})");
                assert!(bucket < NUM_BUCKETS as u32);
            }
        }
        assert_eq!(seen.len(), 1 << 16);
    }

    #[test]
    fn xor_and_trim_drops_cbytes_correctly() {
        // Source 12 bytes in memory order:
        //   [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        //    0x88, 0x99, 0xBA, 0x0B]
        // Packed as 3 LE u32:
        let a = [0x44332211u32, 0x88776655, 0x0BBA9988];
        let b = [0u32; 3]; // XOR identity
        let out = xor_and_trim(&a, &b);

        // Trim 2 → bytes 2..12 shifted to positions 0..10, positions
        // 10..12 zero-padded.
        let read_byte = |w: &[u32; 3], i: usize| -> u8 {
            let word = w[i / 4];
            ((word >> ((i % 4) * 8)) & 0xFF) as u8
        };
        let want_bytes = [
            0x33u8, 0x44, 0x55, 0x66, 0x77, 0x88, 0x88, 0x99, 0xBA, 0x0B,
        ];
        for (i, &want) in want_bytes.iter().enumerate() {
            let got = read_byte(&out, i);
            assert_eq!(got, want, "byte {i}");
        }
        // Trailing bytes must be zero so subsequent rounds see clean
        // input.
        assert_eq!(read_byte(&out, 10), 0);
        assert_eq!(read_byte(&out, 11), 0);
    }

    #[test]
    fn canonical_concat_smaller_first_by_indices0() {
        let mut a = RowFixed::zero();
        a.indices[0] = 100;
        a.indices[1] = 200;
        let mut b = RowFixed::zero();
        b.indices[0] = 50;
        b.indices[1] = 150;
        let mut out = [0u32; INDICES_MAX];
        canonical_concat(&a, &b, 2, &mut out);
        // b has smaller indices[0], so b comes first.
        assert_eq!(&out[..4], &[50, 150, 100, 200]);

        // Reverse order: same canonical result.
        let mut out2 = [0u32; INDICES_MAX];
        canonical_concat(&b, &a, 2, &mut out2);
        assert_eq!(&out2[..4], &[50, 150, 100, 200]);
    }

    #[test]
    fn round_kernel_matches_cpu_reference_at_full_width() {
        // Full Equihash 96,5 width: 131,072 leaves, 5 rounds. The point
        // of this test is to exercise every bucket, every collision
        // depth, and every round-to-round handoff that real mining will.
        let (input, nonce) = make_test_input();
        let n_leaves: u32 = 1 << 17;
        let raw_leaves = leaves(&input, &nonce, n_leaves);

        // GPU-shape: pack into RowFixed.
        let mut gpu_rows: Vec<RowFixed> = (0..n_leaves as usize)
            .map(|i| pack_initial_row(&raw_leaves[i * 12..(i + 1) * 12], i as u32))
            .collect();

        // CPU-shape: (hash_bytes, indices) tuples.
        let mut cpu_rows: Vec<(Vec<u8>, Vec<u32>)> = (0..n_leaves as usize)
            .map(|i| (raw_leaves[i * 12..(i + 1) * 12].to_vec(), vec![i as u32]))
            .collect();

        for r in 0..5usize {
            let indices_count_in = 1u32 << r;
            let hash_bytes_in = 12 - 2 * r;
            let hash_bytes_out = hash_bytes_in - 2;
            let indices_count_out = (indices_count_in * 2) as usize;

            gpu_rows = round_kernel(&gpu_rows, RoundParams { indices_count_in });
            cpu_rows = cpu_round_reference(cpu_rows, 16);

            assert_eq!(
                gpu_rows.len(),
                cpu_rows.len(),
                "round {r}: row count mismatch (gpu={}, cpu={})",
                gpu_rows.len(),
                cpu_rows.len()
            );

            // Sort both by (hash_bytes, indices) for multiset compare.
            let mut gpu_bs: Vec<(Vec<u8>, Vec<u32>)> = gpu_rows
                .iter()
                .map(|r| row_to_byte_shape(r, hash_bytes_out, indices_count_out))
                .collect();
            gpu_bs.sort();
            let mut cpu_bs = cpu_rows.clone();
            cpu_bs.sort();

            // Spot-check: pick a few positions and compare deeply.
            // (Avoid printing 131k diffs if there's a bug.)
            assert_eq!(
                gpu_bs.len(),
                cpu_bs.len(),
                "round {r}: post-sort length mismatch"
            );
            for (idx, (g, c)) in gpu_bs.iter().zip(cpu_bs.iter()).enumerate() {
                if g != c {
                    panic!(
                        "round {r}, sorted position {idx}:\n  gpu hash {:?} indices {:?}\n  cpu hash {:?} indices {:?}",
                        g.0, g.1, c.0, c.1
                    );
                }
            }
        }

        // After 5 rounds, surviving rows should have hash_bytes_out=2
        // bytes; solutions are those where those 2 bytes are zero.
        let gpu_solutions: Vec<_> = gpu_rows
            .iter()
            .filter(|r| {
                let (h, _) = row_to_byte_shape(r, 2, 32);
                h.iter().all(|&b| b == 0)
            })
            .collect();
        let cpu_solutions: Vec<_> = cpu_rows
            .iter()
            .filter(|(h, _)| h.iter().all(|&b| b == 0))
            .collect();
        assert_eq!(
            gpu_solutions.len(),
            cpu_solutions.len(),
            "solution count mismatch after round 5"
        );
    }
}
