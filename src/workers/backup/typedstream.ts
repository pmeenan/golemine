import { bytesStartWith, stringFromCodeUnits } from "../shared/binary";

const typedstreamHeader = new Uint8Array([
  0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70,
  0x65, 0x64, 0x81, 0xe8, 0x03,
]);

const beginTypeTag = 0x84;
const stringTypeTag = 0x2b;
const extendedUInt16 = 0x81;
const extendedUInt32 = 0x82;
const extendedUInt64 = 0x83;
const maxTypedstreamBytes = 1_048_576;
const maxTextPayloadBytes = 1_048_576;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function extractTypedstreamText(
  bytes: Uint8Array,
): string | undefined {
  try {
    if (
      bytes.byteLength < typedstreamHeader.byteLength ||
      bytes.byteLength > maxTypedstreamBytes ||
      !bytesStartWith(bytes, typedstreamHeader) ||
      !hasNSStringClassMetadata(bytes)
    ) {
      return undefined;
    }

    return extractFirstStringPayload(bytes);
  } catch {
    return undefined;
  }
}

function extractFirstStringPayload(bytes: Uint8Array): string | undefined {
  for (
    let offset = typedstreamHeader.byteLength;
    offset <= bytes.byteLength - 4;
    offset += 1
  ) {
    if (
      bytes[offset] !== beginTypeTag ||
      bytes[offset + 1] !== 0x01 ||
      bytes[offset + 2] !== stringTypeTag
    ) {
      continue;
    }

    const length = readCompactUnsignedInteger(bytes, offset + 3);
    if (
      length === undefined ||
      length.value === 0 ||
      length.value > maxTextPayloadBytes ||
      length.nextOffset + length.value > bytes.byteLength
    ) {
      continue;
    }

    const text = decodeTextPayload(
      bytes.subarray(length.nextOffset, length.nextOffset + length.value),
    );

    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
}

function readCompactUnsignedInteger(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | undefined {
  if (offset >= bytes.byteLength) {
    return undefined;
  }

  const marker = bytes[offset];
  if (marker < 0x80) {
    return { value: marker, nextOffset: offset + 1 };
  }

  switch (marker) {
    case extendedUInt16:
      return readLittleEndianInteger(bytes, offset + 1, 2);
    case extendedUInt32:
      return readLittleEndianInteger(bytes, offset + 1, 4);
    case extendedUInt64:
      return readLittleEndianInteger(bytes, offset + 1, 8);
    default:
      return undefined;
  }
}

function readLittleEndianInteger(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
): { value: number; nextOffset: number } | undefined {
  if (offset + byteLength > bytes.byteLength) {
    return undefined;
  }

  let value = 0n;
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return { value: Number(value), nextOffset: offset + byteLength };
}

function decodeTextPayload(payload: Uint8Array): string | undefined {
  const utf16 = decodeMaybeUtf16(payload);
  if (utf16 !== undefined && isPlausibleText(utf16)) {
    return utf16;
  }

  try {
    const utf8 = utf8Decoder.decode(payload);
    return isPlausibleText(utf8) ? utf8 : undefined;
  } catch {
    return undefined;
  }
}

function decodeMaybeUtf16(payload: Uint8Array): string | undefined {
  if (payload.byteLength < 2 || payload.byteLength % 2 !== 0) {
    return undefined;
  }

  if (payload[0] === 0xff && payload[1] === 0xfe) {
    return decodeUtf16(payload, 2, "little");
  }

  if (payload[0] === 0xfe && payload[1] === 0xff) {
    return decodeUtf16(payload, 2, "big");
  }

  const endian = inferUtf16Endian(payload);
  return endian === undefined ? undefined : decodeUtf16(payload, 0, endian);
}

function inferUtf16Endian(
  payload: Uint8Array,
): "little" | "big" | undefined {
  let evenZeroes = 0;
  let oddZeroes = 0;

  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    if (payload[offset] === 0) {
      evenZeroes += 1;
    }
    if (payload[offset + 1] === 0) {
      oddZeroes += 1;
    }
  }

  const codeUnits = payload.byteLength / 2;
  const threshold = Math.max(1, Math.floor(codeUnits * 0.5));

  if (oddZeroes >= threshold && evenZeroes === 0) {
    return "little";
  }

  if (evenZeroes >= threshold && oddZeroes === 0) {
    return "big";
  }

  return undefined;
}

function decodeUtf16(
  payload: Uint8Array,
  offset: number,
  endian: "little" | "big",
): string | undefined {
  if ((payload.byteLength - offset) % 2 !== 0) {
    return undefined;
  }

  const codeUnits: number[] = [];
  for (let cursor = offset; cursor < payload.byteLength; cursor += 2) {
    const codeUnit =
      endian === "little"
        ? payload[cursor] | (payload[cursor + 1] << 8)
        : (payload[cursor] << 8) | payload[cursor + 1];

    if (codeUnit === 0xfffe) {
      return undefined;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (cursor + 3 >= payload.byteLength) {
        return undefined;
      }

      const nextCodeUnit =
        endian === "little"
          ? payload[cursor + 2] | (payload[cursor + 3] << 8)
          : (payload[cursor + 2] << 8) | payload[cursor + 3];

      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return undefined;
      }

      codeUnits.push(codeUnit, nextCodeUnit);
      cursor += 2;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }

    codeUnits.push(codeUnit);
  }

  return stringFromCodeUnits(codeUnits);
}

function isPlausibleText(text: string): boolean {
  if (text.length === 0 || text.includes("\u0000") || text.includes("\ufffd")) {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (
      codeUnit < 0x20 &&
      codeUnit !== 0x09 &&
      codeUnit !== 0x0a &&
      codeUnit !== 0x0d
    ) {
      return false;
    }
  }

  return true;
}

function hasNSStringClassMetadata(bytes: Uint8Array): boolean {
  return (
    containsAscii(bytes, "NSString") ||
    containsAscii(bytes, "NSMutableString")
  );
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  if (text.length === 0 || bytes.byteLength < text.length) {
    return false;
  }

  for (let offset = 0; offset <= bytes.byteLength - text.length; offset += 1) {
    let matches = true;

    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
}

