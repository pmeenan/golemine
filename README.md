# Golemine

Browser-based tool for exploring, searching, and extracting data from phone backups —
starting with iPhone (iTunes/Finder) backups and their Messages data.

The name is **Golem + Mine**: a mechanical golem/automaton that mines through the
data in a backup and extracts the interesting bits.

Everything runs locally in your browser. **Your backup data never leaves your
machine** — there is no server, no upload, no telemetry, and the app works fully
offline after the first load.

## What it does (goals)

- Open an iPhone backup folder (drag & drop or file picker) — encrypted backups
  supported with your backup password (decrypted locally, in your browser).
- Browse message threads with attachments (photos incl. HEIC, videos, files) in a
  fast, responsive UI.
- Full-text search across all messages with filters (person, thread, date range).
- Select messages into a report and export a print-ready, court-exhibit-grade PDF
  including forensic provenance (file hashes, device identity, message GUIDs,
  explicit timezones).
- Keep a "recent backups" list with friendly names for quick re-opening.
- Android backup support is planned (see `docs/Decisions.md` D-007).

## Requirements

- Google Chrome (latest stable). The app is intentionally Chrome-only — it relies on
  the File System Access API and the Origin Private File System.
- Static hosting under your control. No server application is required; all app code
  and wasm/font assets are served same-origin and cached for offline use.

## Status

Early development — architecture and plan are defined; implementation has not started.
M0 will scaffold the offline PWA, worker boundaries, tests, CI checks, license audit,
and privacy/offline guardrails.
See [docs/Plan.md](docs/Plan.md) for the current milestone status.

## Documentation

- [docs/Architecture.md](docs/Architecture.md) — system design
- [docs/Design.md](docs/Design.md) — design system (theming, tokens, component rules)
- [docs/Plan.md](docs/Plan.md) — milestones and status
- [docs/iOS-Backup-Format.md](docs/iOS-Backup-Format.md) — iOS backup format reference
- [docs/Decisions.md](docs/Decisions.md) — decision log
- [AGENTS.md](AGENTS.md) — project rules for AI agents / contributors

## License

Apache-2.0. Dependencies are permissively licensed; LGPL is permitted only for
unmodified, dynamically-loaded wasm codec modules (see AGENTS.md licensing rules).
