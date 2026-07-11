# Golemine Architecture

Browser-based, fully offline tool for exploring, searching, and extracting data from
phone backups (iPhone first, Android later), with court-exhibit-grade report export.
The name is Golem + Mine: a mechanical automaton that mines through backup data and
extracts the interesting bits — the worker pipeline (§3) is the golem doing the mining.

This document is the source of truth for how the system is structured. Read it before
making changes; update it when the structure changes. Product-level decisions and their
rationale live in [Decisions.md](Decisions.md). The iOS backup format details live in
[iOS-Backup-Format.md](iOS-Backup-Format.md). The build order lives in [Plan.md](Plan.md).
The visual design language (tokens, theming, component rules) lives in [Design.md](Design.md).

## 1. Product summary

- **Input:** a local iTunes/Finder iPhone backup folder (encrypted or unencrypted),
  opened via drag/drop or a directory picker. Android support comes later via the same
  provider abstraction.
- **Core features:** browse message threads, full-text search across all messages, view
  attachments (native images, HEIC thumbnails, and native videos now; HEVC fallback
  support planned), select messages into a report, export a
  print-optimized report with forensic metadata (hashes, device info, timestamps).
- **Non-negotiables:** works entirely offline, never sends user data anywhere, never
  modifies the source backup, Chrome-only (free use of Chrome-specific APIs).

## 2. Platform constraints and choices

| Concern | Choice | Notes |
|---|---|---|
| Browser | Chrome only (latest stable) | File System Access API, OPFS, WebCodecs, `getAsFileSystemHandle()` all available. Chromium/Edge may work, but are not support targets. |
| Framework | React 19 + TypeScript (strict) + Vite | Pure client-side SPA, no SSR |
| Package manager | pnpm | Chosen for stable lockfiles, reproducible installs, and license-audit ergonomics |
| Hosting | User-controlled static hosting | No server-side app logic. Vite `base` should assume root hosting unless the deployment target changes. |
| Offline | Service worker via `vite-plugin-pwa` (Workbox) | Precache the app shell + wasm assets; app must fully work with no network after first load |
| CI | GitHub Actions for pull requests | Run lint, typecheck, unit tests, Playwright Chromium e2e, and license audit |
| SQLite | Official `@sqlite.org/sqlite-wasm` | Runs in a dedicated worker; `opfs-sahpool` VFS so COOP/COEP headers are NOT required |
| Media decode | Native browser image/video preview plus isolated `libheif-js` HEIC thumbnails today; future single-threaded video poster fallback if needed | LGPL allowed only as an isolated, dynamically loaded, replaceable package-specific codec exception — see AGENTS.md licensing rules and D-026/D-027 |
| Worker RPC | Comlink (Apache-2.0) | Typed proxies over `postMessage`; transfer `ArrayBuffer`s, never copy large payloads |
| State | zustand (MIT) | UI state only; all data lives in the derived SQLite DB |
| Routing | react-router (MIT) | Client-side only |
| Styling/components | Tailwind CSS + shadcn/ui (Radix) + React DayPicker — all MIT | Governed by the Lode design system: [Design.md](Design.md); DayPicker is used only as the calendar engine inside the token-styled date-range popover (D-037) |
| Virtualization | react-virtuoso (MIT) | Message lists can be 100k+ rows; nothing unvirtualized |
| Crypto | WebCrypto (PBKDF2, AES-KW, AES-CBC, one-shot SHA-256) plus dependency-free incremental SHA-256 | Incremental SHA-256 is limited to streaming integrity provenance, not password/key crypto (D-041) |

**COOP/COEP:** we deliberately avoid `SharedArrayBuffer` dependencies (opfs-sahpool VFS,
single-threaded codecs) so the app can be hosted anywhere static files can be served,
with no special headers. If a future feature truly needs SAB (multithreaded ffmpeg),
that is a hosting decision to raise explicitly, not a silent dependency.

