import { describe, expect, it } from "vitest";

import {
  decryptAes256CbcBlobChunks,
  type CbcEncryptedBlob,
} from "./index";

const zeroIv = new Uint8Array(16);

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
      { name: "AES-CBC", iv: zeroIv },
      key,
      plaintextCopy,
    ),
  );
}

async function encryptRawBlocks(
  plaintextBlocks: Uint8Array,
  keyBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const withWebCryptoPadding = await encryptPkcs7(plaintextBlocks, keyBytes);
  return withWebCryptoPadding.slice(0, -16);
}

async function collect(
  chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk.slice());
  }
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("AES-256-CBC backup decryption", () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);

  it("decrypts raw CBC blocks and truncates exactly to MBFile.Size", async () => {
    const expected = Uint8Array.from(
      { length: 100 },
      (_, index) => (index * 29) & 0xff,
    );
    const padded = new Uint8Array(112).fill(0xa5);
    padded.set(expected);
    const encrypted = await encryptRawBlocks(padded, key);

    await expect(
      collect(
        decryptAes256CbcBlobChunks(
          new Blob([encrypted]),
          key,
          expected.byteLength,
        ),
      ),
    ).resolves.toEqual(expected);
  });

  it("ignores a block-aligned stored tail beyond MBFile.Size", async () => {
    const expected = Uint8Array.from(
      { length: 100 },
      (_, index) => (index * 17 + 3) & 0xff,
    );
    const storedPlaintext = new Uint8Array(176).fill(0x9b);
    storedPlaintext.set(expected);
    const encrypted = await encryptRawBlocks(storedPlaintext, key);

    expect(encrypted.byteLength - expected.byteLength).toBeGreaterThan(16);
    await expect(
      collect(
        decryptAes256CbcBlobChunks(
          new Blob([encrypted]),
          key,
          expected.byteLength,
        ),
      ),
    ).resolves.toEqual(expected);
  });

  it("decrypts a materialized prefix shorter than the logical MBFile.Size", async () => {
    const materialized = Uint8Array.from(
      { length: 32 },
      (_, index) => (index * 11 + 7) & 0xff,
    );
    const encrypted = await encryptRawBlocks(materialized, key);

    await expect(
      collect(
        decryptAes256CbcBlobChunks(
          new Blob([encrypted]),
          key,
          materialized.byteLength + 48,
        ),
      ),
    ).resolves.toEqual(materialized);
  });

  it("decrypts a page-aligned Manifest database with no PKCS#7 block", async () => {
    const manifest = Uint8Array.from(
      { length: 4096 },
      (_, index) => (index * 7) & 0xff,
    );
    const encrypted = await encryptRawBlocks(manifest, key);
    expect(encrypted.byteLength).toBe(manifest.byteLength);

    const decrypted = await collect(
      decryptAes256CbcBlobChunks(
        new Blob([encrypted]),
        key,
        manifest.byteLength,
      ),
    );
    expect(decrypted.byteLength).toBe(manifest.byteLength);
    expect(decrypted).toEqual(manifest);
  });

  it("streams block-aligned chunks without reading the whole source", async () => {
    const expected = Uint8Array.from(
      { length: 143 },
      (_, index) => (index * 13 + 5) & 0xff,
    );
    const padded = new Uint8Array(144).fill(0x7c);
    padded.set(expected);
    const encrypted = await encryptRawBlocks(padded, key);
    const reads: [number | undefined, number | undefined][] = [];
    const blob = new Blob([encrypted]);
    const source: CbcEncryptedBlob = {
      size: blob.size,
      slice(start, end) {
        reads.push([start, end]);
        return blob.slice(start, end);
      },
    };
    const progress: number[] = [];
    const result = await collect(
      decryptAes256CbcBlobChunks(source, key, expected.byteLength, {
        chunkBytes: 32,
        progress(event) {
          progress.push(event.processedEncryptedBytes);
        },
      }),
    );

    expect(result).toEqual(expected);
    expect(reads).toEqual([
      [0, 32],
      [32, 64],
      [64, 96],
      [96, 128],
      [128, 144],
    ]);
    expect(progress).toEqual([32, 64, 96, 128, 144]);
  });

  it("handles a one-block chunk boundary and rejects malformed shapes", async () => {
    const plaintext = new Uint8Array(48).fill(0x4d);
    const encrypted = await encryptRawBlocks(plaintext, key);
    await expect(
      collect(
        decryptAes256CbcBlobChunks(
          new Blob([encrypted]),
          key,
          plaintext.byteLength,
          { chunkBytes: 16 },
        ),
      ),
    ).resolves.toEqual(plaintext);

    await expect(
      collect(
        decryptAes256CbcBlobChunks(new Blob([new Uint8Array(15)]), key, 10),
      ),
    ).rejects.toMatchObject({
      code: "malformed-ciphertext",
    });
    await expect(
      collect(
        decryptAes256CbcBlobChunks(new Blob([new Uint8Array(32)]), key, 1, {
          chunkBytes: 15,
        }),
      ),
    ).rejects.toMatchObject({
      code: "malformed-ciphertext",
    });
  });

  it("zeroes a borrowed plaintext chunk when iteration is cancelled", async () => {
    const plaintext = new Uint8Array(32).fill(0x6a);
    const encrypted = await encryptRawBlocks(plaintext, key);
    const iterator = decryptAes256CbcBlobChunks(
      new Blob([encrypted]),
      key,
      plaintext.byteLength,
      { chunkBytes: 16 },
    );
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const borrowed = first.value;
    expect(borrowed).toEqual(new Uint8Array(16).fill(0x6a));

    await iterator.return(undefined);
    expect(borrowed).toEqual(new Uint8Array(16));
  });

  it("zeroes a ciphertext chunk when cancellation lands after its read", async () => {
    const plaintext = new Uint8Array(32).fill(0x39);
    const encrypted = await encryptRawBlocks(plaintext, key);
    const exposedCiphertext = encrypted.slice();
    const controller = new AbortController();
    const source: CbcEncryptedBlob = {
      size: exposedCiphertext.byteLength,
      slice() {
        return {
          arrayBuffer: () => {
            controller.abort();
            return Promise.resolve(exposedCiphertext.buffer);
          },
        } as unknown as Blob;
      },
    };

    await expect(
      collect(
        decryptAes256CbcBlobChunks(source, key, plaintext.byteLength, {
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(exposedCiphertext).toEqual(new Uint8Array(32));
  });
});
