# Golemine Plan

Phased build order. Each milestone ends in a working, demonstrable state. Update the
status column as work lands; add discovered work as tasks under the relevant milestone
rather than inventing new documents.

**Current status: M7 is in progress. The first polish increment wires the generated
steampunk-automaton illustrations into the landing header and active drag/drop overlay, the
unsupported-browser capability screen, and all three illustrated iPhone-guide
sections. One shared decorative component renders paired light/dark WebP variants;
CSS follows both the system color scheme and manual override without theme queries in
React, keeps the artwork out of the accessibility tree, and removes it from print.
Review hardening adds every WebP to Workbox precache, lazy-loads only the visible
theme variant, preloads the mounted drag overlay, collapses illustrated grids in
print, and covers the full system/manual theme matrix plus offline guide artwork.
M6 reports and all earlier encrypted/streaming functionality remain complete. Next
is the final favicon and PWA icon set.**

## M0 — Scaffolding

Goal: empty app that builds, tests, lints, installs as an offline PWA, and proves the
core privacy/offline invariants before feature work begins.

- [x] pnpm + Vite + React 19 + TypeScript (strict) scaffold, repo layout per Architecture §11.
- [x] Tailwind + shadcn/ui setup; base app shell + react-router with placeholder routes.
- [x] Design system foundation per Design.md: `tokens.css` (all light/dark OKLCH tokens,
      type scale, spacing, radii, shadows, motion), Tailwind/shadcn variable mapping,
      self-hosted Inter + JetBrains Mono (OFL, recorded in NOTICE).
- [x] Theme switching: system/light/dark toggle, localStorage persistence, pre-paint
      inline script (no theme flash), `color-scheme` set; e2e test covers all three states.
- [x] Worker plumbing: Comlink helper, shared typed API boundaries (`BackupWorkerApi`,
      `DbWorkerApi`, `MediaWorkerApi`, progress/error types), one demo round-trip per
      worker (backup/db/media).
- [x] sqlite-wasm running in db-worker with opfs-sahpool VFS; smoke test
      (create/query a DB in OPFS). Vite keeps `@sqlite.org/sqlite-wasm` out of
      dependency optimization so dev-server wasm loading resolves the real
      `sqlite3.wasm` asset instead of the SPA HTML fallback (D-020).
- [x] Central storage/version constants, including `derivedDbVersion`, before any ingest code lands.
- [x] Service worker via vite-plugin-pwa; precache app shell/fonts/wasm; Playwright verifies full offline reload works.
- [x] Privacy/network guardrail: Playwright route interception fails on unexpected network
      after app load; production app assets are same-origin only.
- [x] Production security baseline: static-host header template in `public/_headers`
      (same-origin scripts/connect; self-hosted workers/wasm; `script-src` includes
      `'wasm-unsafe-eval'` for sqlite-wasm/codec compilation). Playwright replays the
      CSP header onto every response and runs the worker/sqlite diagnostics under it.
- [x] Vitest + Playwright (Chromium) wired up with one trivial test each; GitHub Actions
      for pull requests runs lint, typecheck, unit tests, e2e tests, and license audit.
- [x] License audit script (fails CI on disallowed licenses; allowlist per AGENTS.md) + NOTICE file.
- [x] Fixture convention: `e2e/fixtures/` contains synthetic outputs only, with generator
      scripts/metadata so fixtures can be regenerated and inspected.

## M1 — Landing, backup opening, recents

Goal: user can open a backup folder, see it recognized, and manage a recents list.

- [x] Browser capability gate: `src/lib/capabilities.ts` probes features, not the user
      agent (`"showDirectoryPicker" in window`, `navigator.storage.getDirectory`,
      `"createSyncAccessHandle" in FileSystemFileHandle.prototype`,
      `"getAsFileSystemHandle" in DataTransferItem.prototype`), checked once at boot.
      The sync-access-handle probe falls back to a tiny capability worker because
      Chromium exposes the API in the worker/OPFS context used by sqlite-wasm even
      when it is absent on the window prototype.
      Unsupported browsers get a designed block screen (Design.md empty-state rules,
      both themes) on workspace routes naming Chrome as the supported browser; the
      backup guides stay accessible in any browser. e2e coverage via a page with the
      relevant APIs deleted. Critical-API list maintained per AGENTS.md rule.
