import { BackupCryptoError } from "./errors";

const tlvHeaderBytes = 8;
const maxKeybagBytes = 4 * 1024 * 1024;
const maxTlvPayloadBytes = 1024 * 1024;
const maxTlvEntries = 4096;
const uuidBytes = 16;
const wrappedAes256KeyBytes = 40;

interface KeybagTlvEntry {
  readonly tag: string;
  readonly value: Uint8Array;
}

export interface KeybagClassKey {
  readonly uuid: Uint8Array;
  readonly protectionClass: number;
  readonly wrapFlags: number;
  readonly keyType: number;
  readonly wrappedKey?: Uint8Array;
}

export interface ParsedKeybag {
  readonly version: number;
  readonly type: number;
  readonly uuid: Uint8Array;
  readonly wrapFlags?: number;
  readonly salt: Uint8Array;
  readonly iterations: number;
  readonly doubleProtectionSalt?: Uint8Array;
  readonly doubleProtectionIterations?: number;
  readonly classKeys: readonly KeybagClassKey[];
}

/**
 * Parses an iTunes/Finder backup keybag. All returned byte arrays are detached
 * copies so callers never retain a hostile, potentially oversized input blob.
 */
export function parseKeybag(bytes: Uint8Array): ParsedKeybag {
  const entries = parseTlvEntries(bytes);
  const headerEntries: KeybagTlvEntry[] = [];
  const classSegments: KeybagTlvEntry[][] = [];
  let uuidSegment: KeybagTlvEntry[] | undefined;

  for (const entry of entries) {
    if (entry.tag === "UUID") {
      finishUuidSegment(uuidSegment, headerEntries, classSegments);
      uuidSegment = [entry];
    } else if (uuidSegment === undefined) {
      headerEntries.push(entry);
    } else {
      uuidSegment.push(entry);
    }
  }
  finishUuidSegment(uuidSegment, headerEntries, classSegments);

  const type = readRequiredUint32(headerEntries, "TYPE", "keybag type");
  if (type !== 1) {
    throw new BackupCryptoError(
      "unsupported-keybag",
      `Unsupported keybag type ${String(type)}.`,
    );
  }

  const doubleProtectionSalt = readOptionalBytes(
    headerEntries,
    "DPSL",
    "double-protection salt",
  );
  const doubleProtectionIterations = readOptionalUint32(
    headerEntries,
    "DPIC",
    "double-protection iteration count",
  );
  if (
    (doubleProtectionSalt === undefined) !==
    (doubleProtectionIterations === undefined)
  ) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Keybag double-protection parameters are incomplete.",
    );
  }

  const classKeys = classSegments.map(parseClassKeySegment);
  if (classKeys.length === 0) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Keybag does not contain any class keys.",
    );
  }

  const seenClasses = new Set<number>();
  for (const classKey of classKeys) {
    if (seenClasses.has(classKey.protectionClass)) {
      throw new BackupCryptoError(
        "malformed-keybag",
        `Keybag repeats protection class ${String(classKey.protectionClass)}.`,
      );
    }
    seenClasses.add(classKey.protectionClass);
  }

  return {
    version: readRequiredUint32(headerEntries, "VERS", "keybag version"),
    type,
    uuid: readRequiredFixedBytes(
      headerEntries,
      "UUID",
      uuidBytes,
      "keybag UUID",
    ),
    wrapFlags: readOptionalUint32(headerEntries, "WRAP", "keybag wrap flags"),
    salt: readRequiredNonEmptyBytes(headerEntries, "SALT", "PBKDF2 salt"),
    iterations: readRequiredPositiveUint32(
      headerEntries,
      "ITER",
      "PBKDF2 iteration count",
    ),
    doubleProtectionSalt:
      doubleProtectionSalt === undefined
        ? undefined
        : requireNonEmptyBytes(doubleProtectionSalt, "double-protection salt"),
    doubleProtectionIterations:
      doubleProtectionIterations === undefined
        ? undefined
        : requirePositiveInteger(
            doubleProtectionIterations,
            "double-protection iteration count",
          ),
    classKeys,
  };
}

