# Golemine Plan

Phased build order. Each milestone ends in a working, demonstrable state. Update the
status column as work lands; add discovered work as tasks under the relevant milestone
rather than inventing new documents.

**Current status: M1 complete — users can open a synthetic iPhone backup folder,
recognize it through the backup worker, see device metadata, and manage recents with
IndexedDB persistence plus OPFS derived-data wipe-on-remove. Detection also handles
larger real-world iOS `Info.plist` app metadata with role-specific root-plist bounds
(D-019), and the iPhone guide now covers copied backups, inline Finder steps, Apple
Support references, and macOS `~/Library` Chrome access limits. All primary brand and
illustration assets have been generated under the steampunk Talos golem identity
(D-018; character sheet in `docs/assets/`); wiring them into the UI is tracked under
M6.**

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

- [ ] Manifest.db reader (locate files by domain/relativePath, incl. WAL sidecar handling).
- [ ] Binary + XML plist parser (or vetted MIT dependency) for MBFile records.
- [ ] sms.db extraction: copy into db-worker memory/OPFS temp, apply WAL, open read-only.
- [ ] Normalizer: chats → Conversations, handles → Participants, messages (Apple-epoch conversion, `attributedBody` typedstream text extraction, tapback folding, group events), attachments metadata.
- [ ] Contacts resolution from AddressBook.sqlitedb (libphonenumber-js matching).
- [ ] Contact avatar thumbnails from AddressBookImages.sqlitedb (D-015): join on
      `record_id` = ABPerson rowid, sniff JPEG/PNG magic in blobs (offset may be
      non-zero), skip-and-report on any parse failure, missing db is a no-op; store
      content-addressed in OPFS alongside the M3 thumbnail cache.
- [ ] Derived DB schema + ingest sink in db-worker (Architecture §6), incl. `ingest_meta` provenance (source hashes, timestamps, counts).
- [ ] Streaming progress UI; ingest restartable; `derivedDbVersion` re-ingest trigger.
- [ ] Golden-file unit tests for typedstream, timestamps, tapbacks against fixtures.

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
