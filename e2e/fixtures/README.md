# Synthetic fixture convention

Fixtures in this directory must be synthetic. Do not copy, anonymize, trim, or derive
fixtures from real personal backups.

Each fixture must include:

- A metadata entry in `fixtures.json`.
- A deterministic generator in or called by `generate-fixtures.mjs`.
- A short description of the fake device, fake contacts, and fake data scenario.
- Enough provenance notes for reviewers to inspect how the fixture was produced.

Generated fixture outputs should live under `generated/<fixture-id>/`. Keep source
fixture material small and reviewable; large generated blobs should have a documented
reason before they are added.

Current generated fixtures:

- `generated/ios-mini-backup/00008030-001C195E0A88802E/` — synthetic unencrypted
  iPhone Finder/iTunes backup root for M1 open/detection flows and M2 ingest
  fixtures. It contains real generated Manifest/sms/contact SQLite databases with
  synthetic messages, contacts, one attachment, real sms/contact WAL sidecars, a
  WAL-only message/contact, one tapback reaction, a prefixed valid contact thumbnail,
  and one malformed avatar blob for skip-and-report coverage.
