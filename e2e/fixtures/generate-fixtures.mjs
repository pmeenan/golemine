import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const metadataPath = path.join(fixturesDir, "fixtures.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

if (!metadata.policy?.syntheticOnly || !metadata.policy?.noRealPersonalData) {
  throw new Error("Fixture metadata must explicitly require synthetic-only, no-real-personal-data fixtures.");
}

console.log("No synthetic fixture generators are implemented yet.");
console.log("When fixtures are added, generate deterministic outputs under e2e/fixtures/generated/<fixture-id>/.");