- [x] Landing page: operational open-backup screen first (drag-drop,
      `showDirectoryPicker()`, recents, privacy statement) with a concise one/two-line
      explanation of what the tool does and links to the backup guides; Lode brand
      gradient may be used as a restrained accent per Design.md §4, not as a
      marketing-first layout.
- [x] Backup detection in backup-worker: validate folder, parse `Info.plist` + `Manifest.plist`, detect encryption, surface device info. Clear errors for non-backup folders.
- [x] Recents list in IndexedDB (handle persistence, `requestPermission()` re-grant flow, rename, remove — remove also wipes OPFS derived data).
- [x] Same-device snapshot replacement confirmation (D-040): the same directory and
      backup date reopen normally; a changed folder or date offers **Keep existing**
      or **Replace backup**, with replacement wiping derived data before resetting the
      recent to `not-ingested`.
- [x] Backup overview page (`/backup/:id`): device info card, encrypted badge, ingest CTA.
- [x] Info pages: how to back up an iPhone (Finder/iTunes, incl. why encrypted is OK,
      inline Finder steps, Apple Support references, backups may be created on another
      computer, and macOS backups should be copied from
      `~/Library/Application Support/MobileSync/Backup/` to a Chrome-readable folder
      before opening) and Android (placeholder pointing at future support).
- [x] Fixture mini-backup (synthetic) checked into `e2e/fixtures/`; e2e test for open → detect → recents.
- [x] Post-review hardening: normalized `BackupDeviceInfo` across the worker boundary
      (rule 8), merge-aware `recordDetection` in the recents store (rename/ingest
      preservation, `derivedDbVersion` staleness, stale-record retirement),
      synchronous drag-drop handle collection, fail-open cached capability probe
      (D-017), skip-and-report recents parsing, binary-plist unsigned-integer and
      CDATA fixes, shared synthetic-fixture module, layout/error-format dedup, and
      role-specific root-plist size limits so large real-world `Info.plist`
      application metadata does not block detection (D-019).

## M2 — Ingest pipeline (unencrypted)

Goal: an opened, unencrypted backup becomes a browsable derived DB.

- [x] Manifest.db reader (locate files by domain/relativePath, incl. WAL sidecar handling).
- [x] Binary + XML plist parser (or vetted MIT dependency) for MBFile records.
- [x] sms.db extraction: copy into backup-worker transient sqlite memory, apply
      committed WAL frames to a source-byte copy (D-021), open read-only.
- [x] Synthetic ios-mini-backup fixture upgraded from M1 placeholders to real
      unencrypted M2 data: Manifest.db `Files` rows, sms.db direct/group/tapback/
      attachment rows, AddressBook contacts, and prefixed contact-thumbnail image
      blob.
- [x] Defensive typedstream text extractor for iOS Messages `attributedBody` blobs
      (bounded UTF-8/UTF-16 NSString-like payload extraction; malformed input returns
      `undefined`).
- [x] Normalizer: chats → Conversations, handles → Participants, messages
      (Apple-epoch seconds/nanoseconds conversion including sqlite bigint values,
      `attributedBody` typedstream text extraction, tapback folding, group events),
      attachments metadata and source hashes.
- [x] Contacts resolution from AddressBook.sqlitedb (libphonenumber-js matching).
- [x] Contact avatar thumbnails from AddressBookImages.sqlitedb (D-015): join on
      `record_id` = ABPerson rowid, sniff JPEG/PNG magic in blobs (offset may be
      non-zero), skip-and-report on any parse failure, missing db is a no-op; store
      content-addressed in OPFS alongside the M3 thumbnail cache.
- [x] Derived DB schema + ingest sink in db-worker (Architecture §6), incl.
      `ingest_meta` provenance (`summary_json` as the single machine-read record —
      source hashes, timestamps, counts live inside it — plus scalar debug rows,
      D-023), FTS population, per-backup OPFS `opfs-sahpool` opening, contact-avatar
      path metadata, and in-memory sqlite test seams.
