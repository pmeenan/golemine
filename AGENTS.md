# Golemine : Phone backup data extraction and exploration.

Browser-based tooling for exploring phone backups (iPhone and Android). Chrome-only,
fully offline SPA; iPhone Messages first. This file is long-term project memory and
the rulebook for agents.

The name is **Golem + Mine** (NOT "gold mine"): a **mechanical** golem/automaton in
the vein of Talos, the bronze automaton — not a clay golem — that mines through backup
data and extracts the interesting bits. The web workers are the golem's working parts;
the theme informs naming and design language (warm gold/bronze accent = the automaton's
metal and the ore it surfaces; no clay/terracotta styling).

## Workflow (mandatory)

- **Start:** read `docs/Architecture.md` and `docs/Plan.md`. For iOS parsing work also
  read `docs/iOS-Backup-Format.md`. For any UI work also read `docs/Design.md`.
- **Terminal:** on Windows, run terminal commands with PowerShell 7 (`pwsh`) by default,
  not Windows PowerShell 5.1 (`powershell`), so UTF-8 output stays readable. Use
  Windows PowerShell only when a task specifically requires it, and note why.
- **End:** update `README.md`, `docs/Plan.md` (check off / add tasks and the status
  line), `docs/Architecture.md` (if structure changed), `docs/Decisions.md` (if a
  decision was made), and `AGENTS.md` (this file) with anything future agents must know.
- **Hygiene:** delete any throw-away diagnostic scripts, `.log` files, and scratch
  outputs from the repo root before concluding. Do **not** delete generated build/test
  output directories such as `dist/` or `test-results/`; they are ignored by git and
  useful for local review.
- **Encoding:** keep all project text files UTF-8 clean. Preserve UTF-8 when editing,
  avoid tools/settings that write mojibake, and fix accidental replacement characters
  or mis-decoded punctuation before concluding.
- **No Automatic Commits:** Never automatically commit or push changes to this project.
  All changes must be left in the workspace and will be manually reviewed before being
  committed.

## Hard rules

1. **Privacy is absolute.** No network requests carrying user data, ever. No analytics,
   telemetry, or CDN-loaded code. After first load the app must work fully offline.
2. **Never modify source backups.** All access to the user's backup folder is
   read-only. Derived data goes to OPFS and must always be rebuildable from source.
3. **The UI thread does UI only.** Parsing, SQL, crypto, hashing, and media decoding
   run in web workers. Nothing may block the main thread beyond ~16 ms. Long
   operations stream progress.
4. **Backup content is hostile input.** Never interpolate backup strings into
   HTML/SQL. Parsers (plist, typedstream, keybag) must tolerate malformed input:
   skip and report, never crash ingest.
5. **Licensing:** project is Apache-2.0. Dependencies must be MIT/BSD/Apache/ISC/zlib.
   LGPL is permitted only as a package-specific exception when there is no better
   permissive option and the dependency can be used without tainting app code: keep it
   in separate, unmodified, dynamically loaded same-origin vendor files (including
   upstream JS glue/wrappers when they are part of the isolated distribution), make it
   practically replaceable, and record it in NOTICE plus the license audit exceptions
   (D-026). No GPL/AGPL, no copyleft copied into app source. Check the license of every
   new dependency before adding it.
6. **No real personal data in the repo.** Test fixtures are synthetic backups only.
7. **Chrome-only is a feature.** Use Chrome APIs (File System Access, OPFS,
   `getAsFileSystemHandle`, WebCodecs) freely; do not add cross-browser fallbacks.
   Unsupported browsers are handled by the boot-time capability gate
   (`src/lib/capabilities.ts`, M1): when you take a dependency on a new
   browser-specific API that the app cannot function without, add its feature probe
   to the gate (sniff the capability, never the user-agent string). APIs with a
   graceful in-app fallback (e.g. WebCodecs → poster frame) stay out of the gate.
8. **Provider quirks stay in providers.** Everything above ingest works on the
   normalized model (Architecture §5); no Apple-isms leak into UI or db layers.
9. **Provenance is sacred.** Keep source GUIDs, row ids, raw timestamps, and hashes
   flowing through the pipeline — reports depend on them (Architecture §8).
10. **TypeScript strict; no `any` escapes without a comment stating why.** Unit tests
    for every parser (golden files); Playwright for user flows.
11. **The design system is law.** All UI follows `docs/Design.md`: semantic tokens only
    (no hardcoded colors/sizes/durations), every screen works in light AND dark theme,
    and the "definition of done" checklist in Design.md §11 applies to all UI work.
    Extend Design.md when a new pattern is needed — don't improvise one-offs.
12. **UTF-8 is mandatory.** Documentation, source, fixtures, and generated text
    checked into the repo must be valid UTF-8. Do not introduce mojibake; if a terminal
    displays garbled punctuation, verify the file bytes before editing and preserve the
    existing encoding.

## Key technical anchors (details in docs/)

- Stack: React 19 + TS + Vite; zustand; react-router; Tailwind + shadcn/ui;
  react-virtuoso; Comlink for worker RPC; `@sqlite.org/sqlite-wasm` with
  **opfs-sahpool** VFS (no COOP/COEP — do not introduce SharedArrayBuffer deps, D-008).
- Package manager: pnpm. CI runs on pull requests for lint, typecheck, unit tests,
  Playwright Chromium e2e, and license audit.
- M0 guardrails live in `e2e/m0.spec.ts`; fixture conventions live in
  `e2e/fixtures/fixtures.json` plus `e2e/fixtures/generate-fixtures.mjs`. Keep all
  fixture data synthetic and regenerable.