function parseTlvEntries(bytes: Uint8Array): KeybagTlvEntry[] {
  if (bytes.byteLength === 0 || bytes.byteLength > maxKeybagBytes) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Keybag size is empty or exceeds the supported bound.",
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: KeybagTlvEntry[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (entries.length >= maxTlvEntries) {
      throw new BackupCryptoError(
        "malformed-keybag",
        "Keybag contains too many TLV entries.",
      );
    }
    if (bytes.byteLength - offset < tlvHeaderBytes) {
      throw new BackupCryptoError(
        "malformed-keybag",
        "Keybag ends inside a TLV header.",
      );
    }

    let tag = "";
    for (let index = 0; index < 4; index += 1) {
      const code = bytes[offset + index];
      if (code < 0x20 || code > 0x7e) {
        throw new BackupCryptoError(
          "malformed-keybag",
          "Keybag contains a non-printable TLV tag.",
        );
      }
      tag += String.fromCharCode(code);
    }

    const payloadLength = view.getUint32(offset + 4, false);
    if (payloadLength > maxTlvPayloadBytes) {
      throw new BackupCryptoError(
        "malformed-keybag",
        `Keybag TLV ${tag} exceeds the payload bound.`,
      );
    }

    const payloadOffset = offset + tlvHeaderBytes;
    const payloadEnd = payloadOffset + payloadLength;
    if (payloadEnd > bytes.byteLength) {
      throw new BackupCryptoError(
        "malformed-keybag",
        `Keybag TLV ${tag} extends past the input.`,
      );
    }

    entries.push({ tag, value: bytes.slice(payloadOffset, payloadEnd) });
    offset = payloadEnd;
  }

  return entries;
}

function finishUuidSegment(
  segment: KeybagTlvEntry[] | undefined,
  headerEntries: KeybagTlvEntry[],
  classSegments: KeybagTlvEntry[][],
): void {
  if (segment === undefined) {
    return;
  }

  if (segment.some((entry) => entry.tag === "CLAS")) {
    classSegments.push(segment);
  } else {
    headerEntries.push(...segment);
  }
}

function parseClassKeySegment(entries: KeybagTlvEntry[]): KeybagClassKey {
  const wrapFlags = readRequiredUint32(entries, "WRAP", "class-key wrap flags");
  const wrappedKey = readOptionalBytes(entries, "WPKY", "wrapped class key");
  if ((wrapFlags & 2) !== 0 && wrappedKey === undefined) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Passcode-wrapped class key is missing WPKY.",
    );
  }
  if (
    wrappedKey !== undefined &&
    wrappedKey.byteLength !== wrappedAes256KeyBytes
  ) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Wrapped class key must contain a 40-byte AES-KW value.",
    );
  }

  return {
    uuid: readRequiredFixedBytes(
      entries,
      "UUID",
      uuidBytes,
      "class-key UUID",
    ),
    protectionClass: readRequiredPositiveUint32(
      entries,
      "CLAS",
      "protection class",
    ),
    wrapFlags,
    keyType: readRequiredUint32(entries, "KTYP", "class-key type"),
    wrappedKey,
  };
}

function findSingleEntry(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
  required: boolean,
): KeybagTlvEntry | undefined {
  const matches = entries.filter((entry) => entry.tag === tag);
  if (matches.length > 1) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag repeats ${label}.`,
    );
  }
  if (required && matches.length === 0) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag is missing ${label}.`,
    );
  }
  return matches[0];
}

function readRequiredUint32(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
): number {
  const entry = findSingleEntry(entries, tag, label, true);
  if (entry?.value.byteLength !== 4) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag ${label} must be a 4-byte integer.`,
    );
  }
  return new DataView(
    entry.value.buffer,
    entry.value.byteOffset,
    entry.value.byteLength,
  ).getUint32(0, false);
}

function readRequiredPositiveUint32(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
): number {
  return requirePositiveInteger(readRequiredUint32(entries, tag, label), label);
}

function readOptionalUint32(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
): number | undefined {
  const entry = findSingleEntry(entries, tag, label, false);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.value.byteLength !== 4) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag ${label} must be a 4-byte integer.`,
    );
  }
  return new DataView(
    entry.value.buffer,
    entry.value.byteOffset,
    entry.value.byteLength,
  ).getUint32(0, false);
}

function readRequiredFixedBytes(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  byteLength: number,
  label: string,
): Uint8Array {
  const value = readOptionalBytes(entries, tag, label);
  if (value === undefined) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag is missing ${label}.`,
    );
  }
  if (value.byteLength !== byteLength) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag ${label} must be ${String(byteLength)} bytes.`,
    );
  }
  return value;
}

function readRequiredNonEmptyBytes(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
): Uint8Array {
  const value = readOptionalBytes(entries, tag, label);
  if (value === undefined) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag is missing ${label}.`,
    );
  }
  return requireNonEmptyBytes(value, label);
}

function readOptionalBytes(
  entries: readonly KeybagTlvEntry[],
  tag: string,
  label: string,
): Uint8Array | undefined {
  return findSingleEntry(entries, tag, label, false)?.value;
}

function requireNonEmptyBytes(value: Uint8Array, label: string): Uint8Array {
  if (value.byteLength === 0) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag ${label} must not be empty.`,
    );
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `Keybag ${label} must be a positive integer.`,
    );
  }
  return value;
}
