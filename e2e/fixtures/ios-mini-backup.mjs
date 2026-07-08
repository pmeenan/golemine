// Single source of truth for the synthetic ios-mini-backup fixture device.
// The fixture generator, the ios-backup unit tests, and the M1 Playwright
// spec all import these values so the synthetic backup cannot silently drift
// between suites. Everything here is synthetic — no real personal data.

export const iosMiniBackupUdid = "00008030-001C195E0A88802E";

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

export function plistDict(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
${body}
  </dict>
</plist>
`;
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

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