**Capability gate:** workspace routes are guarded at boot by `src/lib/capabilities.ts`.
The gate probes Chrome APIs rather than sniffing user agents. The
`createSyncAccessHandle` check is validated through a tiny capability worker because
that API is needed in the worker/OPFS runtime used by sqlite-wasm and is not reliably
exposed on the window prototype. The worker probe fails open when it cannot run
(timeout or worker startup failure) and blocks only on an explicit negative answer;
successful answers are cached in `sessionStorage`, and detection starts lazily via
`getBootBrowserCapabilities()` (D-017).

## 3. Process model: UI thread vs workers

The UI thread runs React and nothing else. All parsing, decryption, hashing, SQL, and
media decoding happens in dedicated workers. No task on the main thread may block for
more than ~16 ms.

```
┌─────────────────────────────── UI thread (React) ───────────────────────────────┐
│  Landing / Recents / Thread browser / Search / Report builder / Info pages      │
└──────┬──────────────────────────┬──────────────────────────┬────────────────────┘
       │ Comlink                  │ Comlink                  │ Comlink
┌──────▼─────────┐        ┌───────▼────────┐        ┌────────▼───────┐
│ backup-worker  │        │   db-worker    │        │  media-worker  │
│ FS scanning    │        │ sqlite-wasm    │        │ native thumbs   │
│ Manifest parse │        │ derived DB     │        │ thumbnails     │
│ decryption     │        │ FTS5 queries   │        │ media fallback │
│ extraction     │        │ ingest writes  │        │ (ffmpeg.wasm)  │
│ SHA-256 hashing│        │ (opfs-sahpool) │        │                │
└──────┬─────────┘        └───────┬────────┘        └────────────────┘
       │  reads (read-only)       │  reads/writes
┌──────▼──────────────┐   ┌───────▼─────────────────┐
│ Source backup folder│   │ OPFS (browser storage)  │
│ (user's disk, via   │   │ per-backup derived data │
│ directory handle)   │   │ + thumbnails cache      │
└─────────────────────┘   └─────────────────────────┘
```

- **backup-worker** — owns the source `FileSystemDirectoryHandle` after the UI obtains
  it through a user gesture and hands it off. Validates the backup, parses
  `Info.plist`/`Manifest.plist`/`Manifest.db`, performs keybag/password key derivation
  and per-file decryption for encrypted backups, stages source SQLite in transient
  OPFS, streams extraction to user-selected files, and computes SHA-256 hashes for
  provenance. This is the only component that touches the
  source folder, and it only ever reads; source access should go through read-only
  wrapper helpers so writable handles never enter provider code.
- **db-worker** — hosts sqlite-wasm. Owns the per-backup derived database in OPFS
  (normalized messages + FTS5 index + report selections). All queries the UI needs are
  RPC methods here; the UI never sees raw SQL.
- **media-worker** — generates and caches JPEG image thumbnails in OPFS and lazy-loads
  isolated same-origin `libheif-js` vendor files for HEIC thumbnails. Production
  imports the public vendor ES module directly; Vite dev fetches the same unmodified
  public file and imports it through a temporary Blob module URL so `public/` vendor
  files never go through Vite transforms (D-033). HEIC preview first tries embedded
  HEIF thumbnails when they are useful for the display target, uses any usable embedded
  thumbnail when the primary image is over the decode memory cap, and otherwise decodes
  the primary image only when its RGBA surface is at most 256 MiB. Thumbnail generation
  is serialized inside the media worker, and its temporary canvas backing stores are
  reset immediately after the image is downsampled. Video poster generation currently
  returns typed unsupported results; future codec packages must be isolated, lazy-loaded
  only when first needed, and must follow D-026.

Ingest (the one long-running pipeline) flows backup-worker → db-worker directly, with
progress events surfaced to the UI (phase, counts, ETA). Long counted loops use the
shared throttled progress helper so normalization and aggregate writes can update item
counts about every 500 ms without spamming Comlink. The UI starts and observes ingest
but does not relay ingest batches. Ingest is resumable/restartable: if
interrupted, the derived DB is rebuilt from scratch (source is the source of truth).

