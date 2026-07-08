import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

export type Sqlite3Api = Awaited<ReturnType<typeof sqlite3InitModule>>;

let sqlitePromise: Promise<Sqlite3Api> | undefined;

/**
 * Memoized sqlite-wasm module loader shared by every module in a worker.
 * Initialization failures clear the memo so a later call can retry.
 */
export async function getSqlite(): Promise<Sqlite3Api> {
  sqlitePromise ??= sqlite3InitModule({
    print: () => undefined,
    printErr: () => undefined,
  }).catch((cause: unknown) => {
    sqlitePromise = undefined;
    throw cause;
  });

  return sqlitePromise;
}
