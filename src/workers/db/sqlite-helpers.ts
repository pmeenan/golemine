import type {
  DerivedSqliteDatabase,
  DerivedSqliteStatement,
} from "./schema";

export type SqliteBindValue = string | number | null | Uint8Array;

export function selectRows<TRow extends Record<string, unknown>>(
  db: DerivedSqliteDatabase,
  sql: string,
  bind: readonly SqliteBindValue[] = [],
): TRow[] {
  return (
    bind.length === 0 ? db.selectObjects(sql) : db.selectObjects(sql, [...bind])
  ) as TRow[];
}

export function withTransaction<TValue>(
  db: DerivedSqliteDatabase,
  operation: () => TValue,
): TValue {
  db.exec("BEGIN IMMEDIATE;");

  try {
    const result = operation();

    db.exec("COMMIT;");

    return result;
  } catch (cause) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original failure; rollback errors are secondary cleanup.
    }

    throw cause;
  }
}

export function runPrepared(
  statement: DerivedSqliteStatement,
  values: readonly SqliteBindValue[],
): void {
  statement.clearBindings();
  statement.bind([...values]);
  statement.stepReset();
}