- [x] Streaming progress UI; ingest restartable from source; `derivedDbVersion`
      re-ingest trigger is preserved through recents and updated on ingest status
      writes.
- [x] Long-running ingest progress granularity: unbounded message/attachment
      normalization and aggregate write loops emit throttled item-count updates, and
      the overview displays counts for large totals without cluttering phase progress.
- [x] Golden-file unit tests for typedstream, timestamps, tapbacks, WAL sidecars,
      contacts, avatars, attachments, and db sink behavior against fixtures.
- [x] Post-review hardening: WAL replay stops at the first invalid/stale/torn frame
      while keeping the valid committed prefix (including root `Manifest.db-wal`,
      D-022), typedstream scanning continues past malformed string candidates,
      attachment source lookups are skip-and-report with actual-`File.size` guarded
      bounded/deferred hashing, absolute iOS attachment paths normalize back to
      `Library/SMS/Attachments/**`, iOS 17 unknown/custom tapback types are folded
      instead of emitted as message rows, attachment GUID and reaction raw timestamp
      provenance persists into SQLite, production ingest streams backup-worker ->
      db-worker directly, Web Locks guard same-backup rebuilds, and interrupted
      `ingesting` recents recover as `needs-reingest`.
- [x] Post-review cleanup pass: shared worker helper modules
      (`src/workers/shared/` sqlite-init/binary/progress, `apple-time.ts`,
      `src/lib/worker-names.ts`), `ingest_meta` slimmed to `summary_json` + scalar
      debug rows with shallow `derivedDbVersion`-gated summary validation (D-023),
      generic per-entity upsert specs in the ingest sink, a `prepare` progress phase
      before destructive db-worker prepare (pre-prepare failures never downgrade an
      `ingested` recent) with a distinct `backup_manifest_unreadable` error code,
      open-ended tapback ranges (2000–2999 adds folded to `unknown`, 3000–3999
      removals), `message-body-undecodable` warnings, single-pass contact resolution
      during participant building, and unit tests for shrinking-final-commit WAL
      replay and detection tolerating unparseable Manifest.db content.
- [x] Real-backup OPFS hardening: per-backup sqlite-wasm `opfs-sahpool` storage now
      reserves a 16-slot minimum for stale journal/temp-file headroom, derived DB open
      failures report pool details, the overview route releases its summary reader
      during rebuilds, and Playwright covers ingest -> rebuild (D-024).
- [x] Source SQLite open hardening: every copied source DB is forced to rollback mode
      before sqlite-wasm opens the transient read-only file, including no-sidecar and
      no-committed-frame WAL cases (D-025).

Deferred after M2: streaming row normalization — normalize currently materializes full
row arrays before batching; a streaming rewrite remains later scale hardening work.

## M3 — Browse & search

Goal: the core exploration experience.

- [x] Thread list pane (virtualized, recency-sorted, unresolved handles shown raw).
- [x] Message timeline (virtualized bubbles per Design.md §7.1: sender runs, day
      separators, system events, reactions badged, edited/unsent indicators,
      jump-to-context from search results).
- [x] Message detail panel: full metadata incl. provenance fields (GUID, rowid, raw timestamp).
- [x] Attachment rendering: native images inline through media-worker thumbnails with
      source-byte fallback; HEIC thumbnails via isolated lazy-loaded `libheif-js` in
      `media-worker` with embedded HEIF thumbnail fallback for over-cap originals;
      native video via `<video>` when Chrome can decode the lazily read original;
      generic file card + "extract original" (save via File System Access API) for
      everything else.
- [x] Thumbnail cache in OPFS (JPEG previews, content-addressed for native image and
      HEIC attachments).
- [x] HEIC decode memory hardening: serialize thumbnail generation, cap each decoded
      RGBA surface at 256 MiB (enough for 48 MP phone photos), and promptly release
      canvas backing stores after downsampling.
