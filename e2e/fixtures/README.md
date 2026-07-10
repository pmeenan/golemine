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
- `generated/ios-mini-encrypted-backup/00008030-001C195E0A88805E/` — encrypted M5
  counterpart built from the same synthetic databases and attachment. Its root
  `Manifest.db` and every MBFile payload are AES-256-CBC ciphertext with zero IVs
  and PKCS#7 padding; source plaintext is truncated to the archived MBFile `Size`.
  Each encrypted MBFile uses the real NSKeyedArchiver indirection from `$top.root`
  through `$objects`, with `EncryptionKey` referencing a `NSMutableData` object's
  `NS.data`. The deterministic keybag has two passcode-wrapped class records and uses
  the modern two-stage PBKDF2 scheme plus RFC 3394 AES-KW for class, manifest, and
  per-file keys. Default fixture runs use the real ~10,000 SHA-1 count but an
  accelerated 100,000-round SHA-256 stage; an exported 10,000,000-round slow vector
  is testable on demand with `GOLEMINE_RUN_SLOW_KDF=1`. Generator self-checks unwrap,
  decrypt, padding, and byte equality before files are written; focused parser and
  encrypted-ingest tests validate the archived metadata indirection.
