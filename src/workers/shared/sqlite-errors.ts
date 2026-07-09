import type { WorkerErrorCode } from "../../lib/worker-types";
import { hasOpfsStorage } from "./opfs";

/**
 * Classifies low-level sqlite-wasm failures into worker error codes. Shared by
 * the db-worker ingest and query paths so both report the same environment
 * conditions (missing OPFS, wasm compile/link/runtime failures). `fallback`
 * is the operation-specific code used for everything else.
 */
export function classifySqliteWasmError(
  cause: unknown,
  fallback: WorkerErrorCode,
): WorkerErrorCode {
  if (!hasOpfsStorage() && cause instanceof WebAssembly.RuntimeError) {
    return "sqlite_opfs_unavailable";
  }

  if (
    cause instanceof WebAssembly.CompileError ||
    cause instanceof WebAssembly.LinkError
  ) {
    return "sqlite_unavailable";
  }

  if (cause instanceof WebAssembly.RuntimeError) {
    return "sqlite_init_failed";
  }

  return fallback;
}
