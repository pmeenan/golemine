import { describe, expect, it } from "vitest";
import {
  isPlistDictionary,
  parsePlist,
  PlistParseError,
  type PlistDictionary,
} from "./plist";

const encoder = new TextEncoder();
const binaryMagic = new Uint8Array([
  0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30,
]);

describe("plist parser", () => {
  it("parses XML plist dictionaries with scalar values", () => {
    const parsed = parsePlist(
      encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
          "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
          <dict>
            <key>Device Name</key>
            <string>Mina &amp; Co</string>
            <key>Product Version</key>
            <string>18.5</string>
            <key>Serial Number</key>
            <string>C39SYNTH0001</string>
            <key>IsEncrypted</key>
            <true/>
            <key>Last Backup Date</key>
            <date>2026-07-01T12:34:56Z</date>
            <key>BackupKeyBag</key>
            <data>AQID</data>
          </dict>
        </plist>`),
    );

    expect(parsed.format).toBe("xml");
    expect(isPlistDictionary(parsed.value)).toBe(true);
    const dict = parsed.value as PlistDictionary;
    expect(dict["Device Name"]).toBe("Mina & Co");
    expect(dict["Product Version"]).toBe("18.5");
    expect(dict["Serial Number"]).toBe("C39SYNTH0001");
    expect(dict.IsEncrypted).toBe(true);
    expect(dict["Last Backup Date"]).toEqual(new Date("2026-07-01T12:34:56Z"));
    expect(Array.from(dict.BackupKeyBag as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("parses bounded binary plist dictionaries with common scalar types", () => {
    const parsed = parsePlist(buildBinaryFixture());

    expect(parsed.format).toBe("binary");
    expect(isPlistDictionary(parsed.value)).toBe(true);
    const dict = parsed.value as PlistDictionary;

    expect(dict.name).toBe("Mina");
    expect(dict.flag).toBe(true);
    expect(dict.count).toBe(42);
    expect(dict.when).toEqual(new Date("2024-01-02T00:00:00.000Z"));
    expect(Array.from(dict.blob as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("rejects truncated binary plist data instead of reading out of bounds", () => {
    const bytes = buildBinaryFixture();

    expect(() => parsePlist(bytes.slice(0, bytes.byteLength - 5))).toThrow(
      PlistParseError,
    );
  });

  it("rejects malformed base64 plist data", () => {
    expect(() =>
      parsePlist(
        encoder.encode(`<plist version="1.0"><dict>
          <key>BadData</key>
          <data>=AAA</data>
        </dict></plist>`),
      ),
    ).toThrow(PlistParseError);
  });

  it("decodes base64 plist data split across whitespace-embedded lines", () => {
    const parsed = parsePlist(
      encoder.encode(`<plist version="1.0"><dict>
        <key>Blob</key>
        <data>
          AQID
          BAUG
          BwgJ
        </data>
      </dict></plist>`),
    );

    const dict = parsed.value as PlistDictionary;
    expect(Array.from(dict.Blob as Uint8Array)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("keeps CDATA string content literal instead of entity-decoding it", () => {
    const parsed = parsePlist(
      encoder.encode(`<plist version="1.0"><dict>
        <key>Name</key>
        <string><![CDATA[Tom &amp; Jerry]]></string>
      </dict></plist>`),
    );

    const dict = parsed.value as PlistDictionary;
    expect(dict.Name).toBe("Tom &amp; Jerry");
  });

  it("decodes only the plain text portion of mixed text and CDATA values", () => {
    const parsed = parsePlist(
      encoder.encode(`<plist version="1.0"><dict>
        <key>Name</key>
        <string>a &amp; b<![CDATA[ &amp; c]]></string>
      </dict></plist>`),
    );

    const dict = parsed.value as PlistDictionary;
    expect(dict.Name).toBe("a & b &amp; c");
  });

  it("does not merge an entity split across a text/CDATA boundary", () => {
    const parsed = parsePlist(
      encoder.encode(`<plist version="1.0"><dict>
        <key>Name</key>
        <string>&am<![CDATA[p;]]></string>
      </dict></plist>`),
    );

    const dict = parsed.value as PlistDictionary;
    expect(dict.Name).toBe("&amp;");
  });

  it("parses 1-, 2-, and 4-byte binary plist integers as unsigned", () => {
    const parsed = parsePlist(
      buildBinaryPlist([
        arrayObject([1, 2, 3]),
        rawIntObject([0xff]),
        rawIntObject([0x9c, 0x40]),
        rawIntObject([0x80, 0x00, 0x00, 0x01]),
      ]),
    );

    expect(parsed.value).toEqual([255, 40000, 2147483649]);
  });

  it("parses 8-byte binary plist integers as signed two's complement", () => {
    const parsed = parsePlist(
      buildBinaryPlist([
        arrayObject([1]),
        rawIntObject([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      ]),
    );

    expect(parsed.value).toEqual([-1]);
  });
});

function buildBinaryFixture(): Uint8Array {
  return buildBinaryPlist([
    dictObject([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]),
    asciiObject("name"),
    asciiObject("flag"),
    asciiObject("when"),
    asciiObject("blob"),
    asciiObject("count"),
    asciiObject("Mina"),
    boolObject(true),
    dateObject(new Date("2024-01-02T00:00:00.000Z")),
    dataObject(new Uint8Array([1, 2, 3])),
    intObject(42),
  ]);
}

function buildBinaryPlist(objects: readonly Uint8Array[]): Uint8Array {
  const offsets: number[] = [];
  let cursor = binaryMagic.byteLength;

  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.byteLength;
  }

  if (cursor > 0xff || objects.length > 0xff) {
    throw new Error("Test binary plist fixture is too large for one-byte refs.");
  }

  const offsetTableOffset = cursor;
  const offsetTable = new Uint8Array(offsets);
  const trailer = new Uint8Array(32);
  trailer[6] = 1;
  trailer[7] = 1;
  writeUInt64(trailer, 8, BigInt(objects.length));
  writeUInt64(trailer, 16, 0n);
  writeUInt64(trailer, 24, BigInt(offsetTableOffset));

  return concat([binaryMagic, ...objects, offsetTable, trailer]);
}

function asciiObject(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > 0x0e) {
    throw new Error("Test fixture string is too long.");
  }

  return concat([new Uint8Array([0x50 | bytes.byteLength]), bytes]);
}

function boolObject(value: boolean): Uint8Array {
  return new Uint8Array([value ? 0x09 : 0x08]);
}

function intObject(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error("Test fixture integer must fit in one byte.");
  }

  return new Uint8Array([0x10, value]);
}

function rawIntObject(bytes: readonly number[]): Uint8Array {
  const infoBySize = new Map<number, number>([
    [1, 0],
    [2, 1],
    [4, 2],
    [8, 3],
  ]);
  const info = infoBySize.get(bytes.length);

  if (info === undefined) {
    throw new Error("Test fixture integer must be 1, 2, 4, or 8 bytes.");
  }

  return concat([new Uint8Array([0x10 | info]), new Uint8Array(bytes)]);
}

function arrayObject(refs: readonly number[]): Uint8Array {
  if (refs.length > 0x0e) {
    throw new Error("Test fixture array has too many refs.");
  }

  return concat([new Uint8Array([0xa0 | refs.length]), new Uint8Array(refs)]);
}

function dataObject(value: Uint8Array): Uint8Array {
  if (value.byteLength > 0x0e) {
    throw new Error("Test fixture data is too long.");
  }

  return concat([new Uint8Array([0x40 | value.byteLength]), value]);
}

function dateObject(value: Date): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes[0] = 0x33;
  new DataView(bytes.buffer).setFloat64(
    1,
    (value.getTime() - Date.UTC(2001, 0, 1)) / 1000,
    false,
  );
  return bytes;
}

function dictObject(
  keyRefs: readonly number[],
  valueRefs: readonly number[],
): Uint8Array {
  if (keyRefs.length !== valueRefs.length || keyRefs.length > 0x0e) {
    throw new Error("Test fixture dictionary refs are invalid.");
  }

  return concat([
    new Uint8Array([0xd0 | keyRefs.length]),
    new Uint8Array(keyRefs),
    new Uint8Array(valueRefs),
  ]);
}

function writeUInt64(target: Uint8Array, offset: number, value: bigint): void {
  for (let index = 7; index >= 0; index -= 1) {
    target[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
