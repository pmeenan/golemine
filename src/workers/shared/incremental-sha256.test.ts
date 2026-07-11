import { describe, expect, it } from "vitest";

import {
  IncrementalSha256,
  nativeSha256MaxBlobBytes,
  sha256BlobHex,
  updateSha256WithZeros,
} from "./incremental-sha256";

const encoder = new TextEncoder();

const fipsVectors = [
  {
    name: "the empty message",
    message: "",
    expected:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: "the short abc message",
    message: "abc",
    expected:
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    name: "the FIPS multi-block message",
    message:
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    expected:
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  {
    name: "the FIPS long message",
    message:
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn" +
      "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    expected:
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  },
] as const;

describe("IncrementalSha256", () => {
  for (const vector of fipsVectors) {
    it(`matches ${vector.name} vector from FIPS 180-4`, () => {
      const hasher = new IncrementalSha256();
      hasher.update(encoder.encode(vector.message));

      expect(hasher.digestHex()).toBe(vector.expected);
    });
  }

  it("matches the NIST million-a vector across repeated updates", () => {
    const hasher = new IncrementalSha256();
    const thousandAs = new Uint8Array(1_000).fill(0x61);

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      hasher.update(thousandAs);
    }

    expect(hasher.digestHex()).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("matches the NIST CAVP one-byte binary vector", () => {
    const hasher = new IncrementalSha256().update(Uint8Array.of(0xd3));

    expect(hasher.digestHex()).toBe(
      "28969cdfa74a12c82f3bad960b0b000aca2ac329deea5c2328ebc6f2ba9802c1",
    );
  });

  it("produces the same digest when updates split block boundaries", () => {
    const vector = fipsVectors[3];
    const bytes = encoder.encode(vector.message);
    const chunkLengths = [1, 2, 61, 3, 17, 5, 23] as const;
    const hasher = new IncrementalSha256();
    let offset = 0;
    let chunkIndex = 0;

    while (offset < bytes.byteLength) {
      const end = Math.min(
        bytes.byteLength,
        offset + chunkLengths[chunkIndex % chunkLengths.length],
      );
      hasher.update(bytes.subarray(offset, end));
      offset = end;
      chunkIndex += 1;
    }

    expect(hasher.digestHex()).toBe(vector.expected);
  });

  it("clones a partial hash into independent branches", () => {
    const first = new IncrementalSha256().update(encoder.encode("abc"));
    const second = first.clone();

    first.update(encoder.encode("def"));
    second.update(encoder.encode("ghi"));

    expect(first.digestHex()).toBe(
      "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    );
    expect(second.digestHex()).toBe(
      "88e62cc629dd01b00e848312fb079c80f82673dc29cdde22f155e71f60d72cb0",
    );
  });

  it("returns digest bytes in big-endian order", () => {
    const digest = new IncrementalSha256()
      .update(encoder.encode("abc"))
      .digest();

    expect(Array.from(digest.slice(0, 4))).toEqual([0xba, 0x78, 0x16, 0xbf]);
    expect(digest).toHaveLength(32);
  });

  it("rejects reuse after finalization", () => {
    const hasher = new IncrementalSha256().update(encoder.encode("abc"));
    hasher.digest();

    expect(() => hasher.update(new Uint8Array())).toThrow(/finalized/u);
    expect(() => hasher.digest()).toThrow(/finalized/u);
    expect(() => hasher.clone()).toThrow(/finalized/u);
  });
});

describe("sha256BlobHex", () => {
  for (const vector of fipsVectors) {
    it(`matches ${vector.name} vector on the native digest path`, async () => {
      const blob = new Blob([encoder.encode(vector.message)]);

      await expect(sha256BlobHex(blob)).resolves.toBe(vector.expected);
    });

    it(`matches ${vector.name} vector on the streaming path`, async () => {
      const blob = new Blob([encoder.encode(vector.message)]);

      await expect(
        sha256BlobHex(blob, { chunkBytes: 3, onChunk: () => undefined }),
      ).resolves.toBe(vector.expected);
    });
  }

  it("streams blobs above the native digest threshold", async () => {
    const bytes = new Uint8Array(nativeSha256MaxBlobBytes + 1);

    for (let offset = 0; offset < bytes.byteLength; offset += 4_096) {
      bytes[offset] = offset & 0xff;
    }

    const expected = hexOfBytes(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    );

    await expect(sha256BlobHex(new Blob([bytes]))).resolves.toBe(expected);
  });

  it("tees every hashed chunk to onChunk without changing the digest", async () => {
    const bytes = new Uint8Array(1_000);

    for (let offset = 0; offset < bytes.byteLength; offset += 1) {
      bytes[offset] = offset & 0xff;
    }

    const borrowed: Uint8Array[] = [];
    const copies: Uint8Array[] = [];
    const digestHex = await sha256BlobHex(new Blob([bytes]), {
      chunkBytes: 64,
      onChunk: async (chunk) => {
        borrowed.push(chunk);
        copies.push(chunk.slice());
        await Promise.resolve();
      },
    });

    expect(copies).toHaveLength(Math.ceil(bytes.byteLength / 64));

    const combined = new Uint8Array(bytes.byteLength);
    let combinedOffset = 0;

    for (const copy of copies) {
      combined.set(copy, combinedOffset);
      combinedOffset += copy.byteLength;
    }

    expect(combined).toEqual(bytes);
    expect(digestHex).toBe(
      new IncrementalSha256().update(bytes).digestHex(),
    );
    // Chunks are borrowed views that are zeroized after the callback settles.
    expect(
      borrowed.every((chunk) => chunk.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it("rejects a non-positive chunk size before hashing", async () => {
    await expect(
      sha256BlobHex(new Blob([encoder.encode("abc")]), { chunkBytes: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("honors an already-aborted signal on both paths", async () => {
    const controller = new AbortController();
    controller.abort();
    const blob = new Blob([encoder.encode("abc")]);

    await expect(
      sha256BlobHex(blob, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    await expect(
      sha256BlobHex(blob, {
        signal: controller.signal,
        onChunk: () => undefined,
      }),
    ).rejects.toBe(controller.signal.reason);
  });
});

describe("updateSha256WithZeros", () => {
  it("hashes a zero fill identically to explicit zero bytes", () => {
    const expected = new IncrementalSha256()
      .update(new Uint8Array(100))
      .digestHex();
    const hasher = new IncrementalSha256();
    updateSha256WithZeros(hasher, 100, 7);

    expect(hasher.digestHex()).toBe(expected);
  });

  it("tees zero chunks to onChunk without changing the digest", async () => {
    const expected = new IncrementalSha256()
      .update(new Uint8Array(100))
      .digestHex();
    const hasher = new IncrementalSha256();
    let teedBytes = 0;

    await updateSha256WithZeros(hasher, 100, 32, async (chunk) => {
      expect(chunk.every((byte) => byte === 0)).toBe(true);
      teedBytes += chunk.byteLength;
      await Promise.resolve();
    });

    expect(teedBytes).toBe(100);
    expect(hasher.digestHex()).toBe(expected);
  });

  it("rejects invalid lengths and chunk sizes", () => {
    expect(() => {
      updateSha256WithZeros(new IncrementalSha256(), -1);
    }).toThrow(/non-negative integer/u);
    expect(() => {
      updateSha256WithZeros(new IncrementalSha256(), 10, 0);
    }).toThrow(RangeError);
  });
});

function hexOfBytes(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}
