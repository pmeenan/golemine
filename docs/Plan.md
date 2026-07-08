# Golemine Plan

Phased build order. Each milestone ends in a working, demonstrable state. Update the
status column as work lands; add discovered work as tasks under the relevant milestone
rather than inventing new documents.

**Current status: M2 complete and post-review hardened — users can open an unencrypted
synthetic iPhone backup, run ingest from the backup overview, and rebuild a per-backup
OPFS derived database with normalized conversations, participants, messages,
attachments, tapbacks, contact avatars, FTS rows, warnings, and source-file
provenance. The fixture now carries real Manifest/sms/contact SQLite data plus WAL
sidecars, and Playwright covers open -> ingest -> derived summary. M2 hardening now
uses SQLite-like WAL end-of-log handling for stale/torn WAL tails including root
`Manifest.db-wal`, avoids eager hashing of large, unknown-size, deceptive-size, or
budget-exhausted attachment media, preserves attachment GUIDs and reaction raw
timestamps, sends production ingest batches backup-worker -> db-worker without a UI
relay, and recovers interrupted `ingesting` recents as `needs-reingest` (D-022).
Encrypted ingest is next in M4; M3 builds the browser/search UI over the derived
database. M1 also handles larger real-world iOS `Info.plist` app metadata with
role-specific root-plist bounds (D-019), and all primary brand and illustration assets
have been generated under the steampunk Talos golem identity (D-018; character sheet
in `docs/assets/`); wiring them into the UI is tracked under M6.**

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

Deferred (not M2): streaming row normalization — normalize currently materializes
full row arrays before batching; a streaming rewrite is deferred to M3-scale work.

## M3 — Browse & search

Goal: the core exploration experience.

- [ ] Thread list pane (virtualized, recency-sorted, unresolved handles shown raw).
- [ ] Message timeline (virtualized bubbles per Design.md §7.1: sender runs, day separators, system events, reactions badged, edited/unsent indicators, jump-to-date).
- [ ] Message detail panel: full metadata incl. provenance fields (GUID, rowid, raw timestamp).
- [ ] Attachment rendering: native images inline; HEIC via libheif in media-worker; video via `<video>` (HEVC where hardware allows) with poster-frame fallback; generic file card + "extract original" (save via File System Access API) for everything else.
- [ ] Thumbnail cache in OPFS (content-addressed).
- [ ] FTS5 full-text search + filters (conversation, participant, date range, has-attachment); snippets; jump-to-context in thread.
- [ ] Performance check: 100k+ message backup stays at 60 fps scrolling, search < 200 ms.

## M4 — Encrypted backups

Goal: encrypted backups work end-to-end with password prompt.

- [ ] Keybag TLV parser; PBKDF2 derivation (WebCrypto) with progress UI; wrong-password UX.
- [ ] AES-KW class-key unwrap; Manifest.db decryption; per-file decrypt streaming in `readAttachment`.
- [ ] Ingest path for encrypted backups (decrypt sms.db/contacts on the fly).
- [ ] Session-only key handling verified (nothing persisted); "derived data contains decrypted content" disclosure + wipe-on-remove.
- [ ] Encrypted fixture backup + tests (unit vectors for keybag/KDF, e2e happy path + wrong password).

## M5 — Reports & export

Goal: court-exhibit-grade report from selected messages.

- [ ] Selection model: add/remove messages to a report from timeline + search results; multiple named reports per backup.
- [ ] Report builder page: ordered items, per-item notes, case metadata form (title, matter, preparer).
- [ ] Print rendering per Design.md §9: paginated print CSS, message bubbles with full timestamps + participants, attachment images embedded, page headers/footers (report title, page N of M, timezone label), no split bubbles across pages.
- [ ] Provenance appendix per Architecture §8 (SHA-256 of source sms.db + report attachments, device/backup identity, tool version, methodology note).
- [ ] Timezone selection for the report, labeled on every page.
- [ ] Export via Chrome print-to-PDF; e2e test asserts print view content.

## M6 — Polish & hardening

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