- Brand/illustration assets: the golem's visual identity is a steampunk automaton
  (D-018, rules in Design.md §12). The canonical character sheet is
  `docs/assets/golem-reference-sheet.png` — pass it as image context when generating
  any new golem artwork; never generate from a text prompt alone. In-app
  illustrations live in `src/assets/illustrations/` (paired `-light`/`-dark` WebP
  variants, decorative only) and render through
  `src/components/brand/decorative-illustration.tsx` so system/manual theme switching,
  lazy hidden-variant loading, empty alt text, and print exclusion stay centralized.
  Use `PageShell`'s dedicated `illustration` prop for page headers and
  `IllustratedSection` for fixed guide/gate columns so print collapse stays automatic.
  The Workbox glob in `vite.config.ts` must keep `webp` precached, and interaction art
  such as the drag overlay must remain mounted before first interaction; the icon master in
  `src/assets/brand/`, the social
  card in `public/og-image.png` (referenced absolutely as
  `https://golemine.com/og-image.png` from `index.html`).
- Static-host security headers live in `public/_headers`, and the pre-paint theme
  bootstrap lives in `public/theme-init.js`. Do not reintroduce a CSP meta tag in
  `index.html`; it breaks dev mode and cannot enforce `frame-ancestors`. The e2e suite
  replays the `_headers` CSP via Playwright header injection (D-013), so policy edits
  are CI-guarded even though `vite preview` ignores header files.
- `@sqlite.org/sqlite-wasm` must stay excluded from Vite dependency optimization
  (`vite.config.ts`, D-020). If Vite prebundles it, the dev server can serve the SPA
  HTML fallback where sqlite expects `sqlite3.wasm`, producing a wasm magic-word
  compile error. Do not add COOP/COEP to solve this; the project uses `opfs-sahpool`
  specifically to avoid `SharedArrayBuffer` hosting requirements (D-008).
- The M0 landing shell includes browser-run worker diagnostics: backup/db/media
  Comlink round-trips plus a db-worker sqlite-wasm `opfs-sahpool` smoke database. Keep
  future diagnostics off the UI thread and behind typed worker APIs.
- Read-only source handle wrappers begin in
  `src/workers/backup/read-only-source.ts`; provider code should accept those wrappers
  rather than raw writable-capable `FileSystemDirectoryHandle`s.
- M1 backup detection is exposed as `BackupWorkerApi.detectBackup(root, progress?)`.
  It wraps the UI-provided `FileSystemDirectoryHandle` with
  `asReadonlySourceDirectory()` before provider detection, validates the iTunes/Finder
  root files, and parses XML plus bounded common binary plist values in
  `src/workers/backup/plist.ts`. Detection returns the normalized
  `BackupDeviceInfo` (name/model/osVersion/udid/serial/phone); the Apple plist key
  translation lives inside `src/workers/backup/ios-backup.ts` so no Apple-isms
  cross the worker boundary (hard rule 8). Root plist size bounds are role-specific:
  `Info.plist` allows up to 32 MiB because real backups can carry bulky installed-app
  metadata there; `Manifest.plist` and `Status.plist` stay at 8 MiB (D-019).
- M1 workspace capability gating lives in `src/lib/capabilities.ts`; the
  sync-access-handle probe intentionally falls back to
  `src/workers/capability/capability.worker.ts` because Chromium exposes that API in
  the worker/OPFS context used by sqlite-wasm (headless Chromium exercises this
  path on every boot). The probe fails open on timeout/startup errors (D-017),
  caches its answer in sessionStorage, is skipped entirely when other required
  window checks already failed, and boot detection starts lazily via
  `getBootBrowserCapabilities()` — never at module evaluation (a module-eval
  probe caused a TDZ crash in production bundles). Worker construction
  (including the probe worker) is centralized in `src/lib/worker-client.ts`.
  One-shot open/detect/ingest UI operations create fresh worker clients per
  operation and release them in `finally`; the unified M4 messages route
  intentionally owns route-scoped db/backup/media workers where repeated queries or
  previews would
  otherwise churn workers or contend for the same OPFS SAH pool (D-029 — the
  per-backup SAH pool is held while the route is mounted; same-backup multi-tab
  browsing is out of scope for now).
- Chrome-only File System Access typings are declared once in
  `src/types/file-system-access.d.ts` (included by both tsconfig projects); do not
  re-declare `showDirectoryPicker`/`queryPermission`/`getAsFileSystemHandle` shapes
  ad hoc. Drop-event directory extraction lives in `src/lib/drag-drop.ts` and must
  collect `getAsFileSystemHandle()` promises synchronously during drop dispatch —
  the drag data store deactivates at the first `await`.
- The iPhone guide must not imply backups have to be created on the same machine that
  runs Golemine. Finder/iTunes backups can be created anywhere and copied over. Keep
  concise inline Finder steps in the guide so it works offline, plus Apple Support
  links for current screenshots/troubleshooting. On macOS, tell users to copy the
  specific backup folder out of
  `~/Library/Application Support/MobileSync/Backup/` before opening them because
  Chrome may not be allowed to read directly from `~/Library`.
- License audit is fail-closed in `scripts/license-audit.mjs`. Non-standard licenses
  are package-specific exceptions only (see Decisions.md D-012); do not broaden the
  global allowlist without a recorded decision. The audit also byte-compares every
  file under `public/vendor/libheif-js/<version>/` against the installed package so
  vendored LGPL files cannot drift from upstream, and `eslint.config.js` blocks
  `libheif-js` from app source across `.ts/.tsx/.js/.mjs/.cjs` files, including
  dynamic imports with template-literal specifiers.
- Workers: `backup-worker` (source FS, manifest, crypto), `db-worker` (derived
  SQLite + FTS5 in OPFS), `media-worker` (native + HEIC thumbnails now; video-poster
  codec fallback later).
