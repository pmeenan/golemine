import { describe, expect, it } from "vitest";
import { extractTypedstreamText } from "./typedstream";

const encoder = new TextEncoder();
const typedstreamHeader = new Uint8Array([
  0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70,
  0x65, 0x64, 0x81, 0xe8, 0x03,
]);

describe("typedstream attributedBody text extraction", () => {
  it("extracts message text from a synthetic iOS attributedBody stream", () => {
    const bytes = buildSyntheticAttributedBody("Meet at 5: cafe \u2615");

    expect(extractTypedstreamText(bytes)).toBe("Meet at 5: cafe \u2615");
  });

  it("decodes UTF-16 NSString payload text", () => {
    const bytes = buildSyntheticAttributedBody("Lunch \ud83c\udf71?", {
      encoding: "utf-16le",
    });

    expect(extractTypedstreamText(bytes)).toBe("Lunch \ud83c\udf71?");
  });

  it("continues scanning after a malformed string-length candidate", () => {
    const textBytes = encoder.encode("Recovered text");
    const bytes = concat([
      typedstreamHeader,
      typeTag("@"),
      classChain(["NSMutableAttributedString", "NSAttributedString", "NSObject"]),
      new Uint8Array([0x92]),
      classChain(["NSMutableString", "NSString"]),
      typeTag("+"),
      new Uint8Array([0x83, 0xff]),
      typeTag("+"),
      compactUnsignedInteger(textBytes.byteLength),
      textBytes,
    ]);

    expect(extractTypedstreamText(bytes)).toBe("Recovered text");
  });

  it("returns undefined for empty and malformed bytes", () => {
    expect(extractTypedstreamText(new Uint8Array())).toBeUndefined();
    expect(extractTypedstreamText(typedstreamHeader)).toBeUndefined();
    expect(
      extractTypedstreamText(
        concat([
          typedstreamHeader,
          typeTag("@"),
          classChain(["NSString", "NSObject"]),
          typeTag("+"),
          new Uint8Array([0x81, 0xff]),
        ]),
      ),
    ).toBeUndefined();
  });

  it("does not crash on random binary data", () => {
    const randomBytes = buildDeterministicRandomBytes(4096);

    expect(() => extractTypedstreamText(randomBytes)).not.toThrow();
    expect(extractTypedstreamText(randomBytes)).toBeUndefined();
  });
});

export function buildSyntheticAttributedBody(
  text: string,
  options: { encoding?: "utf-8" | "utf-16le" } = {},
): Uint8Array {
  const textBytes =
    options.encoding === "utf-16le"
      ? utf16LittleEndianWithBom(text)
      : encoder.encode(text);

  return concat([
    typedstreamHeader,
    typeTag("@"),
    classChain(["NSMutableAttributedString", "NSAttributedString", "NSObject"]),
    new Uint8Array([0x92]),
    classChain(["NSMutableString", "NSString"]),
    typeTag("+"),
    compactUnsignedInteger(textBytes.byteLength),
    textBytes,
    new Uint8Array([0x86]),
    typeTag("iI"),
    new Uint8Array([0x01, text.length]),
    new Uint8Array([0x86, 0x86]),
  ]);
}

function classChain(classNames: readonly string[]): Uint8Array {
  return concat([
    ...classNames.map((className, index) =>
      concat([
        new Uint8Array([0x84, 0x84]),
        countedBytes(`${className}\0`),
        new Uint8Array([index === 0 ? 0x01 : 0x00]),
      ]),
    ),
    new Uint8Array([0x85]),
  ]);
}

function typeTag(tag: string): Uint8Array {
  return concat([new Uint8Array([0x84]), countedBytes(tag)]);
}

function countedBytes(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > 0x7f) {
    throw new Error("Test typedstream fixture chunk is too large.");
  }

  return concat([new Uint8Array([bytes.byteLength]), bytes]);
}

function compactUnsignedInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Test typedstream length must be a non-negative integer.");
  }

  if (value < 0x80) {
    return new Uint8Array([value]);
  }

  if (value <= 0xffff) {
    return new Uint8Array([0x81, value & 0xff, value >> 8]);
  }

  throw new Error("Test typedstream length is too large.");
}

function utf16LittleEndianWithBom(text: string): Uint8Array {
  const output = new Uint8Array(2 + text.length * 2);
  output[0] = 0xff;
  output[1] = 0xfe;

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    const offset = 2 + index * 2;
    output[offset] = codeUnit & 0xff;
    output[offset + 1] = codeUnit >> 8;
  }

  return output;
}

function buildDeterministicRandomBytes(length: number): Uint8Array {
  const output = new Uint8Array(length);
  let state = 0x12345678;

  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 0xff;
  }

  return output;
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