Worker lifetimes: one-shot open/detect/ingest UI operations create a fresh worker
client per operation and release it when the operation finishes. The unified M4
messages workspace instead owns route-scoped db/backup/media workers for the route
lifetime, so
repeated queries, previews, and thumbnails do not churn worker startup or contend for
the same per-backup SAH pool; the pool hand-off race on route switches is absorbed by
a brief `installOpfsSAHPoolVfs` retry (D-029). For an encrypted backup that route-
scoped backup worker is also the security-session boundary: an explicit unlock RPC
derives and retains class keys in worker memory, source reads reuse them, and route
unmount/worker termination destroys the session. The overview's one-shot ingest worker
is intentionally separate, so navigation requires a fresh attachment unlock instead
of moving keys or passwords through UI storage. Route cleanup marks the messages
workspace inactive before releasing workers; an unlock continuation re-checks that
generation after directory permission and never creates a key-holding worker after
unmount (D-038). Cross-worker helpers (sqlite init and
error classification, binary/progress/OPFS/retry/hash utilities, media MIME sets and
byte budgets, service-kind mapping) live in `src/workers/shared/` and are extended
rather than re-declared per worker.

## 4. Storage model

**The source backup is read in place and never copied wholesale or modified.**

- **IndexedDB** (small metadata only): the recents list — one record per known backup:
  `{ id, friendlyName, directoryHandle, deviceInfo snapshot, isEncrypted, lastOpened,
  ingestStatus, derivedDbVersion }`. `FileSystemDirectoryHandle` is structured-cloneable
  and persists across sessions; reopening a recent backup requires one
  `requestPermission()` user gesture. The storage facade lives in
  `src/lib/recents.ts` and owns rename/remove helpers plus permission re-grant helpers.
  Detection results are written through `BackupRecentsStore.recordDetection`, which
  preserves user renames and ingest status when a known backup is re-opened from any
  entry point, applies the `derivedDbVersion` staleness rule, and retires stale
  records (including their orphaned derived-data directories) when a folder detects
  under a new identity. Malformed stored records are skipped and reported rather
  than failing the whole list. Because iOS detection IDs are normally device UDIDs,
  the current model intentionally keeps one active backup snapshot per device. Before
  writing a detection, the landing flow compares the persisted directory entry and
  source backup date. A changed folder or date requires explicit replacement
  confirmation (D-040): cancel performs no write; confirm wipes the existing derived
  directories before updating the source handle and resets ingest status to
  `not-ingested`.
- **OPFS** (bulk derived data): one directory per backup under
  `golemine/backups/`, keyed by backup UDID when known and falling back to the recents
  id before detection has a UDID:
  - `golemine.sqlite` — the normalized message store + FTS5 index (schema below).
  - `thumbs/` — cached attachment/contact-avatar thumbnails (content-addressed by hash
    or stable source provenance key when a hash is not yet available).
  - `transient/` — worker-owned plaintext staging for source SQLite
    (staged mains, workspace sahpool directories) and encrypted WAL/SHM sidecar
    Blobs; preview reads decrypt in memory and never stage here (D-043). Files are
    removed on close/lock/eviction, the first transient open in a fresh worker
    sweeps the whole directory of crash leftovers, and Remove backup wipes the
    parent directory.
- Request `navigator.storage.persist()` on first ingest so Chrome doesn't evict data.
- Derived data is always disposable: deleting a backup from recents deletes its OPFS
  directory through `src/lib/recents.ts`; the source folder is untouched. A
  `derivedDbVersion` bump forces re-ingest after schema changes.
- `derivedDbVersion` is a single shared constant in source code. UI recents, db-worker
  schema setup, ingest invalidation, and tests must import that constant rather than
  duplicating version numbers.

