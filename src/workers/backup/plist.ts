import { bytesStartWith, stringFromCodeUnits } from "../shared/binary";
import { appleEpochMs } from "./apple-time";

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | PlistValue[]
  | PlistDictionary;

export interface PlistDictionary {
  readonly [key: string]: PlistValue;
}

export type PlistFormat = "xml" | "binary";

export interface ParsedPlist {
  format: PlistFormat;
  value: PlistValue;
}

export class PlistParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlistParseError";
  }
}

const binaryPlistMagic = new Uint8Array([
  0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30,
]);
const maxContainerLength = 1_000_000;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export function parsePlist(bytes: Uint8Array): ParsedPlist {
  if (bytesStartWith(bytes, binaryPlistMagic)) {
    return { format: "binary", value: new BinaryPlistReader(bytes).parse() };
  }

  const xml = textDecoder.decode(bytes);
  return { format: "xml", value: parseXmlPlist(xml) };
}

export function isPlistDictionary(value: PlistValue): value is PlistDictionary {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value)
  );
}

export function getPlistString(
  dict: PlistDictionary,
  key: string,
): string | undefined {
  const value = dict[key];
  return typeof value === "string" ? value : undefined;
}

export function getPlistBoolean(
  dict: PlistDictionary,
  key: string,
): boolean | undefined {
  const value = dict[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getPlistData(
  dict: PlistDictionary,
  key: string,
): Uint8Array | undefined {
  const value = dict[key];
  return value instanceof Uint8Array ? value : undefined;
}

export function getPlistScalarString(
  dict: PlistDictionary,
  key: string,
): string | undefined {
  const value = dict[key];

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

export function getPlistDateIso(
  dict: PlistDictionary,
  key: string,
): string | undefined {
  const value = dict[key];

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }

  return undefined;
}

type XmlNode =
  | { type: "start"; name: string; selfClosing: boolean }
  | { type: "end"; name: string }
  | { type: "text"; text: string; cdata: boolean };

function parseXmlPlist(xml: string): PlistValue {
  const tokenizer = new XmlTokenizer(xml);
  const root = nextSignificantXmlNode(tokenizer);

  if (root?.type !== "start" || root.name !== "plist") {
    throw new PlistParseError("XML plist is missing the plist root element.");
  }

  if (root.selfClosing) {
    throw new PlistParseError("XML plist root has no value.");
  }

  const valueNode = nextSignificantXmlNode(tokenizer);
  if (valueNode?.type !== "start") {
    throw new PlistParseError("XML plist root has no value.");
  }

  const value = parseXmlValue(tokenizer, valueNode);
  const end = nextSignificantXmlNode(tokenizer);

  if (end?.type !== "end" || end.name !== "plist") {
    throw new PlistParseError("XML plist root was not closed.");
  }

  return value;
}

function parseXmlValue(tokenizer: XmlTokenizer, start: Extract<XmlNode, { type: "start" }>): PlistValue {
  switch (start.name) {
    case "dict":
      return parseXmlDict(tokenizer, start.selfClosing);
    case "array":
      return parseXmlArray(tokenizer, start.selfClosing);
    case "string":
      return readXmlTextValue(tokenizer, "string", start.selfClosing);
    case "key":
      return readXmlTextValue(tokenizer, "key", start.selfClosing);
    case "integer":
      return parseXmlNumber(readXmlTextValue(tokenizer, "integer", start.selfClosing), "integer");
    case "real":
      return parseXmlNumber(readXmlTextValue(tokenizer, "real", start.selfClosing), "real");
    case "date":
      return parseXmlDate(readXmlTextValue(tokenizer, "date", start.selfClosing));
    case "data":
      return decodeBase64(readXmlTextValue(tokenizer, "data", start.selfClosing));
    case "true":
      consumeOptionalEmptyElementEnd(tokenizer, start);
      return true;
    case "false":
      consumeOptionalEmptyElementEnd(tokenizer, start);
      return false;
    default:
      throw new PlistParseError(`Unsupported XML plist element: ${start.name}.`);
  }
}

function parseXmlDict(tokenizer: XmlTokenizer, selfClosing: boolean): PlistDictionary {
  if (selfClosing) {
    return {};
  }

  const dict: Record<string, PlistValue> = {};

  for (;;) {
    const keyNode = nextSignificantXmlNode(tokenizer);

    if (keyNode === null) {
      throw new PlistParseError("XML plist dict was not closed.");
    }

    if (keyNode.type === "end" && keyNode.name === "dict") {
      return dict;
    }

    if (keyNode.type !== "start" || keyNode.name !== "key") {
      throw new PlistParseError("XML plist dict expected a key element.");
    }

    const key = readXmlTextValue(tokenizer, "key", keyNode.selfClosing);
    const valueNode = nextSignificantXmlNode(tokenizer);

    if (valueNode?.type !== "start") {
      throw new PlistParseError(`XML plist dict key "${key}" has no value.`);
    }

    dict[key] = parseXmlValue(tokenizer, valueNode);
  }
}

function parseXmlArray(tokenizer: XmlTokenizer, selfClosing: boolean): PlistValue[] {
  if (selfClosing) {
    return [];
  }

  const values: PlistValue[] = [];

  for (;;) {
    const node = nextSignificantXmlNode(tokenizer);

    if (node === null) {
      throw new PlistParseError("XML plist array was not closed.");
    }

    if (node.type === "end" && node.name === "array") {
      return values;
    }

    if (node.type !== "start") {
      throw new PlistParseError("XML plist array expected a value element.");
    }

    values.push(parseXmlValue(tokenizer, node));
  }
}

function parseXmlNumber(text: string, kind: "integer" | "real"): number {
  const trimmed = text.trim();
  const value = kind === "integer" ? Number.parseInt(trimmed, 10) : Number(trimmed);

  if (!Number.isFinite(value)) {
    throw new PlistParseError(`XML plist ${kind} is not a finite number.`);
  }

  return value;
}

function parseXmlDate(text: string): Date {
  const date = new Date(text.trim());

  if (!Number.isFinite(date.getTime())) {
    throw new PlistParseError("XML plist date is invalid.");
  }

  return date;
}

function readXmlTextValue(
  tokenizer: XmlTokenizer,
  endName: string,
  selfClosing: boolean,
): string {
  if (selfClosing) {
    return "";
  }

  let text = "";

  for (;;) {
    const node = tokenizer.next();

    if (node === null) {
      throw new PlistParseError(`XML plist ${endName} element was not closed.`);
    }

    if (node.type === "text") {
      // CDATA content is literal character data; only plain text segments
      // are entity-decoded. Decoding each segment independently keeps an
      // entity from being assembled across a text/CDATA boundary.
      text += node.cdata ? node.text : decodeXmlEntities(node.text);
      continue;
    }

    if (node.type === "end" && node.name === endName) {
      return text;
    }

    throw new PlistParseError(`XML plist ${endName} element contains nested markup.`);
  }
}

function consumeOptionalEmptyElementEnd(
  tokenizer: XmlTokenizer,
  start: Extract<XmlNode, { type: "start" }>,
): void {
  if (start.selfClosing) {
    return;
  }

  const end = nextSignificantXmlNode(tokenizer);
  if (end?.type !== "end" || end.name !== start.name) {
    throw new PlistParseError(`XML plist ${start.name} element was not closed.`);
  }
}

function nextSignificantXmlNode(tokenizer: XmlTokenizer): XmlNode | null {
  for (;;) {
    const node = tokenizer.next();

    if (node === null) {
      return null;
    }

    if (node.type !== "text" || node.text.trim() !== "") {
      return node;
    }
  }
}

class XmlTokenizer {
  private position = 0;

  constructor(private readonly xml: string) {}

  next(): XmlNode | null {
    while (this.position < this.xml.length) {
      if (this.xml[this.position] !== "<") {
        const nextTag = this.xml.indexOf("<", this.position);
        const end = nextTag === -1 ? this.xml.length : nextTag;
        const text = this.xml.slice(this.position, end);
        this.position = end;
        return { type: "text", text, cdata: false };
      }

      if (this.xml.startsWith("<!--", this.position)) {
        this.skipUntil("-->", "XML comment was not closed.");
        continue;
      }

      if (this.xml.startsWith("<![CDATA[", this.position)) {
        const end = this.xml.indexOf("]]>", this.position + 9);
        if (end === -1) {
          throw new PlistParseError("XML CDATA section was not closed.");
        }
        const text = this.xml.slice(this.position + 9, end);
        this.position = end + 3;
        return { type: "text", text, cdata: true };
      }

      if (this.xml.startsWith("<?", this.position)) {
        this.skipUntil("?>", "XML processing instruction was not closed.");
        continue;
      }

      if (this.xml.startsWith("<!", this.position)) {
        this.skipUntil(">", "XML declaration was not closed.");
        continue;
      }

      const close = this.xml.indexOf(">", this.position + 1);
      if (close === -1) {
        throw new PlistParseError("XML tag was not closed.");
      }

      const rawTag = this.xml.slice(this.position + 1, close).trim();
      this.position = close + 1;

      if (rawTag === "") {
        throw new PlistParseError("XML tag has no name.");
      }

      if (rawTag.startsWith("/")) {
        return { type: "end", name: readXmlTagName(rawTag.slice(1).trim()) };
      }

      const selfClosing = rawTag.endsWith("/");
      const tagBody = selfClosing ? rawTag.slice(0, -1).trimEnd() : rawTag;
      return {
        type: "start",
        name: readXmlTagName(tagBody),
        selfClosing,
      };
    }

    return null;
  }

  private skipUntil(needle: string, errorMessage: string): void {
    const end = this.xml.indexOf(needle, this.position + needle.length);
    if (end === -1) {
      throw new PlistParseError(errorMessage);
    }
    this.position = end + needle.length;
  }
}

function readXmlTagName(tagBody: string): string {
  const match = /^([^\s/>]+)/u.exec(tagBody);

  if (match === null) {
    throw new PlistParseError("XML tag has no name.");
  }

  return match[1];
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);/gu, (entity, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "apos":
        return "'";
      case "quot":
        return "\"";
      default:
        return decodeNumericXmlEntity(entity, body);
    }
  });
}

