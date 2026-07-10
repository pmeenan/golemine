// Single source of truth for the synthetic ios-mini-backup fixture device and
// expected M2 ingest records. The fixture generator, ios-backup unit tests, and
// Playwright specs import these values so the synthetic backup cannot silently
// drift between suites. Everything here is synthetic: no real personal data.

export const iosMiniBackupUdid = "00008030-001C195E0A88802E";
export const iosMiniEncryptedBackupUdid = "00008030-001C195E0A88805E";

const smsDbFileId = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";
const smsDbWalFileId = "cd47480f213dba9bc38ee792775d17e3f5a73a59";
const addressBookDbFileId = "31bb7ba8914766d4ba40d6dfb6113c8b614be442";
const addressBookDbWalFileId = "a9aaf31e300bbb71f1602c65e27a29a6c85f98f8";
const addressBookImagesDbFileId = "cd6702cea29fe89cf280a76794405adb17f9a0ee";
const attachmentFileId = "15c623b616f5e146bbc68d7cd0b35ec8ccea5383";
const attachmentRelativePath = "Library/SMS/Attachments/7b/42/ORE-MAP-0001/ore-map.png";
const appleEpochMs = Date.UTC(2001, 0, 1);

export const iosMiniBackupDevice = {
  udid: iosMiniBackupUdid,
  displayName: "Mina's iPhone backup",
  deviceName: "Mina's iPhone",
  productType: "iPhone15,2",
  productVersion: "18.5",
  serialNumber: "C39SYNTH0001",
  phoneNumber: "+15555550123",
  lastBackupDate: "2026-07-01T12:34:56Z",
};

export const iosMiniEncryptedBackupDevice = {
  ...iosMiniBackupDevice,
  udid: iosMiniEncryptedBackupUdid,
  displayName: "Mina's encrypted iPhone backup",
  deviceName: "Mina's encrypted iPhone",
  serialNumber: "C39SYNTHM5001",
};

export const iosMiniBackupExpectedMetadata = {
  id: "ios-mini-backup",
  provider: "ios-itunes",
  isEncrypted: false,
  backupDate: "2026-07-01T12:35:10Z",
  sourceFiles: {
    smsDb: {
      domain: "HomeDomain",
      relativePath: "Library/SMS/sms.db",
      fileID: smsDbFileId,
    },
    smsDbWal: {
      domain: "HomeDomain",
      relativePath: "Library/SMS/sms.db-wal",
      fileID: smsDbWalFileId,
    },
    addressBookDb: {
      domain: "HomeDomain",
      relativePath: "Library/AddressBook/AddressBook.sqlitedb",
      fileID: addressBookDbFileId,
    },
    addressBookDbWal: {
      domain: "HomeDomain",
      relativePath: "Library/AddressBook/AddressBook.sqlitedb-wal",
      fileID: addressBookDbWalFileId,
    },
    addressBookImagesDb: {
      domain: "HomeDomain",
      relativePath: "Library/AddressBook/AddressBookImages.sqlitedb",
      fileID: addressBookImagesDbFileId,
    },
    attachment: {
      domain: "MediaDomain",
      relativePath: attachmentRelativePath,
      backupFilename: `~/${attachmentRelativePath}`,
      fileID: attachmentFileId,
      guid: "GOLEMINE-ATTACHMENT-ORE-MAP-0001",
      transferName: "ore-map.png",
      mimeType: "image/png",
    },
  },
  counts: {
    sourceMessageRows: 6,
    normalizedMessages: 5,
    conversations: 2,
    contacts: 3,
    reactions: 1,
    attachments: 1,
    avatarThumbnails: 1,
    avatarWarnings: 1,
    walSidecars: 2,
  },
};

export const iosMiniEncryptedBackupPassword = "G0lemine-M5!";

