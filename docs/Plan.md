# Golemine Plan

Phased build order. Each milestone ends in a working, demonstrable state. Update the
status column as work lands; add discovered work as tasks under the relevant milestone
rather than inventing new documents.

**Current status: M0 not started — repo contains docs only.**

## M0 — Scaffolding

Goal: empty app that builds, tests, lints, installs as an offline PWA.

- [ ] Vite + React 19 + TypeScript (strict) scaffold, repo layout per Architecture §11.
- [ ] Tailwind + shadcn/ui setup; base app shell + react-router with placeholder routes.
- [ ] Design system foundation per Design.md: `tokens.css` (all light/dark OKLCH tokens,
      type scale, spacing, radii, shadows, motion), Tailwind/shadcn variable mapping,
      self-hosted Inter + JetBrains Mono (OFL, recorded in NOTICE).
- [ ] Theme switching: system/light/dark toggle, localStorage persistence, pre-paint
      inline script (no theme flash), `color-scheme` set; e2e test covers all three states.
- [ ] Worker plumbing: Comlink helper, one demo round-trip per worker (backup/db/media).
- [ ] sqlite-wasm running in db-worker with opfs-sahpool VFS; smoke test (create/query a DB in OPFS).
- [ ] Service worker via vite-plugin-pwa; verify full offline reload works.
- [ ] Vitest + Playwright (Chromium) wired up with one trivial test each; CI (GitHub Actions: lint, typecheck, unit, e2e).
- [ ] License audit script (fails CI on disallowed licenses; allowlist per AGENTS.md) + NOTICE file.

## M1 — Landing, backup opening, recents

Goal: user can open a backup folder, see it recognized, and manage a recents list.

- [ ] Landing page: what/why, privacy statement, drag-drop + `showDirectoryPicker()` entry points; hero uses the Lode brand gradient (Design.md §4).
- [ ] Backup detection in backup-worker: validate folder, parse `Info.plist` + `Manifest.plist`, detect encryption, surface device info. Clear errors for non-backup folders.
- [ ] Recents list in IndexedDB (handle persistence, `requestPermission()` re-grant flow, rename, remove — remove also wipes OPFS derived data).
- [ ] Backup overview page (`/backup/:id`): device info card, encrypted badge, ingest CTA.
- [ ] Info pages: how to back up an iPhone (Finder/iTunes, incl. why encrypted is OK) and Android (placeholder pointing at future support).
- [ ] Fixture mini-backup (synthetic) checked into `e2e/fixtures/`; e2e test for open → detect → recents.

## M2 — Ingest pipeline (unencrypted)

Goal: an opened, unencrypted backup becomes a browsable derived DB.

- [ ] Manifest.db reader (locate files by domain/relativePath, incl. WAL sidecar handling).
- [ ] Binary + XML plist parser (or vetted MIT dependency) for MBFile records.
- [ ] sms.db extraction: copy into db-worker memory/OPFS temp, apply WAL, open read-only.
- [ ] Normalizer: chats → Conversations, handles → Participants, messages (Apple-epoch conversion, `attributedBody` typedstream text extraction, tapback folding, group events), attachments metadata.
- [ ] Contacts resolution from AddressBook.sqlitedb (libphonenumber-js matching).
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

- OQ-1: Hosting target (GitHub Pages vs other static host) — matters only if we ever
  need COOP/COEP headers; currently avoided by design.
- OQ-2: Exact shadcn/ui vs. hand-rolled component split for the three-pane messages UI.
- OQ-3: Whether `AddressBookImages` contact avatars are worth surfacing in v1.