function decodeNumericXmlEntity(entity: string, body: string): string {
  const radix = body.startsWith("#x") ? 16 : 10;
  const digits = body.startsWith("#x") ? body.slice(2) : body.slice(1);
  const codePoint = Number.parseInt(digits, radix);

  if (
    !Number.isFinite(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff
  ) {
    throw new PlistParseError(`Invalid XML entity ${entity}.`);
  }

  return String.fromCodePoint(codePoint);
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/gu, "");

  if (clean.length === 0) {
    return new Uint8Array();
  }

  if (clean.length % 4 !== 0) {
    throw new PlistParseError("Base64 plist data has invalid padding.");
  }

  for (let offset = 0; offset < clean.length; offset += 4) {
    if (
      clean[offset] === "=" ||
      clean[offset + 1] === "=" ||
      (clean[offset + 2] === "=" && clean[offset + 3] !== "=")
    ) {
      throw new PlistParseError("Base64 plist data has invalid padding.");
    }

    const padding =
      (clean[offset + 2] === "=" ? 1 : 0) + (clean[offset + 3] === "=" ? 1 : 0);

    if (padding > 0 && offset + 4 !== clean.length) {
      throw new PlistParseError("Base64 plist data has padding before the end.");
    }
  }

  const invalidChar = /[^A-Za-z0-9+/=]/u.exec(clean);
  if (invalidChar !== null) {
    throw new PlistParseError(
      `Base64 plist data has invalid character at ${String(invalidChar.index)}.`,
    );
  }

  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    // The checks above should reject anything atob rejects; keep malformed
    // input surfacing as a parse error rather than crashing ingest.
    throw new PlistParseError("Base64 plist data is malformed.");
  }

  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }

  return output;
}

