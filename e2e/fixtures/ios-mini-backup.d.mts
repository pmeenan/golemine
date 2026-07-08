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

export declare function plistDict(body: string): string;

export declare function iosMiniBackupInfoPlist(): string;
