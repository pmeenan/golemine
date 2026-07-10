import { describe, expect, it } from "vitest";

import {
  unlockBackupKeybag,
  type UnlockedBackupKeybag,
} from "./index";

function hex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function tlv(tag: string, value: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + value.byteLength);
  for (let index = 0; index < tag.length; index += 1) {
    bytes[index] = tag.charCodeAt(index);
  }
  new DataView(bytes.buffer).setUint32(4, value.byteLength, false);
  bytes.set(value, 8);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function fixtureKeybag(): Uint8Array {
  return join(
    tlv("VERS", u32(3)),
    tlv("TYPE", u32(1)),
    tlv("UUID", new Uint8Array(16).fill(0xaa)),
    tlv("WRAP", u32(2)),
    tlv("SALT", hex("f0e1d2c3b4a5968778695a4b3c2d1e0f00112233")),
    tlv("ITER", u32(2048)),
    tlv(
      "DPSL",
      hex(
        "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f",
      ),
    ),
    tlv("DPIC", u32(4096)),
    tlv("UUID", new Uint8Array(16).fill(0x44)),
    tlv("CLAS", u32(4)),
    tlv("WRAP", u32(2)),
    tlv("KTYP", u32(0)),
    tlv(
      "WPKY",
      hex(
        "877f0aff5209642ce5bdb00bfa3f67da28f8e307ac7beaf4b46d73f8b873ba82d80f78255f104a40",
      ),
    ),
  );
}

function wrappedBlob(wrappedHex: string): Uint8Array {
  const bytes = new Uint8Array(44);
  new DataView(bytes.buffer).setUint32(0, 4, true);
  bytes.set(hex(wrappedHex), 4);
  return bytes;
}

async function encryptRawBlocks(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const padded = await encryptPkcs7(plaintext, keyBytes);
  return padded.slice(0, -16);
}

async function encryptPkcs7(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const keyCopy = keyBytes.slice();
  const plaintextCopy = plaintext.slice();
  const key = await crypto.subtle.importKey(
    "raw",
    keyCopy,
    "AES-CBC",
    false,
    ["encrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: new Uint8Array(16) },
      key,
      plaintextCopy,
    ),
  );
}

async function collectFileChunks(
  session: UnlockedBackupKeybag,
  encrypted: Uint8Array<ArrayBuffer>,
  encryptionKeyBlob: Uint8Array,
  plaintextSize: number,
): Promise<Uint8Array> {
  const result = new Uint8Array(plaintextSize);
  let offset = 0;
  for await (const chunk of session.decryptFileChunks(
    new Blob([encrypted]),
    encryptionKeyBlob,
    plaintextSize,
  )) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  expect(offset).toBe(plaintextSize);
  return result;
}

describe("UnlockedBackupKeybag", () => {
  it("unlocks the static fixture keybag and decrypts manifest/file keys", async () => {
    const session = await unlockBackupKeybag(
      fixtureKeybag(),
      "G0lemine-M5!",
    );
    expect(session.warnings).toEqual([]);

    const manifest = new Uint8Array(512);
    manifest.set(new TextEncoder().encode("SQLite format 3\u0000"));
    new DataView(manifest.buffer).setUint16(16, 512, false);
    const manifestEncrypted = await encryptRawBlocks(
      manifest,
      hex(
        "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
      ),
    );
    await expect(
      session.decryptManifestDatabase(
        manifestEncrypted,
        wrappedBlob(
          "8aacfb98579bd07c79487bb2b5d36a48b250bf6bab553ec166cdb65226a4de91fb3b147cb98728f4",
        ),
      ),
    ).resolves.toEqual(manifest);

    const manifestPkcs7 = await encryptPkcs7(
      manifest,
      hex(
        "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
      ),
    );
    expect(manifestPkcs7.byteLength).toBe(manifest.byteLength + 16);
    await expect(
      session.decryptManifestDatabase(
        manifestPkcs7,
        wrappedBlob(
          "8aacfb98579bd07c79487bb2b5d36a48b250bf6bab553ec166cdb65226a4de91fb3b147cb98728f4",
        ),
      ),
    ).resolves.toEqual(manifest);

    const filePlaintext = Uint8Array.from(
      { length: 31 },
      (_, index) => index + 1,
    );
    const filePadded = new Uint8Array(32);
    filePadded.set(filePlaintext);
    const fileEncrypted = await encryptRawBlocks(
      filePadded,
      hex(
        "505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f",
      ),
    );
    await expect(
      collectFileChunks(
        session,
        fileEncrypted,
        wrappedBlob(
          "70625b4fa8313bf4902bb9dbd00b8766e4a58300c89bce51bff676047b8fd926d4244d096647e524",
        ),
        filePlaintext.byteLength,
      ),
    ).resolves.toEqual(filePlaintext);

    session.destroy();
    await expect(
      collectFileChunks(
        session,
        fileEncrypted,
        wrappedBlob(
          "70625b4fa8313bf4902bb9dbd00b8766e4a58300c89bce51bff676047b8fd926d4244d096647e524",
        ),
        filePlaintext.byteLength,
      ),
    ).rejects.toMatchObject({
      code: "malformed-key-material",
    });
  });

  it("reports a wrong password distinctly and does not return a session", async () => {
    await expect(
      unlockBackupKeybag(fixtureKeybag(), "definitely-wrong"),
    ).rejects.toMatchObject({
      code: "wrong-password",
    });
  });

  it("does not expose class keys on the session surface", async () => {
    const session: UnlockedBackupKeybag = await unlockBackupKeybag(
      fixtureKeybag(),
      "G0lemine-M5!",
    );
    expect(Object.keys(session)).not.toContain("password");
    session.destroy();
  });
});
