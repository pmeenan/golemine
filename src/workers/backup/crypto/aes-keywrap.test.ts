import { describe, expect, it } from "vitest";

import { iosMiniEncryptedBackupCryptoVectors } from "../../../../e2e/fixtures/ios-mini-backup.mjs";
import {
  unwrapAes256Key,
  unwrapClassKeys,
  unwrapClassWrappedKey,
} from "./index";

function hex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

describe("AES-KW key unwrapping", () => {
  const kek = hex(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  const plaintext = hex(
    "00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f",
  );
  const wrapped = hex(
    "28c9f404c4b810f4cbccB35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21",
  );

  it("matches the RFC 3394 256-bit KEK/256-bit key vector", async () => {
    await expect(unwrapAes256Key(kek, wrapped)).resolves.toEqual(plaintext);
  });

  it("classifies AES-KW integrity failures", async () => {
    const corrupted = wrapped.slice();
    corrupted[corrupted.byteLength - 1] ^= 0x01;
    await expect(unwrapAes256Key(kek, corrupted)).rejects.toMatchObject({
      code: "key-unwrap-failed",
    });
  });

  it("accepts passcode bitmask WRAP=3 and detects wrong passwords", async () => {
    const records = [
      {
        uuid: new Uint8Array(16),
        protectionClass: 4,
        wrapFlags: 3,
        keyType: 0,
        wrappedKey: wrapped,
      },
    ];
    const unwrapped = await unwrapClassKeys(records, kek);
    expect(unwrapped.classKeys.get(4)).toEqual(plaintext);
    expect(unwrapped.failedProtectionClasses).toEqual([]);

    const wrongKek = kek.slice();
    wrongKek[0] ^= 0xff;
    await expect(unwrapClassKeys(records, wrongKek)).rejects.toMatchObject({
      code: "wrong-password",
    });
  });

  it("skips and reports a corrupt sibling class key instead of failing the unlock", async () => {
    const corrupted = wrapped.slice();
    corrupted[corrupted.byteLength - 1] ^= 0x01;
    const records = [
      {
        uuid: new Uint8Array(16),
        protectionClass: 4,
        wrapFlags: 3,
        keyType: 0,
        wrappedKey: wrapped,
      },
      {
        uuid: new Uint8Array(16),
        protectionClass: 2,
        wrapFlags: 3,
        keyType: 0,
        wrappedKey: corrupted,
      },
    ];

    const unwrapped = await unwrapClassKeys(records, kek);
    expect(unwrapped.classKeys.get(4)).toEqual(plaintext);
    expect(unwrapped.classKeys.has(2)).toBe(false);
    expect(unwrapped.failedProtectionClasses).toEqual([2]);
  });

  it("matches the encrypted mini-backup's independent static vectors", async () => {
    // The fixture generator self-checks these shared constants using Node's
    // independent crypto primitives before writing the encrypted backup.
    const vectors = iosMiniEncryptedBackupCryptoVectors;
    const passcodeKey = hex(vectors.passcodeKeyHex);
    const classKey = await unwrapAes256Key(
      passcodeKey,
      hex(vectors.classKey.wrappedKeyHex),
    );
    expect(classKey).toEqual(hex(vectors.classKey.keyHex));

    const manifestKeyBlob = new Uint8Array(44);
    new DataView(manifestKeyBlob.buffer).setUint32(
      0,
      vectors.protectionClass,
      true,
    );
    manifestKeyBlob.set(hex(vectors.manifestKey.wrappedKeyHex), 4);
    await expect(
      unwrapClassWrappedKey(
        new Map([[vectors.protectionClass, classKey]]),
        manifestKeyBlob,
      ),
    ).resolves.toEqual(hex(vectors.manifestKey.keyHex));
  });
});
