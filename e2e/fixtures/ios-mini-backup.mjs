// Single source of truth for the synthetic ios-mini-backup fixture device and
// expected M2 ingest records. The fixture generator, ios-backup unit tests, and
// Playwright specs import these values so the synthetic backup cannot silently
// drift between suites. Everything here is synthetic: no real personal data.

export const iosMiniBackupUdid = "00008030-001C195E0A88802E";

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

export function iosMiniBackupStatusPlist() {
  return plistDict(`
          <key>SnapshotState</key>
          <string>finished</string>
  `);
}

export function iosMiniBackupInfoPlist() {
  return plistDict(`
          <key>Unique Identifier</key>
          <string>${escapeXml(iosMiniBackupDevice.udid)}</string>
          <key>Display Name</key>
          <string>${escapeXml(iosMiniBackupDevice.displayName)}</string>
          <key>Device Name</key>
          <string>${escapeXml(iosMiniBackupDevice.deviceName)}</string>
          <key>Product Type</key>
          <string>${escapeXml(iosMiniBackupDevice.productType)}</string>
          <key>Product Version</key>
          <string>${escapeXml(iosMiniBackupDevice.productVersion)}</string>
          <key>Serial Number</key>
          <string>${escapeXml(iosMiniBackupDevice.serialNumber)}</string>
          <key>Phone Number</key>
          <string>${escapeXml(iosMiniBackupDevice.phoneNumber)}</string>
          <key>Last Backup Date</key>
          <date>${escapeXml(iosMiniBackupDevice.lastBackupDate)}</date>
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
