import type sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { derivedDbVersion } from "../../lib/constants";

type Sqlite3Api = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type DerivedSqliteDatabase = InstanceType<Sqlite3Api["oo1"]["DB"]>;
export type DerivedSqliteStatement = ReturnType<DerivedSqliteDatabase["prepare"]>;

export const derivedDatabaseFilename = "golemine.sqlite";
export const contactAvatarRelativeDirectory = "thumbs/contact-avatars";

/**
 * User-authored tables survive same-version ingest resets (D-044): their
 * contents (report names, notes, case metadata) cannot be rebuilt from the
 * source backup. Version migrations still wipe them. Add future user-authored
 * tables here instead of special-casing the reset script.
 */
const userAuthoredTables = ["report_items", "reports"] as const;

/** Rebuildable normalized tables, dropped on every ingest reset. */
const derivedTables = [
  "reactions",
  "attachments",
  "messages",
  "conversation_participants",
  "contact_avatars",
  "participants",
  "conversations",
  "ingest_meta",
] as const;

export function resetDerivedDatabaseSchema(db: DerivedSqliteDatabase): void {
  const currentVersion = Number(db.selectValue("PRAGMA user_version;"));
  const preserveUserAuthoredTables = currentVersion === derivedDbVersion;
  const droppedTables = preserveUserAuthoredTables
    ? derivedTables
    : [...userAuthoredTables, ...derivedTables];

  db.exec(`
    PRAGMA foreign_keys = OFF;

    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;

    DROP TABLE IF EXISTS messages_fts;
    ${droppedTables.map((table) => `DROP TABLE IF EXISTS ${table};`).join("\n    ")}
  `);

  createDerivedDatabaseSchema(db);
}

/**
 * Removes report selections whose normalized message no longer exists after a
 * same-version rebuild. Owned here with the report-table declarations so
 * report-table knowledge stays out of the ingest writer.
 */
export function pruneOrphanedReportItems(db: DerivedSqliteDatabase): void {
  db.exec(`
    DELETE FROM report_items
    WHERE NOT EXISTS (
      SELECT 1 FROM messages WHERE messages.id = report_items.message_id
    );
  `);
}

export function createDerivedDatabaseSchema(db: DerivedSqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = ${String(derivedDbVersion)};

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      provider_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
      display_name TEXT,
      service TEXT,
      last_message_at TEXT,
      message_count INTEGER NOT NULL CHECK (message_count >= 0)
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'unknown', 'self')),
      contact_name TEXT,
      contact_first_name TEXT,
      is_self INTEGER NOT NULL CHECK (is_self IN (0, 1)),
      avatar_sha256 TEXT,
      avatar_mime TEXT CHECK (
        avatar_mime IS NULL OR avatar_mime IN ('image/jpeg', 'image/png')
      ),
      avatar_path TEXT
    );

    CREATE TABLE IF NOT EXISTS contact_avatars (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      opfs_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
      sent_at_utc TEXT,
      raw_timestamp TEXT NOT NULL,
      body TEXT NOT NULL,
      service TEXT,
      is_from_me INTEGER NOT NULL CHECK (is_from_me IN (0, 1)),
      date_delivered TEXT,
      date_read TEXT,
      edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
      unsent INTEGER NOT NULL CHECK (unsent IN (0, 1)),
      source_guid TEXT,
      source_rowid INTEGER NOT NULL,
      is_system_event INTEGER NOT NULL CHECK (is_system_event IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT,
      mime TEXT,
      bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
      source_path TEXT,
      source_domain TEXT,
      sha256 TEXT,
      source_guid TEXT
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      target_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (
        kind IN (
          'loved',
          'liked',
          'disliked',
          'laughed',
          'emphasized',
          'questioned',
          'unknown'
        )
      ),
      sent_at_utc TEXT,
      raw_timestamp TEXT NOT NULL,
      source_guid TEXT,
      source_rowid INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      case_meta_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_items (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      note TEXT,
      PRIMARY KEY (report_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS ingest_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad
    AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au
    AFTER UPDATE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;

    CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
      ON conversations(last_message_at);
    CREATE INDEX IF NOT EXISTS idx_participants_handle
      ON participants(handle);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent
      ON messages(conversation_id, sent_at_utc);
    CREATE INDEX IF NOT EXISTS idx_messages_sender
      ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_source_guid
      ON messages(source_guid);
    CREATE INDEX IF NOT EXISTS idx_attachments_message
      ON attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_sha256
      ON attachments(sha256);
    CREATE INDEX IF NOT EXISTS idx_reactions_target
      ON reactions(target_message_id);
    CREATE INDEX IF NOT EXISTS idx_report_items_message
      ON report_items(message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_items_position
      ON report_items(report_id, position);
  `);
}