- [x] FTS5 full-text search + filters (conversation, participant, date range,
      has-attachment); snippets; jump-to-context in thread; load-more pagination for
      result sets beyond the first window.
- [x] Performance posture: UI lists are virtualized, db-worker queries are bounded and
      paginated, attachment reads are lazy/bounded and transferred across Comlink, and Playwright exercises the full
      browse/search path. A dedicated 100k-message frame-rate/search-latency benchmark
      remains a later hardening task once a large synthetic fixture generator lands.
- [x] Post-review Design.md §7/§8 alignment: deterministic 8-token avatar fallbacks
      at 28px, semantic foreground tokens for sent bubbles/avatar initials, visible
      run-end and hover/focus/selected timestamps, 10x14 bubble padding with a
      practical 220px minimum, capped attachment frames, and a below-1024px detail
      overlay instead of stacking all three panes.
- [x] Post-review M3 fix pass: shared worker modules for sqlite error
      classification, media MIME sets and byte budgets, service-kind mapping, OPFS
      helpers, stable hashing, guards, and retry; db-worker snippet-sentinel
      hardening (D-030), correlated LIMIT-1 last-message previews, and a
      messages-only `getMessageTimelineMessagesPage` for timeline load-more;
      per-backup Manifest reader memoization for attachment reads; route-scoped
      worker ownership with SAH-pool install retry (D-029); StrictMode-safe preview
      lifecycle with a small concurrency cap and cache-first thumbnail probes;
      user-initiated extraction with an explicit 1 GiB budget and save-stub cleanup
      on failure (D-031); normalized `serviceKind` bubble styling (D-032); and LGPL
      guardrails extended to template-literal dynamic imports plus byte-compared
      `libheif-js` vendor files in the license audit.

Deferred after M3: video poster-frame generation, a repeatable 100k-message
performance benchmark, and a jump-to-date timeline navigation control (part of the
original timeline scope that was quietly dropped during M3 review — still wanted;
tracked here so it is not lost).

## M4 — Unified messages & search

Goal: search is part of the messages workspace, not a separate page. Browsing and
searching are one experience with shared thread/timeline context (D-034).

- [x] Search panel above the Threads/timeline workspace: the standalone search page's
      fields minus the conversation selector (search always spans all conversations),
      with explicit run and reset controls. Reset returns the workspace to plain
      browse mode.
- [x] Search semantics rework in db-worker (`compileUserTextToFtsExpression` +
      `searchMessages`), per D-034:
      - Case-insensitive throughout (FTS5 unicode61 folding for word terms; escaped
        Unicode `/iu` matching for substring verification).
      - Unquoted space-separated words: implicit AND, any order, anywhere in the
        message, each word matched as an FTS5 prefix (`word*`).
      - Quoted strings: true Unicode-case-insensitive substring match — compile only
        compatible ASCII letter/digit/underscore tokens with a sound internal left
        boundary to an FTS narrowing query, then verify the raw substring against
        candidate bodies in the db-worker. Quoted strings with no compatible key
        (including punctuation/emoji-only, non-ASCII-only internal tokens, and
        single-token mid-word literals) use a bounded non-FTS scan. Every
        verification scan (narrowed or not) applies the 10,000-row newest-first
        budget in one ordered single-pass statement and reports when the budget
        truncates results (D-035).
      - Unit tests for the compiler and the verification path: mixed quoted/unquoted
        input, punctuation-only quotes, case folding, mid-word substring hits,
        hostile bodies (existing D-030 sentinel rules still hold).
- [x] Active-search thread list: Threads pane filters to conversations with hits,
      ordered by most-recent hit, with per-thread hit-count badges. New/extended
      db-worker query in `src/workers/db/queries.ts` (no SQL from React, bounded and
      paginated like existing queries).
- [x] Search-results column to the right of Threads: newest → oldest with snippet
      segments, load-more pagination. No thread selected → all results; thread
      selected → only that thread's results (reuse the `conversationId` filter), with
      an "All" affordance in the column header to unselect the thread.
- [x] Clicking a result opens that conversation's timeline scrolled to the message
      (existing jump-to-context path, without leaving the workspace).
