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

The generator stub currently records the convention only. Add real generators when M1
or parser milestones introduce the first synthetic backup.