// Independent, static vectors for M5 crypto tests. The fixture generator derives
// and wraps the keys with Node's crypto implementation, then refuses to write the
// fixture if any result differs from these values. Production tests can import the
// expected values without sharing generator code with the worker implementation.
export const iosMiniEncryptedBackupCryptoVectors = {
  protectionClass: 4,
  password: iosMiniEncryptedBackupPassword,
  keybag: {
    version: 3,
    type: 1,
    wrap: 2,
    uuidHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    hmckHex:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    saltHex: "f0e1d2c3b4a5968778695a4b3c2d1e0f00112233",
    iterations: 10_000,
    doubleProtectionWrapType: 1,
    // Production backups are commonly around 10,000,000. The generated fixture
    // deliberately uses 100,000 so default unit + browser runs remain quick; the
    // realistic slow vector below covers the production-sized count on demand.
    doubleProtectionIterations: 100_000,
    doubleProtectionSaltHex:
      "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f",
  },
  intermediateKeyHex:
    "099724effa8b71f6092d13af988f4ad652d8b7488d07ba36af659e0544daa603",
  passcodeKeyHex:
    "cf7d508ce0144ade4326c81f248e0ff07935168b19be13c338478eae39c1ca03",
  realisticKdf: {
    iterations: 10_000,
    doubleProtectionIterations: 10_000_000,
    intermediateKeyHex:
      "007597fc7488babff95073d9dff0695d23a654659644fe6f6673cbebe1e8cf51",
    passcodeKeyHex:
      "256bedd030ac871d7910bfd3550a4096e3845276e30f2daaebd3b93260a8e208",
  },
  secondaryClassKey: {
    uuidHex: "22222222222222222222222222222222",
    class: 2,
    wrap: 2,
    keyType: 0,
    keyHex:
      "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
    wrappedKeyHex:
      "33a6e22a045de0414c76d06f5a13da1210db54657d15b9d126a6e555768223f79b7e33d0ae0dff2a",
  },
  classKey: {
    uuidHex: "44444444444444444444444444444444",
    class: 4,
    wrap: 2,
    keyType: 0,
    keyHex:
      "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
    wrappedKeyHex:
      "ee282eb54ad2d894cc35a9d9757b6bc9979431d075a642b6ab55e661829a6be566656f241c746f35",
  },
  manifestKey: {
    keyHex:
      "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
    wrappedKeyHex:
      "8aacfb98579bd07c79487bb2b5d36a48b250bf6bab553ec166cdb65226a4de91fb3b147cb98728f4",
  },
  fileKeys: {
    smsDb: {
      keyHex:
        "505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f",
      wrappedKeyHex:
        "70625b4fa8313bf4902bb9dbd00b8766e4a58300c89bce51bff676047b8fd926d4244d096647e524",
    },
    smsDbWal: {
      keyHex:
        "707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f",
      wrappedKeyHex:
        "d261dc1c019b031eda2eb9450d99d8c698d51563d45cb43b2ac44d695494fe24f5f85b67cbf4edc1",
    },
    addressBookDb: {
      keyHex:
        "909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      wrappedKeyHex:
        "c0ab8495fc443f61436ca658a56a9c44c6b7acb79a92c161a1db3eef79d70453ad54b1d19f960d8e",
    },
    addressBookDbWal: {
      keyHex:
        "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf",
      wrappedKeyHex:
        "24d935d89bbffe44787a6a59f0a65e93a2f162c09a261c869912418aff809d1da3374d2f5b522062",
    },
    addressBookImagesDb: {
      keyHex:
        "d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef",
      wrappedKeyHex:
        "96e2a424d959265e11be65c372ca6220a1f430d866c895cd94aeb83497f30a6574f148281885322b",
    },
    attachment: {
      keyHex:
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      wrappedKeyHex:
        "709bc225679cee93365a915d3039c5ff9bded877b8b231a6f9022a42360475ef9aee03a761ee0e5f",
    },
  },
};

export const iosMiniEncryptedBackupExpectedMetadata = {
  ...iosMiniBackupExpectedMetadata,
  id: "ios-mini-encrypted-backup",
  isEncrypted: true,
  crypto: {
    protectionClass: iosMiniEncryptedBackupCryptoVectors.protectionClass,
    password: iosMiniEncryptedBackupPassword,
    manifestCipher: "AES-256-CBC with a zero IV and PKCS#7 padding",
    perFileCipher:
      "AES-256-CBC with a zero IV and PKCS#7 padding, truncated via MBFile.Size",
    keyWrap: "RFC 3394 AES-256-KW",
  },
};

