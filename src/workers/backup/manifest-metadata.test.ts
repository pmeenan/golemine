import { describe, expect, it } from "vitest";

import { iosMiniEncryptedBackupCryptoVectors } from "../../../e2e/fixtures/ios-mini-backup.mjs";
import { parseMbFileMetadata } from "./manifest-db";

const archivedAttachmentMetadataBase64 =
  "YnBsaXN0MDDUIiMkJSYnIQZVJG51bGzWBwkLDQ8RCAoMDhAS0hQTFRbSFxgbGtIXGB4cpQECAwQFVFNpemUQRFRNb2RlEYGkXxAPUHJvdGVjdGlvbkNsYXNzEARcTGFzdE1vZGlmaWVkEmpFCX5dRW5jcnlwdGlvbktleYACViRjbGFzc4ADViRjbGFzc1dOUy5kYXRhTxAsBAAAAHCbwiVnnO6TNlqRXTA5xf+b3th3uLIxpvkCKkI2BHXvmu4Dp2HuDl+ABFgkY2xhc3Nlc1okY2xhc3NuYW1lWE5TT2JqZWN0Vk1CRmlsZaIaGV1OU011dGFibGVEYXRhVk5TRGF0YaMcHRlUcm9vdIAB0R8gWCR2ZXJzaW9uWSRhcmNoaXZlclQkdG9wWCRvYmplY3RzEgABhqBfEA9OU0tleWVkQXJjaGl2ZXIACAARABcAJAApAC4AMwA5AD4AQABFAEgAWgBcAGkAbgB8AH4AhQCHAI4AlgDFAMcA0ADbAOQA6wDuAPwBAwEHAQwBDgERARoBJAEpATIBNwAAAAAAAAIBAAAAAAAAACgAAAAAAAAAAAAAAAAAAAFJ";

describe("parseMbFileMetadata", () => {
  it("resolves a real NSKeyedArchiver MBFile EncryptionKey through NSMutableData NS.data", () => {
    const archivedMetadata = Uint8Array.from(
      Buffer.from(archivedAttachmentMetadataBase64, "base64"),
    );
    const expectedEncryptionKey = Uint8Array.from(
      Buffer.from(
        `04000000${iosMiniEncryptedBackupCryptoVectors.fileKeys.attachment.wrappedKeyHex}`,
        "hex",
      ),
    );

    expect(parseMbFileMetadata(archivedMetadata)).toEqual({
      encryptionKey: expectedEncryptionKey,
      lastModified: 1_782_909_310,
      mode: 0o100644,
      protectionClass: iosMiniEncryptedBackupCryptoVectors.protectionClass,
      size: 68,
    });
  });
});
