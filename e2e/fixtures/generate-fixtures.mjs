import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  iosMiniBackupDevice,
  iosMiniBackupInfoPlist,
  iosMiniBackupUdid,
  plistDict,
} from "./ios-mini-backup.mjs";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const metadataPath = path.join(fixturesDir, "fixtures.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const generatedDir = path.join(fixturesDir, "generated");

if (!metadata.policy?.syntheticOnly || !metadata.policy?.noRealPersonalData) {
  throw new Error("Fixture metadata must explicitly require synthetic-only, no-real-personal-data fixtures.");
}

const iosMiniBackupId = "ios-mini-backup";

const generatedFixtures = [
  {
    id: iosMiniBackupId,
    root: path.join(generatedDir, iosMiniBackupId, iosMiniBackupUdid),
    // The descriptive device block fixtures.json must carry, sourced from the
    // shared module so the metadata cannot drift from the generated backup.
    device: {
      displayName: iosMiniBackupDevice.displayName,
      deviceName: iosMiniBackupDevice.deviceName,
      productType: iosMiniBackupDevice.productType,
      productVersion: iosMiniBackupDevice.productVersion,
      serialNumber: iosMiniBackupDevice.serialNumber,
      udid: iosMiniBackupDevice.udid,
      phoneNumber: iosMiniBackupDevice.phoneNumber,
    },
    files: [
      {
        relativePath: "Info.plist",
        content: iosMiniBackupInfoPlist(),
      },
      {
        relativePath: "Manifest.plist",
        content: plistDict(`
          <key>IsEncrypted</key>
          <false/>
          <key>Version</key>
          <string>10.0</string>
          <key>Date</key>
          <date>2026-07-01T12:35:10Z</date>
        `),
      },
      {
        relativePath: "Manifest.db",
        content: "SQLite format 3\u0000synthetic placeholder for M1 detection only.\n",
      },
      {
        relativePath: "Status.plist",
        content: plistDict(`
          <key>SnapshotState</key>
          <string>finished</string>
        `),
      },
      {
        relativePath: "3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28",
        content: "synthetic sms.db placeholder, not parsed in M1\n",
      },
    ],
  },
];

const metadataFixtureIds = new Set(metadata.fixtures?.map((fixture) => fixture.id));
const generatedFixtureIds = new Set(generatedFixtures.map((fixture) => fixture.id));

for (const id of metadataFixtureIds) {
  if (!generatedFixtureIds.has(id)) {
    throw new Error(
      `fixtures.json declares "${id}" but generate-fixtures.mjs has no generator for it.`,
    );
  }
}

for (const fixture of generatedFixtures) {
  if (!metadataFixtureIds.has(fixture.id)) {
    throw new Error(`Fixture metadata is missing an entry for ${fixture.id}.`);
  }

  const metadataEntry = metadata.fixtures.find((entry) => entry.id === fixture.id);

  for (const [key, expected] of Object.entries(fixture.device)) {
    const declared = metadataEntry.device?.[key];

    if (declared !== expected) {
      throw new Error(
        `fixtures.json device.${key} for "${fixture.id}" is ${JSON.stringify(declared)} but the shared module generates ${JSON.stringify(expected)}. Update fixtures.json to match ios-mini-backup.mjs.`,
      );
    }
  }

  const fixtureBase = path.join(generatedDir, fixture.id);

  await rm(fixtureBase, { force: true, recursive: true });

  for (const file of fixture.files) {
    const targetPath = path.join(fixture.root, file.relativePath);

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
  }

  console.log(`Generated ${fixture.id} at ${path.relative(fixturesDir, fixture.root)}.`);
}