export const iosMiniBackupExpectedContacts = [
  {
    rowId: 1,
    firstName: "Rowan",
    lastName: "Vale",
    displayName: "Rowan Vale",
    handles: [
      {
        kind: "phone",
        property: 3,
        value: "+15550102000",
        uncanonicalizedValue: "+1 (555) 010-2000",
      },
    ],
    hasThumbnail: true,
  },
  {
    rowId: 2,
    firstName: "Niko",
    lastName: "Quill",
    displayName: "Niko Quill",
    handles: [
      {
        kind: "email",
        property: 4,
        value: "niko@example.test",
        uncanonicalizedValue: "niko@example.test",
      },
    ],
    hasThumbnail: false,
  },
  {
    rowId: 3,
    firstName: "Avery",
    lastName: "Cipher",
    displayName: "Avery Cipher",
    handles: [
      {
        kind: "phone",
        property: 3,
        value: "+15550104000",
        uncanonicalizedValue: "+1 (555) 010-4000",
      },
    ],
    hasThumbnail: false,
    avatarWarning: "image-magic-not-found",
    storedInWal: true,
  },
];

export const iosMiniBackupExpectedConversations = [
  {
    rowId: 1,
    guid: "chat-golemine-direct-rowan",
    kind: "direct",
    chatIdentifier: "+15550102000",
    displayName: null,
    service: "iMessage",
    participantHandles: ["+15550102000"],
  },
  {
    rowId: 2,
    guid: "chat-golemine-field-notes",
    kind: "group",
    chatIdentifier: "chat-golemine-field-notes",
    displayName: "Field Notes",
    service: "iMessage",
    participantHandles: ["+15550102000", "niko@example.test", "+15550104000"],
  },
];

export const iosMiniBackupExpectedMessages = [
  {
    sourceRowId: 1,
    guid: "GOLEMINE-MSG-DIRECT-IN-0001",
    conversationGuid: "chat-golemine-direct-rowan",
    conversationKind: "direct",
    senderHandle: "+15550102000",
    senderContactName: "Rowan Vale",
    isFromMe: false,
    service: "iMessage",
    body: "Did you find the brass gear?",
    bodySource: "text",
    sentAtUtc: "2026-07-01T13:00:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T13:00:00.000Z"),
    deliveredAtUtc: null,
    readAtUtc: null,
    attachments: [],
  },
  {
    sourceRowId: 2,
    guid: "GOLEMINE-MSG-DIRECT-OUT-0002",
    conversationGuid: "chat-golemine-direct-rowan",
    conversationKind: "direct",
    senderHandle: "self",
    senderContactName: "Mina",
    isFromMe: true,
    service: "iMessage",
    body: "Packed it with the backup notes.",
    bodySource: "text",
    sentAtUtc: "2026-07-01T13:01:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T13:01:00.000Z"),
    deliveredAtUtc: "2026-07-01T13:01:06.000Z",
    deliveredRawAppleNanoseconds: appleNanoseconds("2026-07-01T13:01:06.000Z"),
    readAtUtc: "2026-07-01T13:02:00.000Z",
    readRawAppleNanoseconds: appleNanoseconds("2026-07-01T13:02:00.000Z"),
    attachments: [],
  },
  {
    sourceRowId: 3,
    guid: "GOLEMINE-MSG-GROUP-TYPED-0003",
    conversationGuid: "chat-golemine-field-notes",
    conversationKind: "group",
    senderHandle: "niko@example.test",
    senderContactName: "Niko Quill",
    isFromMe: false,
    service: "iMessage",
    body: "Typedstream body from Niko.",
    bodySource: "attributedBody",
    sentAtUtc: "2026-07-01T14:00:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T14:00:00.000Z"),
    deliveredAtUtc: null,
    readAtUtc: null,
    attachments: [],
  },
  {
    sourceRowId: 4,
    guid: "GOLEMINE-MSG-GROUP-ATTACH-0004",
    conversationGuid: "chat-golemine-field-notes",
    conversationKind: "group",
    senderHandle: "self",
    senderContactName: "Mina",
    isFromMe: true,
    service: "iMessage",
    body: "Attaching the synthetic ore map.",
    bodySource: "text",
    sentAtUtc: "2026-07-01T14:02:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T14:02:00.000Z"),
    deliveredAtUtc: null,
    readAtUtc: null,
    attachments: [iosMiniBackupExpectedMetadata.sourceFiles.attachment.guid],
  },
  {
    sourceRowId: 6,
    guid: "GOLEMINE-MSG-GROUP-WAL-0006",
    conversationGuid: "chat-golemine-field-notes",
    conversationKind: "group",
    senderHandle: "+15550104000",
    senderContactName: "Avery Cipher",
    isFromMe: false,
    service: "iMessage",
    body: "WAL-only message after the last checkpoint.",
    bodySource: "text",
    sentAtUtc: "2026-07-01T14:04:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T14:04:00.000Z"),
    deliveredAtUtc: null,
    readAtUtc: null,
    attachments: [],
    storedInWal: true,
  },
];

