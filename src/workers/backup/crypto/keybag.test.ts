import { describe, expect, it } from "vitest";

import { BackupCryptoError, parseKeybag } from "./index";

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function tlv(tag: string, value: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + value.byteLength);
  for (let index = 0; index < 4; index += 1) {
    result[index] = tag.charCodeAt(index);
  }
  new DataView(result.buffer).setUint32(4, value.byteLength, false);
  result.set(value, 8);
  return result;
}

function join(...parts: Uint8Array[]): Uint8Array {
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

function fixtureKeybag(
  overrides: { classWrap?: number; classWrappedKey?: Uint8Array } = {},
): Uint8Array {
  return join(
    tlv("VERS", u32(3)),
    tlv("TYPE", u32(1)),
    tlv("UUID", new Uint8Array(16).fill(0x11)),
    tlv("WRAP", u32(2)),
    tlv("SALT", new Uint8Array([1, 2, 3, 4])),
    tlv("ITER", u32(10_000)),
    tlv("DPSL", new Uint8Array([5, 6, 7, 8])),
    tlv("DPIC", u32(10_000_000)),
    tlv("ZZZZ", new Uint8Array([0x99])),
    tlv("UUID", new Uint8Array(16).fill(0x22)),
    tlv("CLAS", u32(4)),
    tlv("WRAP", u32(overrides.classWrap ?? 2)),
    tlv("KTYP", u32(0)),
    tlv(
      "WPKY",
      overrides.classWrappedKey ?? new Uint8Array(40).fill(0x33),
    ),
  );
}

function captureCryptoError(action: () => unknown): BackupCryptoError {
  try {
    action();
  } catch (error) {
    if (error instanceof BackupCryptoError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a BackupCryptoError.");
}

describe("parseKeybag", () => {
  it("parses bounded header and class-key TLVs without confusing UUID scopes", () => {
    const parsed = parseKeybag(fixtureKeybag({ classWrap: 3 }));

    expect(parsed).toMatchObject({
      version: 3,
      type: 1,
      wrapFlags: 2,
      iterations: 10_000,
      doubleProtectionIterations: 10_000_000,
    });
    expect(parsed.uuid).toEqual(new Uint8Array(16).fill(0x11));
    expect(parsed.classKeys).toHaveLength(1);
    expect(parsed.classKeys[0]).toMatchObject({
      protectionClass: 4,
      wrapFlags: 3,
      keyType: 0,
    });
    expect(parsed.classKeys[0].uuid).toEqual(new Uint8Array(16).fill(0x22));
    expect(parsed.classKeys[0].wrappedKey).toEqual(
      new Uint8Array(40).fill(0x33),
    );
  });

  it("rejects truncated and overrun TLVs with a classified error", () => {
    expect(() => parseKeybag(new Uint8Array([0x56, 0x45]))).toThrowError(
      BackupCryptoError,
    );

    const overrun = new Uint8Array(8);
    overrun.set([0x56, 0x45, 0x52, 0x53]);
    new DataView(overrun.buffer).setUint32(4, 0xffff_ffff, false);
    expect(captureCryptoError(() => parseKeybag(overrun))).toMatchObject({
      code: "malformed-keybag",
    });
  });

  it("rejects malformed class keys and duplicate protection classes", () => {
    expect(
      captureCryptoError(() =>
        parseKeybag(fixtureKeybag({ classWrappedKey: new Uint8Array(39) })),
      ),
    ).toMatchObject({ code: "malformed-keybag" });

    const duplicateClass = join(
      fixtureKeybag(),
      tlv("UUID", new Uint8Array(16).fill(0x44)),
      tlv("CLAS", u32(4)),
      tlv("WRAP", u32(2)),
      tlv("KTYP", u32(0)),
      tlv("WPKY", new Uint8Array(40).fill(0x55)),
    );
    expect(captureCryptoError(() => parseKeybag(duplicateClass))).toMatchObject({
      code: "malformed-keybag",
    });
  });

  it("distinguishes unsupported keybag types", () => {
    const unsupported = fixtureKeybag();
    const typeOffset = 8 + 8;
    new DataView(unsupported.buffer).setUint32(typeOffset + 4, 2, false);
    expect(captureCryptoError(() => parseKeybag(unsupported))).toMatchObject({
      code: "unsupported-keybag",
    });
  });
});