- Storage: recents + directory handles in IndexedDB; per-backup derived data in
  OPFS keyed by UDID; `derivedDbVersion` bump forces re-ingest. M1 recents storage
  lives in `src/lib/recents.ts`: IndexedDB database `golemine-recents`, store
  `backups`, permission re-grant helpers for stored directory handles, and wipe on
  remove for OPFS derived data under `golemine/backups/<UDID-or-id>`. Keep db-worker
  derived paths aligned with the exported constants there. All detection writes go
  through `BackupRecentsStore.recordDetection`, which preserves user renames and
  ingest status across every entry point, applies the `derivedDbVersion` staleness
  rule, and retires stale records (wiping only derived-data directories the new
  record does not share). Recents parsing is skip-and-report per record; unknown
  ingest statuses map to `needs-reingest` instead of rejecting the row. Every read
  (`list`/`get`) passes through `reconcileRecordOnRead`, which recovers persisted
  interrupted `ingesting` records as `needs-reingest` AND presents records ingested
  under an older `derivedDbVersion` as `needs-reingest` — routes must never open a
  derived DB whose schema predates the current version (the route gates rely on this;
  do not gate on `ingestStatus` alone elsewhere). Only a
  successful `ingested` status stamps the current `derivedDbVersion`; `ingesting` and
  `failed` preserve the prior version.
  iOS IDs are normally UDIDs, so storage currently permits one active snapshot per
  device (D-040). Before `recordDetection`, call `findReplacementCandidate`: the same
  directory entry plus the same `lastBackupDate` is an ordinary reopen; a different
  entry or date must show the Radix confirmation dialog. **Keep existing** performs no
  write. **Replace backup** calls `recordDetection(..., { replaceExisting: true })`,
  which wipes all old derived directories before publishing the new handle and resets
  status to `not-ingested`. Never preserve `ingested` across a confirmed replacement.
- M2 db-worker derived schema and ingest sink live in `src/workers/db/schema.ts` and
  `src/workers/db/ingest-sink.ts`. `prepareIngest` recreates the schema for
  `golemine.sqlite` in the per-backup OPFS `opfs-sahpool` directory under
  `golemine/backups/<UDID-or-id>/sqlite-sahpool`; that pool intentionally reserves a
  16-slot minimum because stale journal/temp files from interrupted real-backup
  rebuilds can otherwise surface as `SQLITE_CANTOPEN` during prepare (D-024). Keep
  derived DB open errors reporting pool details. `writeIngestBatch` writes normalized
  batches (and FTS trigger population) through a generic per-entity upsert spec table
  (`upsertMany` + `entityBatchWriters`) — extend the spec table rather than adding
  hand-written insert functions. `finalizeIngest` stores
  `summary_json` (the only machine-read representation, D-023) plus scalar
  debugging rows (provider, started_at, completed_at, database_name,
  derived_db_version) in `ingest_meta`. Stored-summary validation is a shallow
  provider-agnostic structural check gated on `derivedDbVersion`; do not add deep
  per-field guards or provider/role enumerations. Contact avatar bytes are
  content-addressed under `thumbs/contact-avatars/` with only path metadata in
  SQLite. Unit tests inject an in-memory sqlite factory; keep that seam when
  extending db-worker queries.
- Shared worker helper modules — extend these instead of re-declaring helpers:
  `src/workers/shared/sqlite-init.ts` (single memoized `getSqlite()` used by
  source-sqlite, ingest-sink, sqlite-smoke, and tests), `src/workers/shared/binary.ts`
  (`stringFromCodeUnits`, `bytesStartWith` — the single byte-prefix/chunked-string
  helpers), `src/workers/shared/progress.ts` (`emitWorkerProgress`,
  `createThrottledWorkerProgress` for counted long-loop updates about every 500 ms),
  `src/workers/backup/apple-time.ts` (single Apple epoch constant), and
  `src/lib/worker-names.ts` (worker name constants; the db-worker nested inside
  backup.worker is named `golemine-db-worker-nested`). Worker options objects must
  stay literal at each construction site because Vite statically parses
  `new Worker(new URL(...), { type: "module" })`. Additional shared modules:
  `src/workers/shared/guards.ts` (`isObjectRecord`, `assertPositiveSafeInteger`;
  `src/lib/recents.ts` deliberately keeps its own UI-thread copy),
  `src/workers/shared/hash.ts` (`stableHash` FNV-1a), `src/workers/shared/opfs.ts`
  (`hasOpfsStorage`, `isSafeOpfsPathSegment`, `getOpfsBackupDirectoryHandle` — the
  single `golemine/backups/<id>` walk with safe-segment assertion — and
  `getAvailableOpfsQuotaBytes`, the single OPFS quota probe shared by manifest-db
  and ios-ingest),
  `src/workers/shared/sqlite-errors.ts` (`classifySqliteWasmError(cause,
  fallback)` used by both db-worker ingest and query error paths),
  `src/workers/shared/media-mime.ts` (native-image + HEIC MIME sets),
  `src/workers/shared/media-limits.ts` (named small-read/preview/thumbnail
  budget constants, import-safe from UI code),
  `src/workers/shared/report-limits.ts` (report title/field/note/item bounds shared
  by the db-worker validators and UI `maxLength` attributes, import-safe from UI),
  `src/workers/db/sqlite-helpers.ts` (`selectRows`, `withTransaction`, `runPrepared`,
  `SqliteBindValue` — the single statement/transaction helpers for queries,
  ingest-sink, and reports; never re-declare them per module),
  `src/workers/db/derived-db.test-support.ts` (vitest-only in-memory sqlite factory
  + `unwrap`, shared by the queries/ingest-sink/reports suites),
  `src/components/ui/dialog-shell.css` (the `golemine-dialog-overlay`/
  `golemine-dialog-content` centered-dialog animation classes — import the stylesheet
  from every component that uses them),
  `src/workers/shared/incremental-sha256.ts` (dependency-free streaming integrity
  hasher with FIPS/NIST vectors; D-041 — `sha256BlobHex` accepts an optional
  `onChunk` tee and uses one native `crypto.subtle.digest` for un-teed Blobs at or
  below `nativeSha256MaxBlobBytes` (64 MiB); `updateSha256WithZeros` has a matching
  `onChunk` overload),
  `src/workers/shared/service-kind.ts` (`classifyServiceKind` populating the
  optional `serviceKind` field on message records/previews so UI never
  string-matches raw service names), and `src/workers/shared/retry.ts`
  (`retryAsyncOperation`, used to retry transient `installOpfsSAHPoolVfs`
  failures during route switches).
  Backup-worker transient file ownership lives in
  `src/workers/backup/transient-staging.ts`: `openTransientStagingArea` (staged
  files with one idempotent `close()`), `ensureTransientSweep(backupId)` (the only
  sweep entry point), and `createTransientWorkspaceDirectory` (uniquely named
  caller-owned workspace directories — source-sqlite consumes it, so all
  `transient/` layout knowledge stays in this module). The once-per-backup-per-worker
  sweep removes the whole `transient/` directory and assumes at most one worker uses
  a backup's transient directory at a time (single-tab flows, D-029). Extend this
  module rather than opening ad hoc OPFS sync handles for future streaming
  consumers.
