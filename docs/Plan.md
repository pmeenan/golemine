# Golemine Plan

Phased build order. Each milestone ends in a working, demonstrable state. Update the
status column as work lands; add discovered work as tasks under the relevant milestone
rather than inventing new documents.

**Current status: M3 implemented for unencrypted iPhone backups — users can open and
ingest a synthetic iPhone backup, then browse conversations, inspect a virtualized
message timeline, view message provenance, search FTS-backed messages with filters and
snippets, jump from search results into thread context, preview/extract source-backed
attachments, load additional conversation/timeline/search pages beyond the first
window, and cache native image thumbnails in OPFS. The fixture carries real
Manifest/sms/contact SQLite data plus WAL sidecars, and Playwright covers open ->
ingest -> messages/search. M2 hardening remains in place: SQLite-like WAL end-of-log
handling for stale/torn WAL tails including root `Manifest.db-wal`, deferred hashing
for large/unknown/deceptive/budget-exhausted attachment media, preserved attachment
GUIDs and reaction raw timestamps, direct backup-worker -> db-worker ingest streaming,
interrupted `ingesting` recents recovery, larger per-backup sqlite-wasm SAH pools
(D-024), and rollback-journal header forcing for transient source SQLite opens
(D-025). M3 HEIC thumbnails use isolated same-origin `libheif-js` vendor files loaded
lazily by `media-worker` (production direct module import; Vite dev fetch-to-Blob
module shim so public vendor files are not transformed), prefer embedded HEIF
thumbnails when available, and fall back to full-image decode only inside the
media-worker's 256 MiB RGBA-surface cap; thumbnail generation is serialized so only
one decode can hold full-size working surfaces at a time (D-026/D-027/D-033). The
messages UI has had its post-review Design.md §7/§8 pass for avatar colors/sizing,
sent-bubble foreground tokens, timestamp affordances, attachment frame caps, and
below-floor detail overlay behavior, plus a follow-up M3 fix pass: consolidated
shared worker helper modules, snippet-sentinel search hardening (D-030), a
messages-only timeline load-more query, route-scoped browse/search workers with
SAH-pool install retry (D-029), a 1 GiB user-initiated extraction budget (D-031),
and normalized `serviceKind` bubble styling (D-032). Next is M4 — folding search
into the messages UI as one unified browse/search workspace (D-034); encrypted
ingest follows in M5.**

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

- [ ] Search panel above the Threads/timeline workspace: the standalone search page's
      fields minus the conversation selector (search always spans all conversations),
      with explicit run and reset controls. Reset returns the workspace to plain
      browse mode.
- [ ] Search semantics rework in db-worker (`compileUserTextToFtsExpression` +
      `searchMessages`), per D-034:
      - Case-insensitive throughout (FTS5 unicode61 folding for word terms; explicit
        case folding for substring verification).
      - Unquoted space-separated words: implicit AND, any order, anywhere in the
        message, each word matched as an FTS5 prefix (`word*`).
      - Quoted strings: true case-insensitive substring match — compile the quoted
        text's indexable tokens to an FTS narrowing query, then verify the raw
        substring against candidate bodies in the db-worker. Quoted strings with no
        indexable tokens (punctuation/emoji only) use a bounded non-FTS scan with a
        documented row budget; report when the budget truncates results.
      - Unit tests for the compiler and the verification path: mixed quoted/unquoted
        input, punctuation-only quotes, case folding, mid-word substring hits,
        hostile bodies (existing D-030 sentinel rules still hold).
- [ ] Active-search thread list: Threads pane filters to conversations with hits,
      ordered by most-recent hit, with per-thread hit-count badges. New/extended
      db-worker query in `src/workers/db/queries.ts` (no SQL from React, bounded and
      paginated like existing queries).
- [ ] Search-results column to the right of Threads: newest → oldest with snippet
      segments, load-more pagination. No thread selected → all results; thread
      selected → only that thread's results (reuse the `conversationId` filter), with
      an "All" affordance in the column header to unselect the thread.
- [ ] Clicking a result opens that conversation's timeline scrolled to the message
      (existing jump-to-context path, without leaving the workspace).
- [ ] Details pane becomes on-demand: collapsed/hidden until a message is selected,
      dismissible, in both browse and search modes.
- [ ] Layout/responsive pass: define the four-pane arrangement (Threads | Results |
      Timeline | Detail-on-demand) with Design.md tokens only; keep the below-floor
      overlay behavior; extend Design.md §7 with the new patterns rather than
      improvising (hard rule 11).
- [ ] Remove the standalone `/backup/:id/search` route once parity lands; update
      navigation and any deep links.
- [ ] e2e coverage: run search → filtered threads with counts → results column
      scoping via thread select/"All" → result click scrolls timeline → details
      on-demand → reset restores plain browse. Update `e2e/m3.spec.ts` expectations
      that assume the standalone search page.

## M5 — Encrypted backups

Goal: encrypted backups work end-to-end with password prompt.

- [ ] Keybag TLV parser; PBKDF2 derivation (WebCrypto) with progress UI; wrong-password UX.
- [ ] AES-KW class-key unwrap; Manifest.db decryption; per-file decrypt streaming in `readAttachment`.
- [ ] Ingest path for encrypted backups (decrypt sms.db/contacts on the fly).
- [ ] Session-only key handling verified (nothing persisted); "derived data contains decrypted content" disclosure + wipe-on-remove.
- [ ] Encrypted fixture backup + tests (unit vectors for keybag/KDF, e2e happy path + wrong password).

## M6 — Reports & export

Goal: court-exhibit-grade report from selected messages.

- [ ] Selection model: add/remove messages to a report from timeline + search results; multiple named reports per backup.
- [ ] Report builder page: ordered items, per-item notes, case metadata form (title, matter, preparer).
- [ ] Print rendering per Design.md §9: paginated print CSS, message bubbles with full timestamps + participants, attachment images embedded, page headers/footers (report title, page N of M, timezone label), no split bubbles across pages.
- [ ] Provenance appendix per Architecture §8 (SHA-256 of source sms.db + report attachments, device/backup identity, tool version, methodology note).
- [ ] Timezone selection for the report, labeled on every page.
- [ ] Export via Chrome print-to-PDF; e2e test asserts print view content.

## M7 — Polish & hardening

- [ ] Wire generated illustrations into the UI (landing, capability-gate block screen,
      drag-drop overlay, backup guides) from `src/assets/illustrations/`, with
      light/dark variants swapped per theme and decorative `alt=""` (Design.md §12).
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

## Open questions

- OQ-1: ~~Exact shadcn/ui vs. hand-rolled component split for the three-pane messages
  UI.~~ Resolved — see Decisions.md D-014.
- OQ-2: ~~Whether `AddressBookImages` contact avatars are worth surfacing in v1.~~
  Resolved — yes, thumbnails only, as a progressive enhancement; see Decisions.md
  D-015.