class BinaryPlistReader {
  private readonly view: DataView;
  private readonly offsets: number[];
  private readonly objectRefSize: number;
  private readonly topObject: number;
  private readonly cache = new Map<number, PlistValue>();

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.byteLength < 40) {
      throw new PlistParseError("Binary plist is too short.");
    }

    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trailerOffset = bytes.byteLength - 32;
    const offsetIntSize = this.readTrailerByte(trailerOffset + 6);
    this.objectRefSize = this.readTrailerByte(trailerOffset + 7);
    const objectCount = this.readUnsignedInteger(trailerOffset + 8, 8, "object count");
    this.topObject = this.readUnsignedInteger(trailerOffset + 16, 8, "top object");
    const offsetTableOffset = this.readUnsignedInteger(
      trailerOffset + 24,
      8,
      "offset table offset",
    );

    if (offsetIntSize < 1 || offsetIntSize > 8) {
      throw new PlistParseError("Binary plist has an invalid offset integer size.");
    }

    if (this.objectRefSize < 1 || this.objectRefSize > 8) {
      throw new PlistParseError("Binary plist has an invalid object reference size.");
    }

    if (objectCount < 1 || objectCount > maxContainerLength) {
      throw new PlistParseError("Binary plist has an invalid object count.");
    }

    if (this.topObject >= objectCount) {
      throw new PlistParseError("Binary plist top object is out of range.");
    }

    const offsetTableBytes = objectCount * offsetIntSize;
    this.assertRange(offsetTableOffset, offsetTableBytes, "offset table");

    this.offsets = [];
    for (let index = 0; index < objectCount; index += 1) {
      const objectOffset = this.readUnsignedInteger(
        offsetTableOffset + index * offsetIntSize,
        offsetIntSize,
        "object offset",
      );
      if (objectOffset < binaryPlistMagic.byteLength || objectOffset >= offsetTableOffset) {
        throw new PlistParseError("Binary plist object offset is out of range.");
      }
      this.offsets.push(objectOffset);
    }
  }

  parse(): PlistValue {
    return this.parseObject(this.topObject, new Set<number>());
  }

  private parseObject(index: number, stack: Set<number>): PlistValue {
    const cached = this.cache.get(index);
    if (cached !== undefined) {
      return cached;
    }

    if (index < 0 || index >= this.offsets.length) {
      throw new PlistParseError("Binary plist object reference is out of range.");
    }

    if (stack.has(index)) {
      throw new PlistParseError("Binary plist contains a recursive object graph.");
    }

    stack.add(index);
    const offset = this.offsets[index];
    const marker = this.readByte(offset, "object marker");
    const kind = marker & 0xf0;
    const info = marker & 0x0f;
    const value = this.parseObjectPayload(kind, info, offset, stack);
    this.cache.set(index, value);
    stack.delete(index);
    return value;
  }

  private parseObjectPayload(
    kind: number,
    info: number,
    offset: number,
    stack: Set<number>,
  ): PlistValue {
    switch (kind) {
      case 0x00:
        return this.parseSimple(info);
      case 0x10: {
        // bplist00 (CoreFoundation) stores 1-, 2-, and 4-byte integers as
        // always unsigned; only 8-byte integers carry a sign (two's
        // complement).
        const byteLength = this.integerByteLength(info);
        return byteLength === 8
          ? this.readSignedInteger(offset + 1, byteLength, "integer")
          : this.readUnsignedInteger(offset + 1, byteLength, "integer");
      }
      case 0x20:
        return this.readReal(offset + 1, this.integerByteLength(info));
      case 0x30:
        return this.readDate(offset, info);
      case 0x40:
        return this.readData(offset, info);
      case 0x50:
        return this.readAsciiString(offset, info);
      case 0x60:
        return this.readUtf16String(offset, info);
      case 0x80:
        return this.readUnsignedInteger(
          offset + 1,
          info + 1,
          "uid",
        );
      case 0xa0:
        return this.readArray(offset, info, stack);
      case 0xd0:
        return this.readDictionary(offset, info, stack);
      default:
        throw new PlistParseError(`Unsupported binary plist marker: 0x${kind.toString(16)}.`);
    }
  }

  private parseSimple(info: number): PlistValue {
    switch (info) {
      case 0x0:
        return null;
      case 0x8:
        return false;
      case 0x9:
        return true;
      default:
        throw new PlistParseError("Unsupported binary plist simple value.");
    }
  }

  private readDate(offset: number, info: number): Date {
    if (info !== 0x3) {
      throw new PlistParseError("Binary plist date has an invalid size marker.");
    }

    this.assertRange(offset + 1, 8, "date");
    return new Date(appleEpochMs + this.view.getFloat64(offset + 1, false) * 1000);
  }

  private readData(offset: number, info: number): Uint8Array {
    const length = this.readLength(offset, info, "data");
    this.assertRange(length.payloadOffset, length.count, "data");
    return this.bytes.slice(length.payloadOffset, length.payloadOffset + length.count);
  }

  private readAsciiString(offset: number, info: number): string {
    const length = this.readLength(offset, info, "ASCII string");
    this.assertRange(length.payloadOffset, length.count, "ASCII string");

    let text = "";
    for (let index = 0; index < length.count; index += 1) {
      const charCode = this.bytes[length.payloadOffset + index];
      if (charCode > 0x7f) {
        throw new PlistParseError("Binary plist ASCII string contains non-ASCII data.");
      }
      text += String.fromCharCode(charCode);
    }

    return text;
  }

  private readUtf16String(offset: number, info: number): string {
    const length = this.readLength(offset, info, "UTF-16 string");
    const byteLength = length.count * 2;
    this.assertRange(length.payloadOffset, byteLength, "UTF-16 string");

    const chunks: number[] = [];
    for (let index = 0; index < byteLength; index += 2) {
      chunks.push(
        (this.bytes[length.payloadOffset + index] << 8) |
          this.bytes[length.payloadOffset + index + 1],
      );
    }

    return stringFromCodeUnits(chunks);
  }

  private readArray(offset: number, info: number, stack: Set<number>): PlistValue[] {
    const length = this.readLength(offset, info, "array");
    const refBytes = length.count * this.objectRefSize;
    this.assertRange(length.payloadOffset, refBytes, "array refs");

    const values: PlistValue[] = [];
    for (let index = 0; index < length.count; index += 1) {
      const ref = this.readUnsignedInteger(
        length.payloadOffset + index * this.objectRefSize,
        this.objectRefSize,
        "array ref",
      );
      values.push(this.parseObject(ref, stack));
    }

    return values;
  }

  private readDictionary(
    offset: number,
    info: number,
    stack: Set<number>,
  ): PlistDictionary {
    const length = this.readLength(offset, info, "dict");
    const refBytes = length.count * this.objectRefSize * 2;
    this.assertRange(length.payloadOffset, refBytes, "dict refs");

    const dict: Record<string, PlistValue> = {};

    for (let index = 0; index < length.count; index += 1) {
      const keyRef = this.readUnsignedInteger(
        length.payloadOffset + index * this.objectRefSize,
        this.objectRefSize,
        "dict key ref",
      );
      const valueRef = this.readUnsignedInteger(
        length.payloadOffset + (length.count + index) * this.objectRefSize,
        this.objectRefSize,
        "dict value ref",
      );
      const key = this.parseObject(keyRef, stack);

      if (typeof key !== "string") {
        throw new PlistParseError("Binary plist dictionary key is not a string.");
      }

      dict[key] = this.parseObject(valueRef, stack);
    }

    return dict;
  }

  private readLength(
    objectOffset: number,
    info: number,
    label: string,
  ): { count: number; payloadOffset: number } {
    if (info !== 0x0f) {
      return { count: info, payloadOffset: objectOffset + 1 };
    }

    const marker = this.readByte(objectOffset + 1, `${label} length marker`);
    if ((marker & 0xf0) !== 0x10) {
      throw new PlistParseError(`Binary plist ${label} length is not an integer.`);
    }

    const byteLength = this.integerByteLength(marker & 0x0f);
    const count = this.readUnsignedInteger(
      objectOffset + 2,
      byteLength,
      `${label} length`,
    );

    if (count > maxContainerLength) {
      throw new PlistParseError(`Binary plist ${label} length is too large.`);
    }

    return { count, payloadOffset: objectOffset + 2 + byteLength };
  }

  private integerByteLength(info: number): number {
    const byteLength = 2 ** info;

    if (byteLength < 1 || byteLength > 8) {
      throw new PlistParseError("Binary plist integer size is unsupported.");
    }

    return byteLength;
  }

  private readReal(offset: number, byteLength: number): number {
    this.assertRange(offset, byteLength, "real");

    if (byteLength === 4) {
      return this.view.getFloat32(offset, false);
    }

    if (byteLength === 8) {
      return this.view.getFloat64(offset, false);
    }

    throw new PlistParseError("Binary plist real size is unsupported.");
  }

  private readSignedInteger(offset: number, byteLength: number, label: string): number {
    this.assertRange(offset, byteLength, label);
    let value = 0n;

    for (let index = 0; index < byteLength; index += 1) {
      value = (value << 8n) | BigInt(this.bytes[offset + index]);
    }

    const signBit = 1n << BigInt(byteLength * 8 - 1);
    if ((value & signBit) !== 0n) {
      value -= 1n << BigInt(byteLength * 8);
    }

    return this.bigIntToSafeNumber(value, label);
  }

  private readUnsignedInteger(offset: number, byteLength: number, label: string): number {
    this.assertRange(offset, byteLength, label);
    let value = 0n;

    for (let index = 0; index < byteLength; index += 1) {
      value = (value << 8n) | BigInt(this.bytes[offset + index]);
    }

    return this.bigIntToSafeNumber(value, label);
  }

  private readTrailerByte(offset: number): number {
    this.assertRange(offset, 1, "trailer");
    return this.bytes[offset];
  }

  private readByte(offset: number, label: string): number {
    this.assertRange(offset, 1, label);
    return this.bytes[offset];
  }

  private bigIntToSafeNumber(value: bigint, label: string): number {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new PlistParseError(`Binary plist ${label} is outside the safe integer range.`);
    }

    return Number(value);
  }

  private assertRange(offset: number, byteLength: number, label: string): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(byteLength) ||
      offset < 0 ||
      byteLength < 0 ||
      offset + byteLength > this.bytes.byteLength
    ) {
      throw new PlistParseError(`Binary plist ${label} is out of bounds.`);
    }
  }
}