- Production iOS ingest is provider-neutral:
  `BackupWorkerApi.ingestBackupToDb(root, request, credentials?, progress?)` in
  `src/workers/backup/ios-ingest.ts` plus the backup-worker/db-worker bridge. The
  older `ingestUnencryptedBackup*` methods remain compatibility/test seams. The route
  uses Web Locks to prevent same-backup concurrent rebuilds
  and must not relay ingest batches through React. Ingest emits a `prepare` progress
  phase before the destructive db-worker `prepareIngest` call; the route treats only
  that awaited `prepare` event as "the derived DB is about to be modified", so
  detection/unlock/Manifest progress and other pre-prepare failures never downgrade a
  previously `ingested` record
  while prepare/later failures do — with one exception: `WorkerErrorCode`
  `derived_db_pool_unavailable` (prepare could not acquire/open the per-backup SAH
  pool, e.g. another tab is browsing the same backup) guarantees the derived DB was
  never modified, so the route restores a previously `ingested` record instead of
  marking it failed. `prepareIngest` opens the pool and derived DB before any
  destructive schema drop, and the backup-worker ingest bridge passes that code
  through instead of folding it into `db_ingest_failed`.
  `WorkerErrorCode` `backup_manifest_unreadable`
  means a required database's MBFile record could not be read; it is distinct from
  `backup_file_missing` (entry absent from Manifest.db). Ingest validates
  detection/encryption, opens unencrypted `Manifest.db` with root
  `Manifest.db-wal`/`-shm` sidecars applied when present (encrypted Manifest sidecars
  are ignored because no independent root-sidecar keys exist), reads only the needed
  sms/contact/contact-image databases and sidecars, normalizes
  Messages/contacts/attachments/tapbacks/avatars (resolved participants retain both
  full contact names and contact first names; group `displayName` is emitted only for
  an explicit `chat.display_name`, D-036; tapback classification is
  open-ended: `associated_message_type` 2000–2999 = reaction adds with unmapped kinds
  folded as `unknown`, 3000–3999 = removals diverted from messages; undecodable
  `attributedBody` with empty `text` emits a `message-body-undecodable` warning, and
  contact resolution runs once per handle during participant building), and streams
  batches to the db-worker sink. Long counted loops in normalization and aggregate
  writes should use `createThrottledWorkerProgress`; the overview displays item counts
  only for large totals so phase progress stays compact. The backup overview's
  read-only summary db-worker is released synchronously when a rebuild starts (through
  a release ref, not just React effect-cleanup timing) and stays released while ingest
  runs so rebuilds cannot contend with prepare for the same per-backup SAH pool
  (D-024). `src/workers/backup/source-sqlite.ts` applies committed SQLite WAL frames to a
  staged OPFS source file before callback-importing it into a dedicated transient
  `opfs-sahpool` read-only DB (D-021, D-022, D-041, D-042). There is ONE WAL
  pipeline: in-memory byte inputs adapt through `MemoryRandomAccessFile`,
  `SourceSqliteStagingInput` lets callers (encrypted sessions) decrypt-stream the
  main database directly into the workspace's staged file, workspace directories
  come from transient-staging's `createTransientWorkspaceDirectory`, and errors
  thrown by the caller's stage callback propagate unwrapped so crypto error codes
  reach the UI. WAL replay is single-pass with frame-aligned multi-MiB chunked
  reads and a 64 MiB pending-transaction buffer budget, falling back to a
  bounded-memory two-phase scan+apply when one transaction exceeds it. It rejects
  invalid WAL headers; commit-size validation is a 4 TiB per-commit hostility cap
  plus a whole-WAL structural bound applied ONLY to the final applied commit
  (checkpoint-truncated mains legitimately carry larger earlier commit records —
  never reintroduce a per-commit structural bound, D-042), and pages beyond their
  own commit's declared size are skipped. For frames it follows
  SQLite end-of-log behavior: apply the valid committed prefix and stop at the first
  invalid/stale/torn frame. It always forces staged source DB header bytes 18/19 to
  rollback-journal mode before the read-only transient sqlite-wasm open, including
  no-sidecar and no-committed-frame cases; otherwise sqlite may try to open missing
  transient sidecars and throw `SQLITE_CANTOPEN` (D-025). Do not try to make
  sqlite-wasm open Manifest-file-ID sidecars directly.
  Encrypted database mains decrypt-stream directly into the source-sqlite workspace
  (no intermediate session-staged copy); the OPFS quota preflight keeps its
  conservative 3x reserve because sidecar-dominated sets still stage WAL/SHM to
  transient OPFS while WAL reconstruction and the sahpool import each hold another
  copy. Optional contacts/contact-image sets get no pre-prepare preflight, so every
  read and stage is bounded against the remaining set budget BEFORE any
  decrypt/staging I/O — hostile declared sizes degrade to the
  `<role>-database-unreadable` warning without I/O. After a successful finalize,
  source-staging cleanup failures become the `source-staging-cleanup-failed` report
  warning (never a failed ingest, and never masking an original ingest error).
  `ingestBackupDirectory` always ends an encrypted ingest by locking the session
  through `resetBackupSourceCaches` (D-043), so the one-shot overview worker leaves
  `transient/` empty without relying on route discipline. Timestamp normalization must
  accept sqlite bigint values for Apple nanosecond epochs and omit out-of-range dates
  instead of throwing. Attachment source
  hashing during ingest is bounded to Manifest-known files at or below 64 MiB, guarded
  by actual `File.size`, and capped by a per-ingest eager hash budget; larger,
  unknown-size, deceptive-size, or budget-exhausted media keeps path/domain/GUID
  provenance and is hashed later on demand by extraction/report code.
