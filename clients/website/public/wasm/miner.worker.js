// Module worker that hosts the Equihash WASM solver.
//
// Handles two message types from the main thread:
//   * "solve" — pure-WASM path. Worker generates leaves AND runs
//     Wagner per attempt, up to maxAttempts nonces. Used when WebGPU
//     is unavailable.
//   * "solve-with-leaves" — hybrid path (v0.3). Main thread already
//     ran leaves on the GPU and ships them in; worker only runs
//     Wagner + target check for a single nonce. Used when WebGPU is
//     available — the main thread feeds many workers in flight.
//
// Worker decoupling keeps the UI 60fps while solving grinds.

import init, {
  solve_block,
  try_nonce_with_leaves,
} from "/wasm/equium_wasm.js";

let ready = null;

self.onmessage = async (event) => {
  const req = event.data;
  if (!req) return;

  if (!ready) {
    ready = init();
  }

  try {
    await ready;

    if (req.type === "solve") {
      const t0 = performance.now();
      const result = solve_block(
        req.n,
        req.k,
        req.challenge,
        req.miner,
        BigInt(req.height),
        req.maxAttempts,
        req.seed
      );
      const solveMs = performance.now() - t0;

      if (!result) {
        self.postMessage({
          type: "no-solution",
          jobId: req.jobId,
          attempts: req.maxAttempts,
          solveMs,
        });
        return;
      }

      self.postMessage({
        type: "solved",
        jobId: req.jobId,
        nonce: result.nonce,
        solnIndices: result.soln_indices,
        attempts: result.attempts,
        solveMs,
      });
      return;
    }

    if (req.type === "solve-with-leaves") {
      const t0 = performance.now();
      const solnIndices = try_nonce_with_leaves(
        req.n,
        req.k,
        req.input,
        req.nonce,
        req.leaves
      );
      const solveMs = performance.now() - t0;

      if (!solnIndices) {
        self.postMessage({
          type: "no-solution",
          jobId: req.jobId,
          attempts: 1,
          solveMs,
        });
        return;
      }

      self.postMessage({
        type: "solved",
        jobId: req.jobId,
        nonce: req.nonce,
        solnIndices,
        attempts: 1,
        solveMs,
      });
      return;
    }
  } catch (e) {
    self.postMessage({
      type: "error",
      jobId: req.jobId,
      message: String(e && e.message ? e.message : e),
    });
  }
};