- [x] Details pane becomes on-demand: collapsed/hidden until a message is selected,
      dismissible, in both browse and search modes.
- [x] Layout/responsive pass: define the four-pane arrangement (Threads | Results |
      Timeline | Detail-on-demand) with Design.md tokens only; keep the below-floor
      overlay behavior; extend Design.md §7 with the new patterns rather than
      improvising (hard rule 11).
- [x] Remove the standalone `/backup/:id/search` route once parity lands; update
      navigation and any deep links.
- [x] e2e coverage: run search → filtered threads with counts → results column
      scoping via thread select/"All" → result click scrolls timeline → details
      on-demand → reset restores plain browse. Update `e2e/m3.spec.ts` expectations
      that assume the standalone search page.
- [x] Unnamed group identity: keep `chat.display_name` only when the source explicitly
      names a group, retain normalized contact first names, and render every non-self
      participant as a natural first-name/name/handle list. Bump `derivedDbVersion` to
      2 so cached first-participant group titles require re-ingest (D-036).
- [x] Replace the paired native search date inputs with one optional date-range
      control: React DayPicker range selection inside a Radix popover, two visible
      months, month/year dropdown navigation, same-day support, staged apply/cancel,
      explicit clear, accessible status text, and Lode-token styling in both themes
      (D-037). Playwright covers both themes' native select/option palettes and WCAG AA
      calendar contrast as well as Escape/focus return, incomplete-range validation,
      apply, clear, and the runtime 2007–current-year dropdown bounds at the 1024px
      floor.

## M5 — Encrypted backups

Goal: encrypted backups work end-to-end with password prompt.

- [x] Keybag TLV parser; PBKDF2 derivation (WebCrypto) with truthful stage progress;
      retryable wrong-password UX before the derived-data mutation boundary.
- [x] AES-KW class-key unwrap; raw/page-bounded Manifest.db decryption; bounded
      chunk decryption for per-file source reads with MBFile size truncation.
- [x] Provider-neutral encrypted ingest path: decrypt Manifest.db, sms/contact/contact-
      image databases, WAL sidecars, avatars, and eager attachment hashes before the
      existing SQLite recovery/normalization pipeline.
- [x] Session-only key handling verified: password fields clear immediately, storage
      carries no password/key material, worker lock/termination destroys mutable class
      keys, explicit attachment lock drains old reads and restores the password form,
      decrypted database/media-preview persistence is disclosed, and remove retains
      its OPFS derived-data wipe.
- [x] Deterministic encrypted fixture + tests: independent keybag/KDF/AES vectors,
      wrong-password/no-prepare and happy-path unit coverage, plus Playwright ingest ->
      fresh route unlock -> decrypted attachment preview.

## M5.5 — Streaming source decryption & import

Goal: decrypted source bytes no longer need to fit in RAM. Databases and attachments
stream from ciphertext to a transient OPFS file (or caller stream) in bounded chunks,
lifting the D-039 in-memory budgets (1 GiB per source set, 512 MiB encrypted
Manifest) and the sqlite-wasm 2 GiB heap ceiling as the size limit for real backups.

Context for the implementer: AES-CBC decryption is already chunked
(`decryptAes256CbcBlobChunks` in `src/workers/backup/crypto/aes-cbc.ts` reads 4 MiB
Blob slices, chains IVs, yields borrowed plaintext chunks). What is RAM-bound today
is only the plaintext *destination*: (1) source databases are assembled in one
buffer because WAL reconstruction does random-access writes and
`sqlite3_js_posix_create_file` copies the whole array into the wasm heap
(`src/workers/backup/source-sqlite.ts`); (2) `readSourceFile` returns a
`Uint8Array` over Comlink; (3) SHA-256 hashing is one-shot because WebCrypto has no
incremental digest. Read docs/Decisions.md D-038/D-039 and AGENTS.md (M5 bullet)
before starting; hard rules 1-4 and D-008 (no COOP/COEP, therefore no
SharedArrayBuffer and no sqlite "opfs" VFS — it requires cross-origin isolation)
are binding constraints.

