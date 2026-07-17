/**
 * Shared vitest support for db-worker suites: the in-memory sqlite factory
 * seam and WorkerResult unwrapping used by queries, ingest-sink, and reports
 * tests. Not a test file — vitest only collects `*.test.ts`.
 */
import {
  formatWorkerErrorPayload,
  type WorkerResult,
} from "../../lib/worker-types";
import { getSqlite } from "../shared/sqlite-init";
import type { DerivedSqliteDatabase } from "./schema";

const openDatabases: DerivedSqliteDatabase[] = [];

export async function createMemoryDatabase(): Promise<DerivedSqliteDatabase> {
  const sqlite3 = await getSqlite();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  openDatabases.push(db);

  return db;
}

/** Register as `afterEach(closeMemoryDatabases)` in every consuming suite. */
export function closeMemoryDatabases(): void {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
}

export function unwrap<TValue>(result: WorkerResult<TValue>): TValue {
  if (!result.ok) {
    throw new Error(formatWorkerErrorPayload(result.error), {
      cause: result.error,
    });
  }

  return result.value;
}