- M5 encrypted sessions live in `src/workers/backup/encrypted-session.ts` and the
  dependency-free WebCrypto modules under `src/workers/backup/crypto/` (D-038).
  `unlockBackupSession` accepts a password only on that RPC, parses bounded keybag TLV,
  runs the modern two-stage or legacy PBKDF2 KDF, unwraps AES-KW class keys, decrypts
  Manifest.db, and retains only mutable class keys plus its transient Manifest reader.
  Clear the structured-cloned credential field/drop local string references immediately
  after unlock/open (JS strings cannot be zeroized); continue clearing all mutable
  password/key byte arrays. M5.5 removes D-039's RAM caps (D-041): encrypted and
  unencrypted Manifest/source main/WAL/SHM sets stream through transient OPFS and
  callback-import into unique 16-slot `opfs-sahpool` instances without full wasm-heap
  copies. Keep the REQUIRED messages set's metadata/stored-file/quota validation
  BEFORE the destructive `prepare` boundary at
  `assertRequiredSourceDatabaseSetWithinBudget`; it now uses an 8 TiB staged-set /
  4 TiB per-file hostile-metadata sanity bound plus remaining OPFS quota, reserving a
  conservative 3x peak for decrypt staging, WAL reconstruction, and sahpool import.
  Missing required records, malformed encrypted Size/key/alignment metadata, and insufficient
  quota must remain pre-prepare; trial-unwrap every present required main/WAL/SHM file
  key there and immediately zeroize it. Plaintext staging lives only under
  `golemine/backups/<id>/transient/`: close/finally, explicit lock, and session eviction
  delete owned files/pools; `ensureTransientSweep(backupId)` is the only sweep entry
  point — the first transient open in each fresh worker removes the whole
  `transient/` directory (crash leftovers) before its Manifest quota estimate, and
  every later staging/workspace open in that worker reuses that sweep because
  Manifest and several source DBs may coexist. Remove backup wipes the parent. Lock
  drains tracked reads for their full decrypt/stage/respond or direct-extraction
  duration, then awaits staging and Manifest-pool cleanup before resolving, even when
  the pool's synchronous close reports an error.
  Explicit lock, different backup id/root `isSameEntry` failure, route unmount, or
  worker termination destroys/closes the session; `lockBackupSession` goes through the
  single `resetBackupSourceCaches()` seam in attachment-read (manifest cache + session
  in tandem), and the session drains tracked reads before closing its Manifest reader.
  All source-touching session work goes through the single
  `runTrackedSessionOperation` runner. `stageSourceFile(record, destination, options)`
  is the session API that decrypt-streams a main database into a caller-owned
  destination; `readSourceFileBlob` exists ONLY to stage encrypted WAL/SHM sidecar
  payloads for database opens (bounded preview/report reads decrypt in memory and
  respond with a Blob copy — no transient staging, no retention race, D-043); and
  `writeSourceFile` hosts extraction's in-window `finalize` commit point. Session
  eviction and replace-unlock are best-effort on cleanup failure (a fresh unlock
  never fails on the OLD session's cleanup problems), while the explicit lock RPC
  still propagates cleanup errors so its caller can fall back to worker termination
  (D-043).
  Supplying a password to `unlockBackupSession` always verifies it — an active
  matching session is reused only by password-less callers; a supplied password
  triggers a full replace-unlock so a wrong password can never report success.
  Corrupt sibling keybag class keys are skipped and reported
  (`UnlockedBackupKeybag.warnings`), not fatal; wrong password remains the
  all-candidates-fail signal. Never move passwords or raw keys to
  React, recents, OPFS, logs, errors, or the normalized model. Overview ingest uses a
  separate one-shot worker; messages deliberately prompts again to unlock original
  attachments for its route-scoped worker. Password entry in both routes goes through
  the shared `src/components/backup/backup-password-form.tsx`
  (`useBackupPasswordForm` + `BackupPasswordForm`): uncontrolled input, synchronous
  read-then-clear around dispatch, refocus on `backup_password_incorrect`, and the
  single persistence disclosure (Design.md §7, D-038) live there — do not hand-roll
  another password field. Wrong password is
  `backup_password_incorrect` and recoverable; malformed/unsupported crypto is
  distinct and remains pre-prepare. Encrypted MBFiles require `Size` and
  `EncryptionKey`; validate block/source/plaintext bounds before hashing/allocation,
  decrypt `File` slices through `decryptFileChunks`, and preserve plaintext
  `sha256`/size plus ciphertext `sourceSha256`/`sourceBytes`/`isEncrypted` in
  source-read responses and Manifest/database-input ingest provenance. The ciphertext
  `sourceSha256` is opt-in (`includeSourceSha256`): on session paths it now folds
  single-pass into the decrypt read via the chunked CBC generator's
  `onCiphertextChunk` tee (plus a bounded read of any stored tail the decrypt never
  touches), so it costs extra hashing work rather than a second full read, and it is
  free on unencrypted reads. Database provenance and `readSourceFile` RPC responses
  request it; eager attachment hashing does not. Normalized
  attachment rows intentionally keep the optional plaintext hash for preview
  verification; report export gets both labeled attachment hashes through an exact-path
  `readSourceFile`. Plaintext and opt-in ciphertext provenance hashes fold through the
  dependency-free incremental SHA-256 helper in `src/workers/shared/` (the D-041
  integrity-only exception to WebCrypto-only crypto). `readSourceFile` returns a Blob;
  `extractSourceFile` writes decrypt chunks directly to the save-picker writable.
  Manifest decryption and file decryption share the one
  chunked CBC generator (`decryptAes256CbcBlobChunks`, reusable ciphertext scratch,
  borrowed subarray chunks, optional `onCiphertextChunk` tee), and every decrypt
  destination flows through the single `decryptSourceFileToDestination` streamer and
  its `DecryptedPlaintextDestination` shape in manifest-db; there is no one-shot
  whole-buffer decrypt anymore. Present zero-byte root Manifest sidecars are
  tolerated (normal after `wal_checkpoint(TRUNCATE)`). Manifest staging hashes
  during the write with a 16-byte pad hold-back so `contentSha256` covers exactly
  the normalized content without re-reading the staged file
  (`normalizeStagedManifestDatabase` is the exported byte-level core, shared with
  `source-sqlite.test-support`); the decrypted Manifest deliberately keeps its
  stage→copy→import shape because normalization needs read/resize access. Unit-test
  seams are the single `setBackupSourceOverridesForTests` registry
  (openSourceSqlite/stageDecryptedMain/stagePlaintext/sweepTransient) — do not
  reintroduce per-option test globals.
  Per-file ciphertext may contain a block-aligned stored tail more than 16 bytes beyond
  authoritative `MBFile.Size`; decrypt and truncate to `Size` rather than rejecting the
  delta. Sparse files may instead declare `Size` larger than the encrypted materialized
  prefix; leave the bounded destination's remaining bytes zero-filled. Preserve
  ciphertext alignment; encrypted read caps bind the PLAINTEXT size, with the stored
  ciphertext allowed up to `maxReadBytes + 16` for the padding block — both enforced
  before reading/allocation.
  The deterministic encrypted fixture and vectors live
  alongside the existing mini backup under `e2e/fixtures/`; `e2e/m5.spec.ts` locks the
  wrong-password, no-secret-persistence, fresh-session unlock, decrypted-preview,
  and post-ingest empty-`transient/` flows (a completed encrypted overview ingest
  must leave no staged plaintext).
  The messages success strip's **Lock attachments** action must await session
  invalidation/active-read drain, restore and focus the shared password form, and fall
  back to terminating the route worker if the lock RPC fails.
  Route cleanup sets `routeActiveRef` false before releasing clients; preserve the
  post-permission/pre-client and post-RPC guards so a deferred Chrome permission prompt
  cannot create or strand an encrypted worker after unmount.
- M6 reports are worker-owned in `src/workers/db/reports.ts` and rendered by
  `src/features/report/report-routes.tsx` (`/backup/:id/reports` list route —
  the overview's Reports tile targets it — plus builder and print routes); the shared
  messages-route picker lives in `src/features/report/report-picker-dialog.tsx`.
  Report schema version 3 adds `report_items.position` and `reports.updated_at`.
  Same-version ingest resets MUST preserve report tables because names/notes/case
  metadata are user-authored; the preserved set is declared in `schema.ts`
  (`userAuthoredTables`) and finalize prunes only selections whose message
  disappeared via `pruneOrphanedReportItems` (also owned by schema.ts). Version
  migrations, confirmed backup replacement, and Remove backup still wipe report
  state (D-044). Keep report SQL inside db-worker and the one picker outside
  virtualized rows. Builder saves validate bounded fields, unique message ids, and a
  supported IANA timezone; the picker's add path enforces the same `maxReportItems`
  cap (bounds live in `src/workers/shared/report-limits.ts`, import-safe from UI —
  never re-hardcode them in `maxLength` attributes). Report deletes are explicit
  transactional two-statement deletes: SQLite FK enforcement is per-connection, so
  never rely on `ON DELETE CASCADE` alone (the OPFS factory now also runs
  `PRAGMA foreign_keys = ON` per connection). Item removal leaves positions sparse
  on purpose — nothing requires density and renumbering under the UNIQUE
  (report_id, position) index is collision-prone. Read-side report row mapping is
  lenient (skip-and-degrade: malformed metadata or a now-unsupported stored timezone
  degrades that row instead of failing `listReports`), `readReport` hydrates items
  through the batch `readMessagesByIds`/`readConversationsByIds` + one
  `hydrateMessages`/`hydrateConversations` pass, and the report `run()` wrapper
  preserves typed factory errors via `toDbQueryWorkerError` (never flatten
  `derived_db_pool_unavailable`). Print preparation reads exact attachment Manifest
  paths through backup-worker, labels plaintext vs stored-source SHA-256, embeds only
  route-lifetime image Blob URLs, and discloses per-attachment failures in the
  appendix. `sms.db` hashes come from the version-gated ingest summary. Encrypted
  print preparation must use the shared uncontrolled password form, a fresh route
  worker, and an explicit post-read lock that runs in `finally` on every unlocked
  path (worker termination is the fallback if the lock RPC fails). Do not enable
  `window.print()` before provenance preparation completes.
  The print document is transcript-first: match the Messages workspace's sent/received
  alignment and normalized bubble colors, keep attachment previews inside bubbles,
  and keep reactions/status/displayed timestamps adjacent. Number messages in the
  outside gutter and put report notes, participants, per-message source identifiers,
  attachment source fields/hashes, and reaction provenance in the cross-referenced
  `Message metadata` section after the transcript; do not move raw metadata back under
  each bubble.
  Print CSS uses token-defined forced-light values, `@page` title/footer/timezone plus
  page counters, and `break-inside: avoid` for message/annotation evidence groups.
  The `--report-print-title`/`--report-print-footer` variables MUST be stamped on
  `document.documentElement` (the print route does this in an effect): `@page` margin
  boxes resolve custom properties from the root element only, so variables on nested
  elements never reach the printed header/footer.
  `e2e/m6.spec.ts` covers timeline + search selection, multiple report persistence,
  builder metadata, source attachment/image provenance, dark UI, print-media rules,
  the print action, and the reports list route.
- M4 unified browse/search is implemented in `src/features/m3/messages-route.tsx` and
  covered by `e2e/m3.spec.ts`; there is no standalone search route. It requires an
  `ingested` recent, uses `react-virtuoso` for conversation/timeline/result lists,
  renders all backup strings as text nodes, supports load-more pagination, and opens
  results in thread context via
  `/backup/:id/messages?conversation=...&message=...`. Explicit conversation names
  win; otherwise one-to-one labels use the other participant's full label and unnamed
  groups list every non-self participant with contact first name/name/handle fallbacks
  joined as "A, B and C" (D-036). Search always starts across all
  conversations; selecting a hit-filtered thread scopes only the Results column, and
  the "All" affordance restores global results. Details is absent until message
  selection, overlays with dialog/focus containment below the `--layout-detail-dock`
  (96rem) docking threshold, and docks only when the four-pane layout fits. The dock
  threshold has one source of truth: `detailDockMediaQuery` resolves the token into a
  JS `matchMedia` query (lazily initializing the overlay state so cold deep links
  render the correct mode on the first frame) that drives BOTH the dialog semantics
  and the grid-template-columns classes — CSS media queries cannot reference custom
  properties, so never reintroduce a stylesheet breakpoint (e.g. Tailwind `2xl:`)
  for docking. Crossing the threshold while Details is open keeps the return-focus
  refs intact and moves focus to the pane in the new mode; focus returns to the
  activating element only when Details fully closes. Modal focus containment (inert
  `#root`, focusin backstop, Tab trap, Escape dismiss) lives in the shared
  `useModalFocusContainment` hook (`src/components/ui/modal-focus.ts`) — reuse it
  for future overlays instead of per-pane traps. Search draft fields are local to
  `SearchPanel` (lifted on submit) so keystrokes never re-render the virtualized
  panes; both search panes share the generic `SearchPaneState`/`loadMoreSearchPage`
  machinery and the `useVirtuosoJump` hook in `m3-shared.tsx`; results-scope
  identity is built only via `buildResultsScopeKey`/`buildReplacementResultsKey`.
  Compact active-search pane tokens
  (`--pane-search-threads`, `--pane-results`, `--pane-search-timeline-min`) keep the
  workspace inside the 1024px floor; do not replace them with hardcoded widths.
  Activated search results are cached per active search, but the effective pin is
  derived from the URL-selected conversation/message; preserve that split so browser
  Back/Forward cannot leak a hit into the wrong Results scope. Every explicit result
  click also increments the Virtuoso jump revision so re-activating the same selected
  hit recenters it. Replacement searches invalidate in-flight scope/pagination work,
  keep the prior displayed state coherent on failure, bind the Results title/count
  to the actually displayed scope (marked "previous scope" while a new scope loads or
  fails), and a failed thread-scoped fetch shows a Retry affordance. The modal
  Details portal lives outside inert `#root`; focus return re-finds the activating
  trigger by message id (`data-search-result-id`/`data-message-id` attributes — not
  test ids), falling back to the focusable timeline bubble when a virtualized result
  trigger disappears.
  Keep the UI token-only and Design.md-compliant; sent-bubble background follows the
  normalized `serviceKind` (`sms-family` → `--bubble-sms`; `imessage` and `unknown` →
  `--bubble-imessage`, D-032 — never string-match raw service names in UI), message
  sent-bubble text uses
  `--bubble-foreground`, avatar initials use `--avatar-foreground`, and fallback
  avatars are chosen from the eight `--avatar-*` tokens by stable participant
  handle/label hash. Do not add hardcoded colors/sizes or custom focus styles in these
  panes.
- The M4 search date filter is the shared `DateRangePicker` in
  `src/components/ui/date-range-picker.tsx`, backed by React DayPicker range mode in a
  Radix popover (D-037). Keep the two-month fixed grid, month/year navigation, staged
  apply/cancel, same-day completion, announced selection status, explicit clear, and
  Escape focus return; do not reintroduce paired native `type="date"` inputs. Visible
  calendar styling is remapped in `date-range-picker.css` to Lode tokens. Keep the
  actual transparent DayPicker `.rdp-dropdown` select and its options tokenized and
  inheriting the active `color-scheme`; styling only the visible wrapper makes the
  native list white in dark mode. Clickable outside-month dates use full-opacity
  `--text-secondary` for AA contrast; preserve selected-endpoint hover behavior.
  Navigation and selection are bounded to January 2007 through December of the browser
  runtime's current year; keep spillover days outside that range unavailable. Date-only
  parsing/formatting lives in `src/components/ui/date-range.ts` and deliberately uses
  local calendar components to round-trip `YYYY-MM-DD`; `buildSearchFilters` remains
  the single conversion to inclusive UTC start/exclusive UTC end query bounds.
- M4 db-worker reads live in `src/workers/db/queries.ts`: `listConversations`
  (`listThreads` alias), `getMessageTimelinePage`,
  `getMessageTimelineMessagesPage` (same request shape, messages-only response
  without conversation hydration — use it for load-more), `getMessageDetails`,
  `searchMessages`, and `listSearchConversations`. Extend this query API rather than
  issuing SQL from React. Unquoted terms compile to case-insensitive implicit-AND FTS5
  prefixes. Quoted literals are Unicode-case-insensitive raw substrings: only ASCII
  letter/digit/underscore tokens with provably sound internal left boundaries narrow
  through FTS, then candidate bodies are verified with escaped `/iu` matchers in
  db-worker. This ASCII restriction prevents JavaScript/SQLite `unicode61` case-table
  skew from hiding matches. Every quoted-literal verification scan — FTS-narrowed or
  not — applies the newest-first `boundedSearchRowBudget` (10,000 candidate rows) in
  a single ordered prepared-statement pass with throttled progress (D-035; never
  reintroduce LIMIT/OFFSET batches, which re-execute the FTS match per batch).
  `SearchCoverage` is a discriminated union: `fts` means complete, `bounded-scan`
  carries `rowBudget` and the UI must disclose truncation — branch on `strategy`,
  not on field presence. Conversation-scoped no-narrowing-key quotes share the one
  global bounded corpus (scope filters after the budget; test-locked, D-035).
  `listSearchConversations` uses identical semantics and
  returns newest-hit order plus per-thread hit counts. Search returns structured
  snippet segments for safe text rendering; exact quoted literals are highlighted
  and, on the verification path, unquoted AND-terms are highlighted as whole
  prefixed tokens inside the literal-centered window; snippet windows align to code
  points so emoji never split into lone surrogates. Hostile bodies containing
  U+0001/U+0002 degrade to a single non-highlighted
  segment and sentinel chars are always stripped (D-030/D-034). Last-message previews
  use a per-conversation correlated
  LIMIT-1 lookup (not ROW_NUMBER over all messages) — preserve its ordering
  `COALESCE(sent_at_utc, '') DESC, source_rowid DESC, id DESC` when touching it.
- Attachment source reads use provider-neutral
  `BackupWorkerApi.readSourceFile(root, request, progress?)` in
  `src/workers/backup/attachment-read.ts` (the old unencrypted method is a compatibility
  seam). One `resolveManifestForSourceRequest` owns the manifest/session cache rules
  for both read and extract. It revalidates backup/root identity, applies unencrypted
  root Manifest WAL sidecars or requires the matching encrypted session, performs
  exact source domain/path lookup, reads through read-only wrappers, enforces caller
  byte caps, and verifies optional plaintext hashes. Source preview responses and media-worker image
  requests carry Blobs so full payloads are not transferred as arrays; cached JPEG
  thumbnail responses remain transferred `Uint8Array`s. Preview and future report
  hashing use this API, while extraction uses `extractSourceFile` so backup-worker
  writes directly to the save-picker handle; do not pass raw
  writable-capable handles into provider code. Extraction has an explicit commit
  point: once `writable.close()` succeeds, a racing session lock or post-close
  failure can no longer convert the completed extraction into a reported failure.
  Pre-commit failure aborts the atomic writable; never delete the selected handle
  from UI cleanup because it may name an existing user file. Manifest staging
  cleanup failures after a read/extract outcome is decided are logged, never
  surfaced as the operation's result. The backup worker memoizes the
  most recent backupId's detection result and opened `ManifestDbReader` across
  calls (sound because source backups are read-only while open); requests
  without a backupId bypass the cache, a different backupId closes the old
  reader, and cache hits verify root identity with `isSameEntry` (same backupId
  from a different root directory evicts and rebuilds instead of trusting a
  stale manifest index). `ManifestDbReader` retains only byte-free provenance
  metadata for its root source files, and `source-sqlite` truncates/unlinks its
  transient sahpool database synchronously on close before async directory cleanup.
  Read-size budgets for previews come from `src/workers/shared/media-limits.ts`;
  extraction has no former 1 GiB materialization cap, but retains the absolute staged
  sanity and hostile metadata checks (D-041 supersedes D-031).
- M3 media thumbnails use `MediaWorkerApi.createAttachmentThumbnail` in
  `src/workers/media/thumbnails.ts`. Native PNG/JPEG/GIF/WebP images are rendered in
  the worker with `createImageBitmap`/`OffscreenCanvas`; HEIC thumbnails use
  unmodified `libheif-js` 1.19.8 vendor files under
  `public/vendor/libheif-js/1.19.8/`, lazy-loaded by `media-worker` so LGPL code stays
  isolated from app chunks (D-026, D-027). Production imports the public vendor ES
  module directly; Vite dev must use the worker's same-origin fetch-to-Blob module
  shim (`importPublicModuleThroughBlobUrlForDev`) because Vite rejects direct module
  imports from `public/` during source transforms (D-033). Thumbnails are
  cached as JPEG files under `golemine/backups/<backup>/thumbs/attachments/` using a
  sanitized hash/provenance cache key; transparent sources are flattened onto a white
  matte before JPEG encoding because phone attachments are photo-dominant. HEIC preview
  prefers embedded HEIF thumbnails when they satisfy the display target, uses the
  largest available embedded thumbnail when the primary image is over the memory cap,
  and otherwise decodes the primary only when its RGBA surface is at or below 256 MiB
  (67,108,864 pixels, enough for 48 MP phone photos). Thumbnail generation is serialized
  inside `thumbnails.ts` regardless of caller concurrency; keep libheif release calls
  and the post-downsample canvas resets intact. Do not import `libheif-js` from app
  source or let Vite bundle
  it; update NOTICE and the package-specific license audit exception for any codec
  version change.
- The M1 synthetic mini-backup fixture is generated under
  `e2e/fixtures/generated/ios-mini-backup/` and covers open -> detect -> recents in
  `e2e/m1.spec.ts`. The synthetic device values and plist builder live once in
  `e2e/fixtures/ios-mini-backup.mjs` (shared by the generator, ios-backup unit
  tests, and the Playwright specs) — extend that module rather than re-declaring
  fixture metadata. M2 extends the same fixture with real generated Manifest/sms/
  AddressBook/AddressBookImages SQLite data, real WAL sidecars created through
  Node's experimental `node:sqlite` `DatabaseSync` and then normalized to deterministic
  salts/checksums, a WAL-only message/contact, a tapback, an attachment file, a
  prefixed valid PNG avatar, and a malformed avatar warning case. The generator may
  print Node's experimental warning for `node:sqlite`; that is fixture-build-time only.
  M5 adds `generated/ios-mini-encrypted-backup/` from the same plaintext sources with
  NSKeyedArchiver-shaped MBFile records, two passcode-wrapped class records,
  deterministic independent Manifest/file keys, PKCS#7-encrypted databases/WALs/media,
  exported production-sized PBKDF2/AES-KW vectors, and generator decrypt/byte-compare
  self-checks. Default fixture DPIC is CI-accelerated; run the 10,000,000-round vector
  with `GOLEMINE_RUN_SLOW_KDF=1`.
- Crypto: WebCrypto only (PBKDF2, AES-KW, AES-CBC, SHA-256); passwords/keys are
  session memory only, never persisted.