For encrypted backups, the derived DB in OPFS contains **decrypted** message content
(that's the point of the index). The UI must clearly state this, and "Remove backup"
must wipe it. Passwords are held in memory only, never persisted.

## 5. Backup provider abstraction

Everything downstream of ingest works on a normalized model. Each backup format is a
`BackupProvider` implementation; the iPhone provider is the reference implementation and
the Android provider (format TBD — see Decisions.md D-007) plugs in later.

```ts
interface BackupProvider {
  id: string;                              // 'ios-itunes', later 'android-...'
  detect(root: ReadonlySourceDirectoryHandle): Promise<DetectResult>; // is this ours? encrypted?
  open(root, opts: { password?: string }): Promise<BackupSession>;
}

interface BackupSession {
  deviceInfo: DeviceInfo;                  // name, model, OS version, UDID, serial, phone number
  capabilities: Capability[];              // ['messages', 'contacts', ...]
  ingest(sink: IngestSink, progress: ProgressFn): Promise<IngestReport>;
  readAttachment(ref: AttachmentRef): Promise<ReadableStream>; // decrypts on the fly if needed
  hashSourceFile(ref: SourceFileRef): Promise<Sha256>;         // provenance for reports
}
```

At the worker RPC boundary, `BackupWorkerApi.detectBackup(root, progress?)` accepts the
structured-cloned `FileSystemDirectoryHandle` from the UI and immediately wraps it with
`asReadonlySourceDirectory()`. Provider detection/opening code accepts
`ReadonlySourceDirectoryHandle`; raw writable-capable source handles do not cross into
provider modules. Detection results carry the normalized `BackupDeviceInfo`
(name, model, osVersion, udid, serialNumber, phoneNumber): the iOS provider
translates Apple plist keys into that shape internally, so UI routes and the recents
store never see provider-specific field names.

The production ingest RPC is provider-neutral:
`BackupWorkerApi.ingestBackupToDb(root, request, credentials?, progress?)`. It creates
a dedicated nested db-worker sink and keeps all normalized batches off the UI thread.
For unencrypted backups it opens `Manifest.db` with root WAL/SHM sidecars applied. For
encrypted backups it parses the keybag from `Manifest.plist`, verifies the password,
decrypts and opens `Manifest.db`, then uses each MBFile `EncryptionKey`/`Size` to feed
plaintext sms/contact/contact-image databases and their sidecars into the same ingest
pipeline. Root Manifest sidecars are not mixed into the encrypted path because Apple
does not provide independent root-sidecar key metadata. The older
`ingestUnencryptedBackup*` methods remain compatibility/test seams (D-038).

`prepare` is the one mutation boundary: detection, password KDF/AES-KW verification,
Manifest decryption, and the transient Manifest SQLite open all complete before the
worker emits and awaits that progress event immediately ahead of destructive
`prepareIngest`. A wrong password or malformed keybag therefore leaves an existing
derived DB/status untouched. After prepare, sms/contact source SQLite WAL files are
validated and their committed prefix is written by random access to a staged OPFS main
file (D-021/D-022); encrypted database mains decrypt-stream directly into that staged
file with no intermediate copy. WAL replay is single-pass with chunked frame reads
and a bounded pending-transaction buffer, falling back to a bounded-memory two-phase
pass for oversized transactions; commit sizes are validated by a hostility cap plus a
structural bound applied only to the final applied commit, so checkpoint-truncated
mains replay correctly (D-042). The staged header is forced to rollback-journal mode
(D-025), then the pinned sqlite-wasm 3.50.4-build1 `opfs-sahpool.importDb()` callback
pulls bounded chunks into a unique 16-slot transient pool without a full wasm-heap
copy (D-041).
Encrypted and unencrypted Manifest.db use the same seam before prepare. The former
D-039 RAM caps are superseded by generous absolute staged-file/set sanity bounds and
an OPFS-quota preflight. The REQUIRED messages set still calls
`assertRequiredSourceDatabaseSetWithinBudget` before the `prepare` boundary;
missing/malformed required metadata, invalid stored-file shape, and insufficient quota
fail without touching the derived DB.
The quota guard reserves a conservative three-copy peak for decrypted staging, WAL
reconstruction, and callback sahpool import. Required encrypted main/WAL/SHM keys are
trial-unwrapped and immediately zeroized during this preflight.
Crash-leftover transient storage is swept before the Manifest quota estimate, so stale
usage cannot prevent its own recovery. Every encrypted ingest ends by locking the
worker's session through the shared reset seam (D-043), so a completed overview
ingest leaves `transient/` empty even though its one-shot worker is simply
terminated afterwards.
Plaintext SHA-256/size remain the primary normalized fields. The ingest summary retains
both plaintext and exact stored ciphertext hash/size plus the encryption flag for its
Manifest and database inputs. Attachment rows retain the plaintext hash when eager
hashing is within budget; report export re-reads each selected attachment through
`readSourceFile` to obtain both labeled hashes/sizes from the exact Manifest path. The
source backup directory is never written.

The production source-file RPC is `BackupWorkerApi.readSourceFile`. For unencrypted
backups it uses the existing most-recent `Manifest.db` cache. For encrypted backups the
route first calls `unlockBackupSession`; the worker retains mutable unwrapped class keys
and a decrypted transient Manifest reader, both keyed by backup id and verified root
identity with `isSameEntry`. A different id/root or explicit `lockBackupSession`
invalidates that session and aborts/drains its active source reads before resolving.
Per-file CBC decryption reads `File` slices in bounded chunks, resizing plaintext to
authoritative MBFile `Size`: a longer stored tail is truncated and a shorter sparse
prefix is zero-extended. Bounded preview/report reads decrypt in memory and respond
with a Blob copy whose intermediate buffer is zeroized immediately; session-owned
transient OPFS staging is reserved for encrypted WAL/SHM sidecar payloads during
database opens (D-043). `readSourceFile` returns a structured-cloned Blob instead of
a transferred full-file array; native media decode consumes that Blob directly.
`extractSourceFile` owns the save-picker file handle inside backup-worker and writes
decrypt chunks straight to its writable; its commit point is a successful
`writable.close()` — pre-commit hash/session failures abort the atomic writable, and
a session lock landing after the commit can no longer turn the completed extraction
into a reported failure. The UI never removes a selected handle after failure, so an
existing destination remains intact.
Incremental SHA-256 folds
plaintext and opt-in ciphertext streams. Responses expose both plaintext `sha256` and
stored-source `sourceSha256`, enforce caller byte caps, and verify the optional expected
plaintext hash before resolving. Preview and future report hashing use
`readSourceFile`; extraction uses the streaming sibling RPC. The normalized attachment's
optional `sha256` is therefore a decrypted-content hash for encrypted backups and stays
the expected-hash input; it must not be compared with ciphertext `sourceSha256`. User
extraction materialization and 1 GiB cap from D-031 are superseded by D-041.

`IngestSink` receives normalized entities and is implemented by the db-worker:

- **Conversation** — thread; 1:1 or group; participants; display name; service. For
  groups, `displayName` is present only when the source explicitly named the chat;
  unnamed-group identity is derived from participants at presentation time (D-036).
- **Participant** — handle (phone/email), resolved contact name and first name when
  available, is-self flag.
- **Message** — conversation ref, sender, UTC timestamp (+ raw source timestamp),
  body text, service (iMessage/SMS), status (sent/delivered/read timestamps),
  edited/unsent flags, source GUID + source row id (provenance).
- **Attachment** — message ref, filename, MIME, size, source path ref, transfer name,
  source GUID, and optional source hash when bounded source bytes were read.
- **Reaction** — tapbacks etc., linked to their target message, source GUID/row id/raw
  timestamp, never shown as rows.

Rule: provider-specific quirks (Apple epochs, `attributedBody` parsing, tapback
encodings) are resolved **inside the provider** at ingest time. The normalized model and
everything above it is provider-agnostic.

## 6. Derived database schema (OPFS, per backup)

SQLite via sqlite-wasm, FTS5 for search. Sketch (authoritative version lives in code
under `src/workers/db/schema.ts`):

```sql
conversations(id, provider_key, kind, display_name, service, last_message_at, message_count)
participants(id, handle, kind, contact_name, contact_first_name, is_self,
             avatar_sha256, avatar_mime, avatar_path)
contact_avatars(participant_id, sha256, mime, byte_length, opfs_path, created_at)
conversation_participants(conversation_id, participant_id)
messages(id, conversation_id, sender_id, sent_at_utc, raw_timestamp, body, service,
         is_from_me, date_delivered, date_read, edited, unsent,
         source_guid, source_rowid, is_system_event)              -- provenance
attachments(id, message_id, filename, mime, bytes, source_path, source_domain,
            sha256, source_guid)
reactions(id, target_message_id, sender_id, kind, sent_at_utc, raw_timestamp,
          source_guid, source_rowid)
messages_fts(body)   -- FTS5, external-content table on messages
report_items(report_id, message_id, added_at, note)
reports(id, title, created_at, case_meta_json)
ingest_meta(key, value)  -- summary_json (machine-read ingest summary) + scalar debug rows
```

The db-worker ingest sink lives in `src/workers/db/ingest-sink.ts`. `prepareIngest`
rebuilds the schema for the per-backup derived DB opened through `opfs-sahpool` under
`golemine/backups/<UDID-or-id>/sqlite-sahpool`. That SAH pool reserves a 16-slot
minimum because sqlite-wasm persists pool files and interrupted real-world rebuilds can
leave journal/temp slots behind; the overview route releases its read-only summary
db-worker synchronously when a rebuild starts and keeps it released while the rebuild
runs so it cannot contend with `prepareIngest` (D-024). Tests inject an in-memory sqlite factory so schema and batch writes are
validated without OPFS. Batch writes go through a generic per-entity upsert spec table
rather than per-entity insert functions.
`finalizeIngest` stores `summary_json` as the only machine-read ingest record plus
scalar debugging rows (provider, started_at, completed_at, database_name,
derived_db_version); stored summaries are validated by a shallow provider-agnostic
structural check gated on `derivedDbVersion` (D-023). Contact avatar bytes are
written under `thumbs/contact-avatars/` and referenced by path metadata in SQLite.
Attachment source hashes may be absent for large, unknown-size, deceptive-size, or
budget-deferred media; the source path, domain, GUID, and manifest/source-file
provenance are still kept so report/export code can hash selected originals on demand.

The db-worker query API lives in `src/workers/db/queries.ts`. `listConversations`
(also exposed as `listThreads`) returns a recency-sorted virtualized page with
participants and last-message preview (a per-conversation correlated LIMIT-1 lookup);
`getMessageTimelinePage` returns bounded chronological windows with
attachments/reactions hydrated, and `getMessageTimelineMessagesPage` returns the same
window without conversation hydration for load-more; `getMessageDetails` returns
message + conversation provenance. `searchMessages` implements case-insensitive
implicit-AND FTS5 prefix terms plus escaped Unicode `/iu` verification for quoted
substrings, then applies conversation, participant, date-range, and has-attachment
filters. Only compatible internal ASCII tokens narrow quoted candidates through FTS,
avoiding Unicode case-table skew between JavaScript and SQLite `unicode61`. Every
quoted verification scan — FTS-narrowed or not — examines at most the newest 10,000
candidate rows in a single ordered prepared-statement pass with throttled progress
and returns explicit coverage/truncation metadata (D-035).
`listSearchConversations` applies the same semantics and returns bounded pages of
conversations ordered by newest hit with exact in-coverage hit counts. Message
records carry a normalized `serviceKind` (`imessage`/`sms-family`/`unknown`, D-032) so
the UI never string-matches raw service names. Conversation participants retain the
resolved contact first name separately from the full display name; unnamed groups use
all non-self participants to build a natural label, while one-to-one threads keep the
full contact label (D-036). Search results return normalized
message/conversation records and structured snippet segments. Hostile bodies that
contain the snippet highlight sentinels degrade to a single non-highlighted segment
(D-030). The
UI renders all backup text
as text nodes, exposes load-more controls for additional pages, and navigates to the
message in its thread context.

## 7. UI structure

Routes (react-router, all client-side):

- `/` — landing: what the tool is, privacy statement ("your data never leaves this
  machine"), drag/drop + open-folder entry points, recents list (rename/remove).
- `/guide/iphone`, `/guide/android` — static how-to-back-up-your-phone pages.
- `/backup/:id` — backup overview: device info, ingest status/progress, capability tiles.
- `/backup/:id/messages` — unified browse/search workspace for ingested backups.
  Browse mode shows Threads → Timeline. Active search shows hit-filtered Threads →
  newest-first Results → Timeline, with all/thread result scoping and jump-to-message.
  Its optional date filter is one controlled range picker: a focus-managed Radix
  popover contains a token-styled two-month React DayPicker calendar, stages a complete
  or same-day range until apply, and preserves the existing UTC query-boundary model.
  Details is absent until a message is selected, docks only on wide viewports, and is
  an accessible overlay otherwise. Conversation/timeline/search pages are bounded and
  load additional windows. Attachment previews and extraction read source bytes
  lazily through backup-worker.
- `/backup/:id/report/:reportId` — report builder: ordered selected messages, case
  metadata form, print preview.
- `/backup/:id/report/:reportId/print` — print-optimized rendering (see §8).

UX rules: every long operation streams progress; the UI is never frozen or spinner-only
when partial results exist; message text from backups is **untrusted input** — always
rendered as text nodes, never HTML. All visual/interaction design follows
[Design.md](Design.md), including mandatory light + dark themes (system-auto with
manual override) and the token-only styling rule.

## 8. Reports (court-exhibit grade)

A report is a curated, ordered set of messages plus case metadata, rendered as paginated
print-CSS HTML and exported via Chrome's print-to-PDF (direct pdf-lib generation is a
later enhancement).

Every report includes a **provenance appendix**, generated at export time:

- Device identity: name, model, iOS version, UDID, serial number, phone number (from `Info.plist`).
- Backup identity: backup date, encrypted flag, source folder name.
- Integrity: SHA-256 of the source message database (`sms.db`) and of every attachment
  file included in the report, computed from the **source** bytes (for encrypted
  backups: hash of the encrypted source file, plus hash of decrypted content, both
  labeled as such).
- Extraction record: tool name + version + commit, export timestamp (UTC), timezone used
  for displayed timestamps (explicitly labeled on every page).
- Per-message provenance: source GUID, source row id, raw timestamp value alongside the
  human-readable rendering.
- Methodology note: brief fixed text describing how data was read (read-only, from an
  iTunes/Finder backup) and a pointer to the open-source code.

Timestamps: stored as UTC + raw source value; displayed in a user-selected timezone
(default: report author's choice, defaulting to device-local if known), with the
timezone printed on the report. Never display an ambiguous local time.

## 9. Encrypted backups

Implemented in M5. All crypto runs in backup-worker using WebCrypto only:

1. Parse the keybag from `Manifest.plist`; derive the password key
   (PBKDF2-SHA256 with ~10M iterations, then PBKDF2-SHA1 — details in
   [iOS-Backup-Format.md](iOS-Backup-Format.md) §5).
2. Unwrap class keys (AES-KW), unwrap the `ManifestKey`, decrypt `Manifest.db`
   (AES-256-CBC), then decrypt individual files on demand using their per-file wrapped
   keys from `Manifest.db`.

Pre-iOS-10.2 keybags omit the SHA-256 stage and feed UTF-8 password bytes directly to
the PBKDF2-SHA1 stage. Keybag/TLV lengths, iteration counts, wrapped-key shapes, CBC
block lengths, declared plaintext sizes, and SQLite Manifest page boundaries are
bounded and validated before large work; malformed inputs return typed worker errors.

Password handling: each password crosses only the explicit unlock/ingest RPC. Worker
DTO/local references are discarded as soon as key derivation/open completes, mutable
UTF-8 encodings are cleared, and credentials are never logged or persisted. JavaScript
strings are immutable, so the design does not claim literal string zeroization. Wrong-password is
detected by AES-KW integrity and reported separately from unsupported/malformed crypto.
The worker retains only mutable class keys and the transient decrypted Manifest reader;
`destroy`, explicit lock, root/id eviction, or worker termination clears/closes them.
The UI password fields are uncontrolled and clear immediately after dispatch. M5's
browser test additionally inspects local/session storage and the recent-backup record
to prevent the fixture password or credential-shaped fields from being persisted.
The session-only claim applies to credentials and keys, not derived content: decrypted
messages and generated contact/attachment previews may remain in OPFS until Remove
backup wipes the backup's complete derived-data directory.

## 10. Security & privacy posture

- **No network I/O with user data, ever.** The service worker serves everything after
  first load; the only permissible fetches are same-origin app assets. No analytics, no
  telemetry, no CDN-loaded code.
- **Network/offline behavior is test-enforced.** Playwright intercepts requests after
  app load and fails on unexpected network access; offline reload of the installed app
  shell is part of the M0 acceptance suite.
- **Production assets use a static-host CSP header template.** The M0 template lives in
  `public/_headers` so hosts that support static header files copy it into `dist/`.
  Scripts and `connect` are same-origin only; other asset types stay loose enough for
  generated static assets (`data:`/`blob:`) and workers. Compiling wasm (sqlite-wasm,
  and isolated codec packages such as libheif) in Chrome requires
  `script-src 'wasm-unsafe-eval'` — include it; it does not
  permit JS `eval`. Do not use a meta CSP for this app: it breaks Vite dev, cannot
  enforce `frame-ancestors`, and makes the pre-paint theme script hash-fragile.
- **Source backups are read-only.** No code path receives a writable handle to the
  source folder.
- **Backup content is hostile input.** SQL from backups is parsed by SQLite (wasm
  sandbox); strings are never interpolated into HTML/SQL; plist/typedstream parsers must
  be bounds-checked and fuzz-tolerant (malformed input → skip + log, never crash ingest).
- **Wasm modules are vendored/pinned**, loaded same-origin, and covered by the license
  audit (see AGENTS.md).

## 11. Repository layout (target)

```
/                     Vite app root
  src/
    app/              routes, layout, providers
    components/       shared UI components
    features/         landing/, recents/, m3/ unified messages/search, report/, guides/
    workers/
      backup/         backup-worker: providers/ios/, crypto/, plist/, typedstream/
      db/             db-worker: schema, queries, ingest sink, FTS
      media/          media-worker: thumbs, native media helpers, future codec fallbacks
      shared/         helpers shared across workers (sqlite init/errors, binary, progress,
                      OPFS, retry, hash, guards, media MIME/limits, service kind)
    lib/              shared utils (time, bytes, comlink helpers, types)
    assets/           bundled images: brand/ (icon master), illustrations/ (light/dark WebP pairs)
  public/             static assets, wasm binaries
    _headers          static-host security headers (CSP)
    theme-init.js     pre-paint theme preference script
    og-image.png      1200×630 social card (absolute URL in index.html OG tags)
  docs/               this documentation
    assets/           repo-facing images (README banner, golem character sheet)
  e2e/                Playwright Chromium tests
    fixtures/         synthetic fixture metadata + generator stubs (no real personal data)
  .github/workflows/  pull-request CI (lint, typecheck, unit, e2e, license audit)
```

Test strategy: Vitest for unit tests (parsers get golden-file tests against small
fixture backups checked into `e2e/fixtures/` — synthetic, no real personal data ever in
the repo, with generator scripts/metadata kept alongside them); Playwright (Chromium)
for end-to-end flows including drag/drop ingest, offline/privacy invariants, and report
printing.

The first generated fixture is `e2e/fixtures/generated/ios-mini-backup/`, a synthetic
unencrypted iPhone backup root used by the M1 open -> detect -> recents Playwright flow,
the M2 open -> ingest -> derived summary flow, and the M3/M4 browse/search flow. Its source module and generator
produce deterministic Manifest/sms/contact SQLite data, real WAL sidecars, tapbacks,
attachments, contact-avatar happy/error cases, and expected normalized metadata.