- [x] **Incremental SHA-256.** Add a small, dependency-free incremental SHA-256
      (pure TS in `src/workers/shared/`, NIST/FIPS 180-4 test vectors) so plaintext
      and opt-in ciphertext hashes can be folded chunk-by-chunk during streaming.
      This is a scoped exception to the "crypto is WebCrypto only" rule (D-038):
      hashing here is integrity provenance, not key material. Record the decision
      (D-041); keep one-shot WebCrypto digests for small in-memory paths if simpler.
- [x] **Transient plaintext staging in OPFS.** A per-backup staging area under the
      existing derived-data directory (`golemine/backups/<id>/transient/` via
      `src/workers/shared/opfs.ts` helpers) written with
      `FileSystemSyncAccessHandle` from the backup worker. Lifecycle guarantees:
      files are deleted on close/finally; explicit lock (`resetBackupSourceCaches`)
      and session eviction also delete them; a sweep on next open/ingest removes
      leftovers from crashes; Remove backup already wipes the parent directory.
      Keep the existing zeroize discipline for in-memory chunk buffers; on-disk
      plaintext is covered by the existing derived-data persistence disclosure
      (extend the copy only if wording no longer holds).
- [x] **Streaming SQLite open seam.** Replace the heap-VFS copy for TRANSIENT
      source databases with an OPFS-backed read path. Decision to record (D-041):
      first check whether the installed `@sqlite.org/sqlite-wasm` `opfs-sahpool`
      `importDb()` accepts chunked/callback input in our pinned version — if yes,
      stream into a dedicated transient sahpool (separate from the derived-DB pool;
      respect the D-024 capacity notes and D-029 route-scoped pool ownership). If
      not, register a minimal custom read-only VFS backed by a
      `FileSystemSyncAccessHandle` (xOpen/xRead/xFileSize/xClose only; sync access
      handles are synchronous in workers, so no SAB is needed). Keep
      `openSourceSqliteDatabase`'s API shape so manifest-db/ios-ingest callers are
      mostly unchanged; keep the D-025 rollback-journal header forcing and D-021/
      D-022 WAL semantics.
- [x] **Streaming WAL application.** Apply committed WAL frames by random-access
      writes against the staged OPFS main-db file instead of growing an in-memory
      copy (`applySqliteWal` currently materializes both). The frame-scan
      validation logic (checksums, salts, committed-prefix stop) is unchanged —
      only the write target moves. Unencrypted ingest streams a plain copy of the
      source bytes to staging (no decrypt) so both paths converge on one seam.
- [x] **Manifest.db through the same path.** Encrypted Manifest decrypts
      chunk-to-staging and opens via the streaming seam (removes the 512 MiB cap
      and the transient wasm-heap copy). Unencrypted root Manifest.db/WAL/SHM use
      the same staged copy + WAL application, retiring the legacy 1 GiB per-file
      coexisting-buffer risk tracked since M5.
- [x] **Byte-free read RPC.** Extend `BackupWorkerApi.readSourceFile` (or add a
      sibling) to return a `Blob`/`File` backed by the staged OPFS file instead of
      a transferred `Uint8Array`; Blobs structured-clone without copying payload.
      Media-worker previews accept the Blob directly (`createImageBitmap(blob)`);
      user extraction pipes decrypt chunks straight into a `showSaveFilePicker`
      writable stream, removing the 1 GiB extraction materialization (D-031).
      Verify expected-plaintext-hash checks still run (incremental hasher) before
      the response resolves. Keep the `Uint8Array` path for small reads if a
      threshold fast path is simpler (suggest: at or below the current
      `defaultMaxReadBytes` stays in memory).
- [x] **Budgets become disk-aware sanity bounds.** Replace the D-039 in-memory
      budgets with per-file sanity checks that stay pre-prepare
      (`assertRequiredSourceDatabaseSetWithinBudget` keeps its call site and its
      before-destruction guarantee — check remaining OPFS quota via
      `navigator.storage.estimate()` plus a generous absolute bound instead of the
      1 GiB RAM budget; reserve the three-copy decrypt/reconstruct/import peak).
      Keep all existing hostile-input checks: declared
      plaintext vs stored size, block alignment, `maxReadBytes` request caps.
      Update D-039 with a successor note, AGENTS.md M5 bullet, Architecture §
      ingest text, and README's limit paragraph.
