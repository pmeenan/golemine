import type sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { derivedDbVersion } from "../../lib/constants";

type Sqlite3Api = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type DerivedSqliteDatabase = InstanceType<Sqlite3Api["oo1"]["DB"]>;
export type DerivedSqliteStatement = ReturnType<DerivedSqliteDatabase["prepare"]>;

export const derivedDatabaseFilename = "golemine.sqlite";
export const contactAvatarRelativeDirectory = "thumbs/contact-avatars";

export function resetDerivedDatabaseSchema(db: DerivedSqliteDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;

    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;

    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS report_items;
    DROP TABLE IF EXISTS reports;
    DROP TABLE IF EXISTS reactions;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS conversation_participants;
    DROP TABLE IF EXISTS contact_avatars;
    DROP TABLE IF EXISTS participants;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS ingest_meta;
  `);

  createDerivedDatabaseSchema(db);
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
      case_meta_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_items (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
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
  `);
}
