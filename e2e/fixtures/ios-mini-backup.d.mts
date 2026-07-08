// Hand-written declaration for ios-mini-backup.mjs — TypeScript does not
// check a .d.mts against its .mjs implementation, so keep the two files in
// sync when adding or renaming exports.
export declare const iosMiniBackupUdid: string;

export declare const iosMiniBackupDevice: {
  udid: string;
  displayName: string;
  deviceName: string;
  productType: string;
  productVersion: string;
  serialNumber: string;
  phoneNumber: string;
  lastBackupDate: string;
};

export declare const iosMiniBackupExpectedMetadata: {
  id: string;
  provider: "ios-itunes";
  isEncrypted: false;
  backupDate: string;
  sourceFiles: {
    smsDb: IosMiniBackupExpectedSourceFile;
    smsDbWal: IosMiniBackupExpectedSourceFile;
    addressBookDb: IosMiniBackupExpectedSourceFile;
    addressBookDbWal: IosMiniBackupExpectedSourceFile;
    addressBookImagesDb: IosMiniBackupExpectedSourceFile;
    attachment: IosMiniBackupExpectedAttachmentSourceFile;
  };
  counts: {
    sourceMessageRows: number;
    normalizedMessages: number;
    conversations: number;
    contacts: number;
    reactions: number;
    attachments: number;
    avatarThumbnails: number;
    avatarWarnings: number;
    walSidecars: number;
  };
};

export interface IosMiniBackupExpectedSourceFile {
  domain: string;
  relativePath: string;
  fileID: string;
}

export interface IosMiniBackupExpectedAttachmentSourceFile
  extends IosMiniBackupExpectedSourceFile {
  backupFilename: string;
  guid: string;
  transferName: string;
  mimeType: string;
}

export declare const iosMiniBackupExpectedContacts: readonly {
  rowId: number;
  firstName: string;
  lastName: string;
  displayName: string;
  handles: readonly {
    kind: "phone" | "email";
    property: number;
    value: string;
    uncanonicalizedValue: string;
  }[];
  hasThumbnail: boolean;
  avatarWarning?: string;
  storedInWal?: boolean;
}[];

export declare const iosMiniBackupExpectedConversations: readonly {
  rowId: number;
  guid: string;
  kind: "direct" | "group";
  chatIdentifier: string;
  displayName: string | null;
  service: string;
  participantHandles: readonly string[];
}[];

export declare const iosMiniBackupExpectedMessages: readonly {
  sourceRowId: number;
  guid: string;
  conversationGuid: string;
  conversationKind: "direct" | "group";
  senderHandle: string;
  senderContactName: string;
  isFromMe: boolean;
  service: string;
  body: string;
  bodySource: "text" | "attributedBody";
  sentAtUtc: string;
  rawAppleNanoseconds: string;
  deliveredAtUtc: string | null;
  deliveredRawAppleNanoseconds?: string;
  readAtUtc: string | null;
  readRawAppleNanoseconds?: string;
  attachments: readonly string[];
  storedInWal?: boolean;
}[];

export declare const iosMiniBackupExpectedReactions: readonly {
  sourceRowId: number;
  guid: string;
  conversationGuid: string;
  senderHandle: string;
  senderContactName: string;
  targetGuid: string;
  associatedMessageGuid: string;
  associatedMessageType: number;
  kind: "liked";
  sentAtUtc: string;
  rawAppleNanoseconds: string;
}[];

export declare const iosMiniBackupExpectedAvatarWarnings: readonly {
  recordId: number;
  contactName: string;
  reason: string;
  blobDescription: string;
}[];

export declare function plistDict(body: string): string;

export declare function iosMiniBackupManifestPlist(): string;

export declare function iosMiniBackupStatusPlist(): string;

export declare function iosMiniBackupInfoPlist(): string;