- [x] **Abort/lock semantics.** Streaming reads register in the encrypted
      session's tracked-read set for their full duration (decrypt + stage +
      respond) so lock still drains before the Manifest reader closes; abort
      deletes the partial staging file. The messages route's lock-fallback
      (worker termination) must not leave staging files behind — the
      sweep-on-next-open covers the termination case.
- [x] **Tests.** Unit: incremental-hasher vectors; streaming seam with the
      existing fixture databases (byte-identical query results vs the in-memory
      path); WAL-on-staging application against the WAL fixtures; staging
      lifecycle (delete-on-close, sweep-on-open, lock deletes). Fixture ingest and
      `e2e/m5.spec.ts` must pass unchanged; add an e2e assertion that a preview
      works after ingest with the streaming path active and that Remove backup
      leaves no `transient/` residue. A failed extraction must also preserve a
      pre-existing save-picker destination.
- [x] **Docs.** D-041 (streaming import + VFS choice + incremental-digest
      exception), Architecture pipeline section, AGENTS.md rules for the staging
      lifecycle, Plan status line.
- [x] Post-review hardening pass: one decrypt streamer
      (`decryptSourceFileToDestination`) behind every plaintext destination, with
      encrypted database mains decrypt-streaming straight into the source-sqlite
      workspace; one WAL pipeline (in-memory inputs adapt via
      `MemoryRandomAccessFile`) with single-pass frame-aligned chunked replay, a
      64 MiB pending-transaction buffer, a bounded-memory two-phase fallback, and
      checkpoint-tolerant commit validation (final-commit structural bound +
      4 TiB hostility cap + own-commit page skipping, D-042); single-pass opt-in
      ciphertext hashing via the CBC ciphertext-chunk tee, a native SHA-256 fast
      path for small un-teed Blobs, and Manifest staging hashed during the write
      with a 16-byte hold-back; plaintext-bound encrypted read caps with a
      +16-byte stored-ciphertext tolerance; zero-byte root Manifest sidecars
      tolerated; optional contact sets budget-bounded before any decrypt/staging
      I/O with post-finalize cleanup failures downgraded to a report warning;
      encrypted ingest always ends by locking its session, eviction is
      best-effort while the explicit lock RPC propagates, and previews decrypt in
      memory (D-043); extraction gains an explicit post-`close()` commit point;
      test seams consolidated into the one `setBackupSourceOverridesForTests`
      registry; e2e now asserts `transient/` is empty immediately after an
      encrypted overview ingest.

Definition of done for review: no full-file plaintext `Uint8Array` for databases or
large attachments anywhere in the worker path (grep for `new Uint8Array(plaintextSize)`
class allocations); prepare-boundary and wrong-password guarantees unchanged; D-008
still holds (no COOP/COEP); staging cannot outlive lock/remove except across a crash,
where the next open sweeps it; all suites green including the license audit if any
dependency was added (prefer none).

## M6 — Reports & export

Goal: court-exhibit-grade report from selected messages.

- [x] Selection model: add/remove messages to a report from timeline + search results; multiple named reports per backup.
- [x] Report builder page: ordered items, per-item notes, case metadata form (title, matter, preparer).
- [x] Print rendering per Design.md §9: paginated print CSS, message bubbles with full timestamps + participants, attachment images embedded, page headers/footers (report title, page N of M, timezone label), no split bubbles across pages.
- [x] Transcript-first print refinement: mirror Messages workspace alignment, service
      colors, attachment placement, reactions/status, and displayed timestamps for the
      selected messages; number transcript messages in the outside gutter and move
      report notes plus per-message/attachment/reaction metadata to a cross-referenced
      section beginning on a new page after the transcript.
