import { describe, expect, it } from "vitest";

import {
  iosMiniEncryptedBackupCryptoVectors,
  iosMiniEncryptedBackupPassword,
} from "../../../../e2e/fixtures/ios-mini-backup.mjs";
import { derivePasscodeKey } from "./kdf";

describe("encrypted fixture KDF vectors", () => {
  it("matches the CI-sized two-stage fixture vector", async () => {
    const vectors = iosMiniEncryptedBackupCryptoVectors;
    const passcodeKey = await derivePasscodeKey(
      iosMiniEncryptedBackupPassword,
      {
        doubleProtectionIterations:
          vectors.keybag.doubleProtectionIterations,
        doubleProtectionSalt: hex(vectors.keybag.doubleProtectionSaltHex),
        iterations: vectors.keybag.iterations,
        salt: hex(vectors.keybag.saltHex),
      },
    );

    expect(toHex(passcodeKey)).toBe(vectors.passcodeKeyHex);
  });

  it.skipIf(process.env.GOLEMINE_RUN_SLOW_KDF !== "1")(
    "matches the production-sized 10,000,000-round vector",
    async () => {
      const vectors = iosMiniEncryptedBackupCryptoVectors;
      const passcodeKey = await derivePasscodeKey(
        iosMiniEncryptedBackupPassword,
        {
          doubleProtectionIterations:
            vectors.realisticKdf.doubleProtectionIterations,
          doubleProtectionSalt: hex(vectors.keybag.doubleProtectionSaltHex),
          iterations: vectors.realisticKdf.iterations,
          salt: hex(vectors.keybag.saltHex),
        },
      );

      expect(toHex(passcodeKey)).toBe(vectors.realisticKdf.passcodeKeyHex);
    },
  );
});

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
