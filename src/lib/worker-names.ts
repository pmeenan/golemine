/**
 * Worker names shared by the UI-side factories in `worker-client.ts` and
 * worker-side nested construction (backup-worker's db-worker sink). Keep this
 * module free of DOM dependencies so it stays importable inside workers.
 *
 * At each construction site both the `new URL(...)` expression and the
 * `{ name, type: "module" }` options object must stay literal — Vite's worker
 * plugin statically parses them (a shared options helper breaks the
 * `type: "module"` detection at build time). Only the names live here.
 */
export const backupWorkerName = "golemine-backup-worker";
export const capabilityWorkerName = "golemine-capability-worker";
export const dbWorkerName = "golemine-db-worker";
/** Nested db-worker spawned inside the backup worker (distinguishable in devtools). */
export const nestedDbWorkerName = `${dbWorkerName}-nested`;
export const mediaWorkerName = "golemine-media-worker";