- [x] Provenance appendix per Architecture §8 (SHA-256 of source sms.db + report attachments, device/backup identity, tool version, methodology note).
- [x] Timezone selection for the report, labeled on every page.
- [x] Export via Chrome print-to-PDF; e2e test asserts print view content.
- [x] Report durability hardening: same-schema rebuilds retain reports/notes and
      remove only selections for messages absent from the rebuilt source; version
      migrations, backup replacement, and Remove backup continue to wipe report state.
- [x] M6 review fixes (D-045): dedicated `/backup/:id/reports` list route with the
      overview Reports tile pointing at it; recents reads present stale
      `derivedDbVersion` records as `needs-reingest`; explicit transactional report
      deletes plus factory-level `PRAGMA foreign_keys = ON`; `@page` header/footer
      variables stamped on the root element; picker add-path `maxReportItems` cap and
      sparse-position removals (no renumbering); lenient skip-and-degrade report list
      reads; batch report item hydration; typed factory errors preserved by report
      RPCs; post-read session lock on every unlocked print-preparation path; shared
      `sqlite-helpers`/`report-limits`/`dialog-shell`/db test-support modules.

## M7 — Polish & hardening

- [x] Wire generated illustrations into the UI (landing, capability-gate block screen,
      drag-drop overlay, backup guides) from `src/assets/illustrations/`, with
      light/dark variants swapped per theme and decorative `alt=""` (Design.md §12).
      Review hardening precaches all WebPs for offline use, avoids eager hidden-theme
      downloads, keeps the drag artwork mounted before first hover, collapses fixed
      illustration tracks in print, centralizes illustrated layouts, and tests both
      themes under system/manual overrides.
- [ ] Derive final favicon (retraced SVG) and PWA manifest icons (192/512/maskable)
      from `src/assets/brand/icon-master.png`; keep favicon.svg and manifest in sync.
- [x] Social/OG meta tags in `index.html` pointing at
      `https://golemine.com/og-image.png` (1200×630, lives in `public/`).
- [x] README banner (`docs/assets/readme-banner.png`) embedded at the top of README.
- [ ] Offline audit: zero network requests after install (test-enforced).
- [ ] Malformed-backup fuzz fixtures: ingest never crashes, always reports what was skipped.
- [ ] Storage management UI: per-backup derived-data size, clear/rebuild.
- [ ] Accessibility + keyboard navigation pass; empty/error states everywhere.
- [ ] Landing + guide content finalized; README user docs.

## Later / backlog (not scheduled)

- Android provider (format decision: Decisions.md D-007).
- More iOS data types: call history, voicemail, photos library, notes, WhatsApp.
- Direct programmatic PDF export (pdf-lib) for byte-reproducible reports.
- Deleted-message recovery from SQLite free pages (forensic feature; needs careful UX).
- Report export as standalone HTML archive; CSV/JSON data export.
- Chain-of-custody extras: full-backup hash manifest at import, action audit log.
- Multi-backup cross-search.
- Unify the remaining encrypted/unencrypted source-access assembly (per-call-site
  `readRecord` lambdas + manifest-ownership flags in attachment-read/ios-ingest, and
  the split manifest-cache vs encrypted-session state) behind one `openBackupSource()`
  seam. Lock/teardown already goes through the single `resetBackupSourceCaches()`
  helper; the full seam is deferred until the next consumer (report export or
  streaming extraction) needs it.
- Make the attachment-read final stale-session guard structural (finalize callback
  executed inside the tracked session read) instead of the current comment-enforced
  "no await between assertActive and returning plaintext" rule; the session already
  re-validates and zeroizes internally, so the residual window is only the caller's
  post-read progress awaits.
- ~~Streaming source-SQLite import/decryption; unencrypted root Manifest aggregate/
  streaming recovery.~~ Promoted to the scheduled M5.5 milestone above.

## Open questions

- OQ-1: ~~Exact shadcn/ui vs. hand-rolled component split for the three-pane messages
  UI.~~ Resolved — see Decisions.md D-014.
- OQ-2: ~~Whether `AddressBookImages` contact avatars are worth surfacing in v1.~~
  Resolved — yes, thumbnails only, as a progressive enhancement; see Decisions.md
  D-015.