export const iosMiniBackupExpectedReactions = [
  {
    sourceRowId: 5,
    guid: "GOLEMINE-MSG-TAPBACK-0005",
    conversationGuid: "chat-golemine-field-notes",
    senderHandle: "+15550102000",
    senderContactName: "Rowan Vale",
    targetGuid: "GOLEMINE-MSG-GROUP-ATTACH-0004",
    associatedMessageGuid: "p:0/GOLEMINE-MSG-GROUP-ATTACH-0004",
    associatedMessageType: 2001,
    kind: "liked",
    sentAtUtc: "2026-07-01T14:03:00.000Z",
    rawAppleNanoseconds: appleNanoseconds("2026-07-01T14:03:00.000Z"),
  },
];

export const iosMiniBackupExpectedAvatarWarnings = [
  {
    recordId: 3,
    contactName: "Avery Cipher",
    reason: "image-magic-not-found",
    blobDescription: "ABThumbnailImage.data has no PNG or JPEG magic bytes",
  },
];

export function plistDict(body) {
  const normalizedBody = body.replace(/[ \t]+$/gmu, "").trimEnd();

  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
${normalizedBody}
  </dict>
</plist>
`;
}

export function iosMiniBackupManifestPlist() {
  return plistDict(`
          <key>IsEncrypted</key>
          <false/>
          <key>Version</key>
          <string>10.0</string>
          <key>Date</key>
          <date>${escapeXml(iosMiniBackupExpectedMetadata.backupDate)}</date>
  `);
}

export function iosMiniEncryptedBackupManifestPlist({
  backupKeyBagBase64,
  manifestKeyBase64,
}) {
  return plistDict(`
          <key>IsEncrypted</key>
          <true/>
          <key>Version</key>
          <string>10.0</string>
          <key>Date</key>
          <date>${escapeXml(iosMiniEncryptedBackupExpectedMetadata.backupDate)}</date>
          <key>BackupKeyBag</key>
          <data>${escapeXml(backupKeyBagBase64)}</data>
          <key>ManifestKey</key>
          <data>${escapeXml(manifestKeyBase64)}</data>
  `);
}

export function iosMiniBackupStatusPlist() {
  return plistDict(`
          <key>SnapshotState</key>
          <string>finished</string>
  `);
}

export function iosMiniBackupInfoPlist() {
  return iosBackupInfoPlist(iosMiniBackupDevice);
}

export function iosMiniEncryptedBackupInfoPlist() {
  return iosBackupInfoPlist(iosMiniEncryptedBackupDevice);
}

function iosBackupInfoPlist(device) {
  return plistDict(`
          <key>Unique Identifier</key>
          <string>${escapeXml(device.udid)}</string>
          <key>Display Name</key>
          <string>${escapeXml(device.displayName)}</string>
          <key>Device Name</key>
          <string>${escapeXml(device.deviceName)}</string>
          <key>Product Type</key>
          <string>${escapeXml(device.productType)}</string>
          <key>Product Version</key>
          <string>${escapeXml(device.productVersion)}</string>
          <key>Serial Number</key>
          <string>${escapeXml(device.serialNumber)}</string>
          <key>Phone Number</key>
          <string>${escapeXml(device.phoneNumber)}</string>
          <key>Last Backup Date</key>
          <date>${escapeXml(device.lastBackupDate)}</date>
  `);
}

function appleNanoseconds(iso) {
  const unixMs = Date.parse(iso);

  if (!Number.isFinite(unixMs)) {
    throw new Error(`Invalid fixture timestamp: ${iso}`);
  }

  return String(BigInt(unixMs - appleEpochMs) * 1_000_000n);
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
