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
