# Equium GPU miner

Hybrid GPU/CPU miner for Equium ($EQM). GPU does the BLAKE2b-heavy
leaf-generation pass (≈70% of solver time in the CPU profile); CPU
handles Wagner rounds.

Cross-platform via `wgpu`:

| OS | Backend | Status |
|----|---------|--------|
| macOS (Apple Silicon + Intel) | Metal | should work |
| Linux | Vulkan | should work with mesa or proprietary drivers |
| Windows | DX12 or Vulkan | should work |
| Web | WebGPU | planned, same shader |

## Status: v0 — leaf generation only

What's here today:

- `equium-gpu-miner verify` — runs BLAKE2b leaf generation on GPU and
  CPU side-by-side for a fixed (input, nonce), asserts byte-for-byte
  match. Run this first on any new machine; if it fails the shader
  output is wrong for your driver and we want to know.
- `equium-gpu-miner bench` — measures leaf throughput at full Equihash
  96,5 width (131,072 leaves per BLAKE2b job).

What's not here yet:

- The actual mining loop. `equium-gpu-miner mine` prints a stub.
  Plumbing the GPU leaves into the existing Wagner solver + the
  race-for-below-target submit loop is straightforward — it's
  basically what `cli-miner` does, with the leaf-generation step
  swapped out — but I wanted byte-level shader correctness verified
  before wiring the rest.
- Wagner rounds on GPU. Out of scope for v0; that's a substantially
  bigger compute-shader effort (sort, XOR-and-pair, ×5 rounds, ×
  proper memory bandwidth strategy). The leaf-generation cost is the
  biggest single chunk of CPU time, so even the hybrid v0.1 will be
  meaningfully faster than pure-CPU.

## Roadmap

- **v0** (this commit): GPU BLAKE2b leaf generation + byte-level CPU
  verification.
- **v0.1**: Wire GPU leaves into the existing `equihash-core::solver`
  Wagner driver. Multi-threaded outer race for nonce selection +
  submit; race-for-below-target identical to CLI miner.
- **v0.2**: First Wagner round on GPU (sort + XOR + pair). Iterate
  on memory layout; this is where the shader interesting parts live.
- **v0.3**: All 5 Wagner rounds on GPU. End-to-end miner that hands
  back a finished `Solution` to the host.
- **v0.4**: WebGPU integration into the browser miner.

## Build

Standard Cargo:

```bash
cargo build --release -p equium-gpu-miner
```

GPU drivers are loaded at runtime via `wgpu`. No CUDA toolchain or
admin install needed — anything that supports Vulkan, Metal, or DX12
works.

## Verify

After building on a new machine, run the verification step. This
exists because subtle shader bugs (alignment, endianness, off-by-one)
can pass `cargo check` and still produce wrong bytes on real
hardware. The check is fast (<1s for the default 2048 leaves) and
compares GPU output to `blake2b_simd` byte-for-byte.

```bash
./target/release/equium-gpu-miner verify
```

If it prints `✓ GPU output matches CPU reference byte-for-byte`,
you're good. If it prints a mismatch, please open a GitHub issue
with the first-mismatch hex output and your `--info` (we'll add a
flag for that) so we can chase the driver-specific case.

## Bench

```bash
./target/release/equium-gpu-miner bench
```

Reports BLAKE2b throughput at full Equihash width. Useful for
comparing GPUs and for confirming the GPU is actually being used
(software fallback through `lavapipe` runs orders of magnitude
slower than a real adapter).

## Why hybrid v0 instead of going full GPU first

Equihash 96,5 Wagner on GPU is genuinely hard — bucket sort + XOR-and-
pair at 2^17 leaves with proper memory bandwidth is its own multi-week
project. The leaf-generation pass alone is ~70% of CPU solver time
according to profiling, so even before Wagner gets ported the GPU
should give a meaningful speedup over the multi-threaded CPU CLI.

Verifying byte-level correctness of the BLAKE2b shader first means
that when we add the Wagner kernels we already know the leaves they
consume match the CPU reference; debugging the Wagner code can assume
the input layer is sound.

## Source

Shader: `src/shaders/leaves.wgsl`
Host: `src/gpu.rs`, `src/main.rs`
