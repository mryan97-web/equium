/* tslint:disable */
/* eslint-disable */

export class EquihashSolution {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly attempts: number;
    readonly nonce: Uint8Array;
    readonly soln_indices: Uint8Array;
}

/**
 * Build the Equium I-block (`Equium-v1 || challenge || miner || height_le`).
 * Exposed so the JS side can pre-hash candidate solutions for the target
 * check above without re-implementing the layout.
 */
export function build_input_block(challenge: Uint8Array, miner: Uint8Array, height: bigint): Uint8Array | undefined;

/**
 * Hash candidate solution off-chain to check it falls under the on-chain
 * target — saves an RPC roundtrip if the solver returns an "above target"
 * solution. Mirrors `equihash_core::challenge::solution_hash`.
 */
export function solution_hash(soln_indices: Uint8Array, input: Uint8Array): Uint8Array;

/**
 * Solve one Equihash block.
 *
 * - `n`, `k`: Equihash parameters (must match the on-chain config)
 * - `challenge`: 32-byte current challenge from the config PDA
 * - `miner`: 32-byte miner pubkey (the wallet that will sign the mine ix)
 * - `height`: current block height
 * - `max_attempts`: cap on nonce iterations before giving up
 * - `seed`: 32-byte random seed (caller supplies via crypto.getRandomValues)
 *
 * Returns `null` if no solution found within `max_attempts`.
 */
export function solve_block(n: number, k: number, challenge: Uint8Array, miner: Uint8Array, height: bigint, max_attempts: number, seed: Uint8Array): EquihashSolution | undefined;

/**
 * WebGPU hybrid path (v0.3): the host generates leaves on the GPU,
 * then hands them in here so the CPU does only the cheap Wagner +
 * validation pass per nonce. `leaves` must be exactly
 * `n_init_leaves(n, k) * (n/8)` bytes, tightly packed (the same
 * layout the native `gpu-miner` Wagner pipeline expects).
 *
 * Returns the compressed solution indices, or `null` if this nonce
 * produces no valid solution.
 */
export function try_nonce_with_leaves(n: number, k: number, input: Uint8Array, nonce: Uint8Array, leaves: Uint8Array): Uint8Array | undefined;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_equihashsolution_free: (a: number, b: number) => void;
    readonly equihashsolution_nonce: (a: number) => [number, number];
    readonly equihashsolution_soln_indices: (a: number) => [number, number];
    readonly equihashsolution_attempts: (a: number) => number;
    readonly solve_block: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number, i: number, j: number) => number;
    readonly solution_hash: (a: number, b: number, c: number, d: number) => [number, number];
    readonly build_input_block: (a: number, b: number, c: number, d: number, e: bigint) => [number, number];
    readonly try_nonce_with_leaves: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
