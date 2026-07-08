import { derivedDbVersion } from "../../lib/constants";
import {
  toWorkerError,
  workerFail,
  workerOk,
  type SqliteSmokeStatus,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
} from "../../lib/worker-types";
import { emitWorkerProgress } from "../shared/progress";
import { getSqlite, type Sqlite3Api } from "../shared/sqlite-init";

type SahPool = Awaited<ReturnType<Sqlite3Api["installOpfsSAHPoolVfs"]>>;

const smokeDatabaseName = "golemine-m0-smoke.sqlite3";
const smokeVfsName = "golemine-opfs-sahpool";

let sahPoolPromise: Promise<SahPool> | undefined;

export async function runSqliteSmoke(
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<SqliteSmokeStatus>> {
  try {
    await emitWorkerProgress("db", progress, "starting", "Checking worker storage support", 0, 4);

    if (!hasOpfsStorage()) {
      return workerFail(
        toWorkerError({
          worker: "db",
          code: "sqlite_opfs_unavailable",
          message:
            "OPFS is not available in this runtime, so the sqlite smoke database was not opened.",
          recoverable: false,
          details: { vfs: "opfs-sahpool" },
        }),
      );
    }

    await emitWorkerProgress("db", progress, "sqlite-init", "Initializing sqlite-wasm", 1, 4);
    const sqlite3 = await getSqlite();

    await emitWorkerProgress("db", progress, "sqlite-opfs", "Installing opfs-sahpool VFS", 2, 4);
    const pool = await getSahPool(sqlite3);

    await emitWorkerProgress("db", progress, "sqlite-query", "Creating sqlite smoke table", 3, 4);
    const db = new pool.OpfsSAHPoolDb(smokeDatabaseName);

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS smoke_status (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL,
          derived_db_version INTEGER NOT NULL
        );
      `);
      db.exec("DELETE FROM smoke_status;");
      db.exec({
        sql: "INSERT INTO smoke_status (label, derived_db_version) VALUES (?, ?);",
        bind: ["golemine-m0", derivedDbVersion],
      });
      const insertedRows = db.changes(false);

      const rows = db.exec({
        sql: `
          SELECT
            label AS selectedLabel,
            derived_db_version AS selectedDerivedDbVersion
          FROM smoke_status
          ORDER BY id DESC
          LIMIT 1;
        `,
        rowMode: "object",
        returnValue: "resultRows",
      });
      const row = rows[0];

      if (
        rows.length !== 1 ||
        typeof row.selectedLabel !== "string" ||
        typeof row.selectedDerivedDbVersion !== "number"
      ) {
        return workerFail(
          toWorkerError({
            worker: "db",
            code: "sqlite_query_failed",
            message: "The sqlite smoke query did not return the expected row.",
            recoverable: true,
            details: { databaseName: smokeDatabaseName },
          }),
        );
      }

      await emitWorkerProgress("db", progress, "complete", "SQLite OPFS smoke test complete", 4, 4);

      return workerOk({
        worker: "db",
        sqliteVersion: sqlite3.version.libVersion,
        databaseName: smokeDatabaseName,
        vfs: "opfs-sahpool",
        poolCapacity: pool.getCapacity(),
        poolFileCount: pool.getFileCount(),
        selectedLabel: row.selectedLabel,
        selectedDerivedDbVersion: row.selectedDerivedDbVersion,
        insertedRows,
        at: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  } catch (cause) {
    return workerFail(
      toWorkerError({
        worker: "db",
        code: classifySqliteError(cause),
        message: "The sqlite OPFS smoke test failed inside db-worker.",
        cause,
        recoverable: true,
        details: { databaseName: smokeDatabaseName, vfs: "opfs-sahpool" },
      }),
    );
  }
}

function hasOpfsStorage(): boolean {
  const navigatorValue: unknown = Reflect.get(globalThis, "navigator");

  if (!isObjectLike(navigatorValue)) {
    return false;
  }

  const storageValue: unknown = Reflect.get(navigatorValue, "storage");

  if (!isObjectLike(storageValue)) {
    return false;
  }

  return typeof Reflect.get(storageValue, "getDirectory") === "function";
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

async function getSahPool(sqlite3: Sqlite3Api): Promise<SahPool> {
  sahPoolPromise ??= sqlite3
    .installOpfsSAHPoolVfs({
      initialCapacity: 4,
      name: smokeVfsName,
      directory: "/golemine/sqlite-sahpool",
    })
    .catch((cause: unknown) => {
      sahPoolPromise = undefined;
      throw cause;
    });

  return sahPoolPromise;
}

function classifySqliteError(cause: unknown): WorkerErrorCode {
  if (!hasOpfsStorage()) {
    return "sqlite_opfs_unavailable";
  }

  if (cause instanceof WebAssembly.CompileError) {
    return "sqlite_unavailable";
  }

  if (cause instanceof WebAssembly.LinkError) {
    return "sqlite_unavailable";
  }

  if (cause instanceof WebAssembly.RuntimeError) {
    return "sqlite_init_failed";
  }

  return "sqlite_query_failed";
}
